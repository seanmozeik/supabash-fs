begin;

-- Existing revisions retain their original manifests. New revisions share
-- unchanged entries through half-open sequence intervals. Sequence order is
-- allocated under the workspace lock and does not depend on wall-clock time.
lock table supabash.workspaces in access exclusive mode;
-- Build the caller's allowed workspace set once per statement, instead of
-- executing an ownership lookup for every file and body row.
-- PL/pgSQL retains the helper query plans across calls on each connection.
create index workspaces_owner_id_idx on supabash.workspaces(owner_id, id);
create function supabash.allowed_workspaces()
returns setof uuid
language plpgsql stable security invoker
set search_path = pg_catalog, supabash
as $function$
begin
  return query
  select w.id from supabash.workspaces w
  where ((select supabash.request_role()) = 'authenticated'
      and w.owner_id = (select supabash.request_user_id()))
    or ((select supabash.request_role()) = 'service_role'
      and w.owner_id = (select supabash.delegated_subject()));
end
$function$;
revoke all on function supabash.allowed_workspaces() from public, anon, authenticated, service_role;
grant execute on function supabash.allowed_workspaces() to supabash_api;

create sequence supabash.storage_sequence;
alter table supabash.workspace_revisions add column storage_sequence bigint;
alter table supabash.workspace_revisions alter column storage_sequence
  set default nextval('supabash.storage_sequence');
create index workspace_revision_storage_sequence_idx
  on supabash.workspace_revisions(workspace_id, storage_sequence);

create table supabash.document_versions (
  workspace_id uuid not null references supabash.workspaces(id) on delete cascade,
  path text not null check (supabash.is_document_path(path)),
  valid_from bigint not null,
  valid_until bigint check (valid_until > valid_from),
  body_hash text not null,
  byte_size bigint not null check (byte_size >= 0),
  metadata jsonb not null check (supabash.is_document_metadata(metadata)),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  content_byte_size bigint not null check (content_byte_size >= 0),
  primary key(workspace_id, path, valid_from),
  foreign key(workspace_id, body_hash, byte_size)
    references supabash.bodies(workspace_id, body_hash, byte_size)
);
create unique index document_versions_current_idx
  on supabash.document_versions(workspace_id, path) where valid_until is null;
create index document_versions_body_idx on supabash.document_versions(workspace_id, body_hash);
insert into supabash.document_versions
  (workspace_id, path, valid_from, body_hash, byte_size, metadata, content_hash, content_byte_size)
select workspace_id, path, 0, body_hash, byte_size, metadata, content_hash, content_byte_size
from supabash.current_documents;
alter table supabash.document_versions enable row level security;
alter table supabash.document_versions force row level security;
create policy document_version_owner on supabash.document_versions to supabash_api
  using (supabash.owns_workspace(workspace_id))
  with check (supabash.owns_workspace(workspace_id));
grant select, insert, update, delete on supabash.document_versions to supabash_api;
grant usage on sequence supabash.storage_sequence to supabash_api;

do $policies$
declare
  target record;
begin
  for target in select * from (values
    ('workspace_revisions', 'revision_owner'),
    ('bodies', 'body_owner'),
    ('current_documents', 'current_document_owner'),
    ('revision_entries', 'revision_entry_owner'),
    ('revision_changes', 'revision_change_owner'),
    ('checkpoints', 'checkpoint_owner'),
    ('document_versions', 'document_version_owner')
  ) as policies(table_name, policy_name)
  loop
    execute format('alter policy %I on supabash.%I using
      (workspace_id in (select supabash.allowed_workspaces())) with check
      (workspace_id in (select supabash.allowed_workspaces()))',
      target.policy_name, target.table_name);
  end loop;
end
$policies$;

create function supabash.entries_at(p_workspace_id uuid, p_revision_id uuid, p_path text default null)
returns table(workspace_id uuid, revision_id uuid, path text, body_hash text,
  byte_size bigint, metadata jsonb, content_hash text, content_byte_size bigint)
language plpgsql stable security invoker
set search_path = pg_catalog, supabash
as $function$
begin
  return query
  select e.workspace_id, e.revision_id, e.path, e.body_hash,
    e.byte_size, e.metadata, e.content_hash, e.content_byte_size
  from supabash.workspace_revisions r
  join supabash.revision_entries e using(workspace_id, revision_id)
  where r.workspace_id = p_workspace_id and r.revision_id = p_revision_id
    and r.storage_sequence is null
    and (p_path is null or e.path = p_path)
  union all
  select e.workspace_id, r.revision_id, e.path, e.body_hash,
    e.byte_size, e.metadata, e.content_hash, e.content_byte_size
  from supabash.workspace_revisions r
  join supabash.document_versions e on e.workspace_id = r.workspace_id
    and e.valid_from <= r.storage_sequence
    and (e.valid_until is null or e.valid_until > r.storage_sequence)
  where r.workspace_id = p_workspace_id and r.revision_id = p_revision_id
    and (p_path is null or e.path = p_path);
end
$function$;
revoke all on function supabash.entries_at(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function supabash.entries_at(uuid, uuid, text) to supabash_api;


create or replace function supabash.snapshot_at(p_workspace_id uuid, p_revision_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, supabash
as $function$
  select jsonb_build_object(
    'workspaceId', r.workspace_id,
    'headRevision', r.revision_id,
    'transactionId', r.transaction_id,
    'committedAt', r.committed_at,
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'path', e.path,
        'body', b.body,
        'bodyHash', e.body_hash,
        'bodyByteSize', e.byte_size,
        'metadata', e.metadata,
        'contentHash', e.content_hash,
        'byteSize', e.content_byte_size
      ) order by e.path)
      from supabash.entries_at(p_workspace_id, p_revision_id) e
      join supabash.bodies b
        on b.workspace_id = e.workspace_id and b.body_hash = e.body_hash
      where e.workspace_id = r.workspace_id and e.revision_id = r.revision_id
    ), '[]'::jsonb)
  )
  from supabash.workspace_revisions r
  where r.workspace_id = p_workspace_id and r.revision_id = p_revision_id;
$function$;

create or replace function public.supabash_load_workspace(
  p_workspace_id uuid,
  p_delegated_grant text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, supabash
set row_security = on
as $function$
declare
  v_result jsonb;
begin
  perform * from supabash.authorize_workspace(p_workspace_id, array['read'], p_delegated_grant);

  select jsonb_build_object(
    'workspaceId', w.id,
    'headRevision', w.head_revision,
    'transactionId', r.transaction_id,
    'committedAt', r.committed_at,
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'path', e.path,
        'body', b.body,
        'bodyHash', e.body_hash,
        'bodyByteSize', e.byte_size,
        'metadata', e.metadata,
        'contentHash', e.content_hash,
        'byteSize', e.content_byte_size
      ) order by e.path)
      from supabash.current_documents e
      join supabash.bodies b
        on b.workspace_id = e.workspace_id and b.body_hash = e.body_hash
      where e.workspace_id = w.id
    ), '[]'::jsonb)
  ) into v_result
  from supabash.workspaces w
  left join supabash.workspace_revisions r
    on r.workspace_id = w.id and r.revision_id = w.head_revision
  where w.id = p_workspace_id;

  if v_result is null then
    raise exception using errcode = '42501', message = 'SUPABASH_WORKSPACE_DENIED';
  end if;
  return jsonb_strip_nulls(v_result);
end
$function$;

create or replace function public.supabash_load_manifest(
  p_workspace_id uuid,
  p_delegated_grant text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, supabash
set row_security = on
as $function$
declare
  v_result jsonb;
begin
  perform * from supabash.authorize_workspace(p_workspace_id, array['read'], p_delegated_grant);
  select jsonb_build_object(
    'workspaceId', w.id,
    'headRevision', w.head_revision,
    'transactionId', r.transaction_id,
    'committedAt', r.committed_at,
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'path', e.path, 'bodyHash', e.body_hash, 'bodyByteSize', e.byte_size,
        'metadata', e.metadata, 'contentHash', e.content_hash, 'byteSize', e.content_byte_size
      ) order by e.path)
      from supabash.current_documents e
      where e.workspace_id = w.id
    ), '[]'::jsonb)
  ) into v_result
  from supabash.workspaces w
  left join supabash.workspace_revisions r
    on r.workspace_id = w.id and r.revision_id = w.head_revision
  where w.id = p_workspace_id;
  if v_result is null then
    raise exception using errcode = '42501', message = 'SUPABASH_WORKSPACE_DENIED';
  end if;
  return v_result;
end
$function$;

create or replace function public.supabash_load_document(
  p_workspace_id uuid,
  p_revision_id uuid,
  p_path text,
  p_delegated_grant text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, supabash
set row_security = on
as $function$
declare
  v_result jsonb;
begin
  perform * from supabash.authorize_workspace(p_workspace_id, array['read'], p_delegated_grant);
  if p_revision_id is distinct from (
    select head_revision from supabash.workspaces where id = p_workspace_id
  ) then
    perform * from supabash.authorize_workspace(p_workspace_id, array['history'], p_delegated_grant);
  end if;
  select jsonb_build_object(
    'path', e.path, 'body', b.body, 'bodyHash', e.body_hash, 'bodyByteSize', e.byte_size,
    'metadata', e.metadata, 'contentHash', e.content_hash, 'byteSize', e.content_byte_size
  ) into v_result
  from supabash.entries_at(p_workspace_id, p_revision_id, p_path) e
  join supabash.bodies b on b.workspace_id = e.workspace_id and b.body_hash = e.body_hash
  where e.workspace_id = p_workspace_id and e.revision_id = p_revision_id and e.path = p_path;
  if v_result is null then
    raise exception using errcode = '22023', message = 'SUPABASH_REVISION_NOT_FOUND';
  end if;
  return v_result;
end
$function$;

-- A statement-local array keeps decoded bodies out of temporary tables and
-- avoids decoding them again for each destination table.
create type supabash.prepared_upsert as (
  path text, body text, body_hash text, byte_size bigint, metadata jsonb,
  content_hash text, content_byte_size bigint, ordinal integer, receipt jsonb
);

create function supabash.apply_upsert_batch(
  p_workspace_id uuid, p_revision_id uuid, p_sequence bigint,
  p_changes jsonb, p_receipt_changes jsonb
)
returns void
language plpgsql security invoker
set search_path = pg_catalog, supabash
as $function$
declare
  v_documents supabash.prepared_upsert[];
  v_receipts jsonb;
begin
  select array_agg(row(
    change.value ->> 'path', d.body, d.body_hash, d.body_byte_size,
    d.metadata, d.content_hash, d.content_byte_size, change.ordinality::integer,
    jsonb_strip_nulls(jsonb_build_object(
      'kind', 'upsert', 'entryKind', 'file', 'path', change.value ->> 'path',
      'beforeHash', old.content_hash, 'beforeSize', old.content_byte_size,
      'afterHash', d.content_hash, 'afterSize', d.content_byte_size,
      'contentHash', d.content_hash
    ))
  )::supabash.prepared_upsert order by change.ordinality)
  into v_documents
  from jsonb_array_elements(p_changes) with ordinality as change(value, ordinality)
  cross join lateral supabash.decode_stored_document(change.value) d
  left join supabash.current_documents old
    on old.workspace_id = p_workspace_id and old.path = change.value ->> 'path';

  select jsonb_agg(d.receipt order by d.ordinal) into v_receipts
  from unnest(v_documents) d;
  if v_receipts is distinct from p_receipt_changes then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CHANGES';
  end if;

  insert into supabash.bodies(workspace_id, body_hash, body, byte_size)
  select distinct on (d.body_hash) p_workspace_id, d.body_hash, d.body, d.byte_size
  from unnest(v_documents) d order by d.body_hash
  on conflict (workspace_id, body_hash) do nothing;
  if exists (
    select 1 from unnest(v_documents) d
    join supabash.bodies b on b.workspace_id = p_workspace_id and b.body_hash = d.body_hash
    where b.body <> d.body or b.byte_size <> d.byte_size
  ) then
    raise exception using errcode = 'XX001', message = 'SUPABASH_BODY_HASH_COLLISION';
  end if;

  insert into supabash.current_documents
    (workspace_id, path, body_hash, byte_size, metadata, content_hash, content_byte_size)
  select p_workspace_id, d.path, d.body_hash, d.byte_size, d.metadata,
    d.content_hash, d.content_byte_size from unnest(v_documents) d
  on conflict (workspace_id, path) do update set
    body_hash = excluded.body_hash, byte_size = excluded.byte_size,
    metadata = excluded.metadata, content_hash = excluded.content_hash,
    content_byte_size = excluded.content_byte_size;

  update supabash.document_versions e set valid_until = p_sequence
  where e.workspace_id = p_workspace_id and e.valid_until is null
    and e.path in (select d.path from unnest(v_documents) d);
  insert into supabash.document_versions
    (workspace_id, path, valid_from, body_hash, byte_size, metadata, content_hash, content_byte_size)
  select p_workspace_id, d.path, p_sequence, d.body_hash, d.byte_size,
    d.metadata, d.content_hash, d.content_byte_size from unnest(v_documents) d;
  insert into supabash.revision_changes(workspace_id, revision_id, ordinal, change)
  select p_workspace_id, p_revision_id, d.ordinal, d.receipt from unnest(v_documents) d;
end
$function$;
revoke all on function supabash.apply_upsert_batch(uuid, uuid, bigint, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function supabash.apply_upsert_batch(uuid, uuid, bigint, jsonb, jsonb) to supabash_api;

create or replace function public.supabash_commit(
  p_workspace_id uuid,
  p_base_revision uuid,
  p_changes jsonb,
  p_receipt_changes jsonb,
  p_actor text,
  p_correlation_id text,
  p_transaction_id uuid,
  p_fingerprint text,
  p_idempotency_key text default null,
  p_cause text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_source_revision uuid default null,
  p_delegated_grant text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, supabash, extensions
set row_security = on
as $function$
declare
  v_auth record;
  v_head uuid;
  v_revision uuid := gen_random_uuid();
  v_committed_at timestamptz := clock_timestamp();
  v_request_hash text;
  v_existing supabash.workspace_revisions;
  v_change jsonb;
  v_kind text;
  v_path text;
  v_from text;
  v_body text;
  v_hash text;
  v_size bigint;
  v_metadata jsonb;
  v_content text;
  v_content_hash text;
  v_content_size bigint;
  v_before_hash text;
  v_before_size bigint;
  v_source_hash text;
  v_source_size bigint;
  v_source_metadata jsonb;
  v_source_content_hash text;
  v_source_content_size bigint;
  v_receipt_change jsonb;
  v_ordinal integer := 0;
  v_limit integer;
  v_sequence bigint;
begin
  select * into v_auth
  from supabash.authorize_workspace(p_workspace_id, array['commit'], p_delegated_grant);

  if p_changes is null or jsonb_typeof(p_changes) <> 'array'
    or p_receipt_changes is null or jsonb_typeof(p_receipt_changes) <> 'array'
  then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CHANGES';
  end if;
  select max_changes_per_commit into v_limit from supabash.settings where singleton;
  if v_limit is not null and jsonb_array_length(p_changes) > v_limit then
    raise exception using errcode = '54000', message = 'SUPABASH_QUOTA_CHANGE_LIMIT';
  end if;
  if p_transaction_id is null
    or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$'
    or p_actor is null or p_actor = '' or octet_length(p_actor) > 1024
    or p_correlation_id is null or p_correlation_id = '' or octet_length(p_correlation_id) > 1024
    or p_cause is not null and octet_length(p_cause) > 4096
    or p_idempotency_key is not null and (p_idempotency_key = '' or octet_length(p_idempotency_key) > 1024)
    or p_metadata is null or jsonb_typeof(p_metadata) <> 'object'
  then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_COMMIT_CONTEXT';
  end if;

  for v_change in select value from jsonb_array_elements(p_changes)
  loop
    if jsonb_typeof(v_change) <> 'object' then
      raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CHANGES';
    end if;
    v_kind := v_change ->> 'kind';
    v_path := v_change ->> 'path';
    if v_kind not in ('upsert', 'delete', 'move') then
      raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CHANGE_KIND';
    end if;
    if not coalesce(supabash.is_document_path(v_path), false) then
      if v_path = any(array['/bin', '/dev', '/proc', '/tmp', '/usr'])
        or v_path like any(array['/bin/%', '/dev/%', '/proc/%', '/tmp/%', '/usr/%'])
      then
        raise exception using errcode = '0A000', message = 'SUPABASH_UNSUPPORTED_CONTENT';
      end if;
      raise exception using errcode = '22023', message = 'SUPABASH_INVALID_PATH';
    end if;
    -- Upserts are decoded once in the mutation loop. Any validation error
    -- aborts the entire SQL transaction, including prior mutations.
    if v_kind = 'move' then
      v_from := v_change ->> 'from';
      if not coalesce(supabash.is_document_path(v_from), false) or v_from = v_path then
        raise exception using errcode = '22023', message = 'SUPABASH_INVALID_PATH';
      end if;
      if (v_change ? 'body') or (v_change ? 'bodyByteSize') or (v_change ? 'bodyHash')
        or (v_change ? 'byteSize') or (v_change ? 'contentHash') or (v_change ? 'metadata')
      then
        perform * from supabash.decode_stored_document(v_change);
      end if;
    end if;
  end loop;

  perform pg_advisory_xact_lock(hashtextextended('supabash:' || p_workspace_id::text, 0));
  select w.head_revision into v_head from supabash.workspaces w where w.id = p_workspace_id;
  if not found then
    raise exception using errcode = '42501', message = 'SUPABASH_WORKSPACE_DENIED';
  end if;

  if v_auth.delegated then
    p_actor := 'delegated:' || v_auth.actor_subject;
    p_correlation_id := v_auth.correlation_id;
  end if;

  v_request_hash := supabash.sha256_text(jsonb_build_object(
    'workspaceId', p_workspace_id,
    'baseRevision', p_base_revision,
    'changes', p_changes,
    'receiptChanges', p_receipt_changes,
    'actor', p_actor,
    'correlationId', p_correlation_id,
    'idempotencyKey', p_idempotency_key,
    'cause', p_cause,
    'metadata', p_metadata,
    'sourceRevision', p_source_revision,
    'fingerprint', p_fingerprint
  )::text);

  select r.* into v_existing from supabash.workspace_revisions r
  where r.transaction_id = p_transaction_id;
  if found then
    if v_existing.workspace_id <> p_workspace_id or v_existing.request_hash <> v_request_hash then
      raise exception using errcode = '23505', message = 'SUPABASH_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object('receipt', supabash.receipt(p_workspace_id, v_existing.revision_id), 'replayed', true);
  end if;

  if p_idempotency_key is not null then
    select r.* into v_existing from supabash.workspace_revisions r
    where r.workspace_id = p_workspace_id and r.idempotency_key = p_idempotency_key;
    if found then
      if v_existing.request_hash <> v_request_hash then
        raise exception using errcode = '23505', message = 'SUPABASH_IDEMPOTENCY_CONFLICT';
      end if;
      return jsonb_build_object('receipt', supabash.receipt(p_workspace_id, v_existing.revision_id), 'replayed', true);
    end if;
  end if;

  if v_head is distinct from p_base_revision then
    raise exception using
      errcode = 'PT409',
      message = 'SUPABASH_COMMIT_CONFLICT',
      detail = jsonb_build_object('expectedRevision', p_base_revision, 'actualRevision', v_head)::text;
  end if;
  if p_source_revision is not null and not exists (
    select 1 from supabash.workspace_revisions r
    where r.workspace_id = p_workspace_id and r.revision_id = p_source_revision
  ) then
    raise exception using errcode = '22023', message = 'SUPABASH_REVISION_NOT_FOUND';
  end if;

  insert into supabash.workspace_revisions (
    workspace_id, revision_id, parent_revision, transaction_id, actor, cause,
    correlation_id, cursor, idempotency_key, fingerprint, request_hash, metadata,
    source_revision, committed_at
  ) values (
    p_workspace_id, v_revision, v_head, p_transaction_id, p_actor, p_cause,
    p_correlation_id, p_transaction_id::text, p_idempotency_key, p_fingerprint,
    v_request_hash, p_metadata, p_source_revision, v_committed_at
  );

  select storage_sequence into v_sequence from supabash.workspace_revisions
  where workspace_id = p_workspace_id and revision_id = v_revision;

  if jsonb_array_length(p_changes) >= 16
    and not exists (select 1 from jsonb_array_elements(p_changes) c where c ->> 'kind' is distinct from 'upsert')
    and (select count(distinct c ->> 'path') from jsonb_array_elements(p_changes) c) = jsonb_array_length(p_changes)
  then
    perform supabash.apply_upsert_batch(p_workspace_id, v_revision, v_sequence, p_changes, p_receipt_changes);
    update supabash.workspaces set head_revision = v_revision, updated_at = v_committed_at
    where id = p_workspace_id;
    return jsonb_build_object('receipt', supabash.receipt(p_workspace_id, v_revision), 'replayed', false);
  end if;

  for v_change in select value from jsonb_array_elements(p_changes)
  loop
    v_ordinal := v_ordinal + 1;
    v_kind := v_change ->> 'kind';
    v_path := v_change ->> 'path';
    v_before_hash := null;
    v_before_size := null;
    select e.content_hash, e.content_byte_size into v_before_hash, v_before_size
    from supabash.current_documents e
    where e.workspace_id = p_workspace_id and e.path = v_path;

    if v_kind = 'upsert' then
      select
        d.body, d.body_hash, d.body_byte_size, d.metadata,
        d.content, d.content_hash, d.content_byte_size
      into
        v_body, v_hash, v_size, v_metadata,
        v_content, v_content_hash, v_content_size
      from supabash.decode_stored_document(v_change) d;
      insert into supabash.bodies (workspace_id, body_hash, body, byte_size)
      values (p_workspace_id, v_hash, v_body, v_size)
      on conflict (workspace_id, body_hash) do nothing;
      if exists (
        select 1 from supabash.bodies b
        where b.workspace_id = p_workspace_id and b.body_hash = v_hash
          and (b.body <> v_body or b.byte_size <> v_size)
      ) then
        raise exception using errcode = 'XX001', message = 'SUPABASH_BODY_HASH_COLLISION';
      end if;
      insert into supabash.current_documents (
        workspace_id, path, body_hash, byte_size,
        metadata, content_hash, content_byte_size
      )
      values (
        p_workspace_id, v_path, v_hash, v_size,
        v_metadata, v_content_hash, v_content_size
      )
      on conflict (workspace_id, path) do update
        set body_hash = excluded.body_hash,
          byte_size = excluded.byte_size,
          metadata = excluded.metadata,
          content_hash = excluded.content_hash,
          content_byte_size = excluded.content_byte_size;
      v_receipt_change := jsonb_strip_nulls(jsonb_build_object(
        'kind', 'upsert', 'entryKind', 'file', 'path', v_path,
        'beforeHash', v_before_hash, 'beforeSize', v_before_size,
        'afterHash', v_content_hash, 'afterSize', v_content_size,
        'contentHash', v_content_hash
      ));
    elsif v_kind = 'delete' then
      if v_before_hash is null then
        raise exception using errcode = '22023', message = 'SUPABASH_INVALID_PATH';
      end if;
      delete from supabash.current_documents
      where workspace_id = p_workspace_id and path = v_path;
      v_receipt_change := jsonb_build_object(
        'kind', 'delete', 'entryKind', 'file', 'path', v_path,
        'beforeHash', v_before_hash, 'beforeSize', v_before_size,
        'contentHash', v_before_hash
      );
    else
      v_from := v_change ->> 'from';
      select
        e.body_hash, e.byte_size, e.metadata, e.content_hash, e.content_byte_size
      into
        v_source_hash, v_source_size, v_source_metadata,
        v_source_content_hash, v_source_content_size
      from supabash.current_documents e
      where e.workspace_id = p_workspace_id and e.path = v_from;
      if v_source_hash is null then
        raise exception using errcode = '22023', message = 'SUPABASH_INVALID_PATH';
      end if;
      if v_change ? 'body' then
        select
          d.body, d.body_hash, d.body_byte_size, d.metadata,
          d.content, d.content_hash, d.content_byte_size
        into
          v_body, v_hash, v_size, v_metadata,
          v_content, v_content_hash, v_content_size
        from supabash.decode_stored_document(v_change) d;
        insert into supabash.bodies (workspace_id, body_hash, body, byte_size)
        values (p_workspace_id, v_hash, v_body, v_size)
        on conflict (workspace_id, body_hash) do nothing;
        if exists (
          select 1 from supabash.bodies b
          where b.workspace_id = p_workspace_id and b.body_hash = v_hash
            and (b.body <> v_body or b.byte_size <> v_size)
        ) then
          raise exception using errcode = 'XX001', message = 'SUPABASH_BODY_HASH_COLLISION';
        end if;
      else
        v_hash := v_source_hash;
        v_size := v_source_size;
        v_metadata := v_source_metadata;
        v_content_hash := v_source_content_hash;
        v_content_size := v_source_content_size;
      end if;
      delete from supabash.current_documents
      where workspace_id = p_workspace_id and path = v_path;
      update supabash.current_documents
      set path = v_path,
        body_hash = v_hash,
        byte_size = v_size,
        metadata = v_metadata,
        content_hash = v_content_hash,
        content_byte_size = v_content_size
      where workspace_id = p_workspace_id and path = v_from;
      v_receipt_change := jsonb_build_object(
        'kind', 'move', 'entryKind', 'file', 'path', v_path,
        'moveFrom', v_from, 'moveTo', v_path,
        'beforeHash', v_source_content_hash, 'beforeSize', v_source_content_size,
        'afterHash', v_content_hash, 'afterSize', v_content_size,
        'contentHash', v_content_hash
      );
    end if;
    if v_receipt_change is distinct from p_receipt_changes -> (v_ordinal - 1) then
      raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CHANGES';
    end if;
    insert into supabash.revision_changes (workspace_id, revision_id, ordinal, change)
    values (p_workspace_id, v_revision, v_ordinal, v_receipt_change);
  end loop;

  if v_ordinal <> jsonb_array_length(p_receipt_changes) then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CHANGES';
  end if;

  -- Close only changed paths, then store their final state once. This also
  -- handles repeated writes, move chains, and delete/recreate within a commit.
  with touched as (
    select value ->> 'path' as path from jsonb_array_elements(p_changes)
    union
    select value ->> 'from' from jsonb_array_elements(p_changes) where value ->> 'kind' = 'move'
  )
  update supabash.document_versions e set valid_until = v_sequence
  from touched t where e.workspace_id = p_workspace_id and e.path = t.path
    and e.valid_until is null;
  with touched as (
    select value ->> 'path' as path from jsonb_array_elements(p_changes)
    union
    select value ->> 'from' from jsonb_array_elements(p_changes) where value ->> 'kind' = 'move'
  )
  insert into supabash.document_versions
    (workspace_id, path, valid_from, body_hash, byte_size, metadata, content_hash, content_byte_size)
  select d.workspace_id, d.path, v_sequence, d.body_hash, d.byte_size,
    d.metadata, d.content_hash, d.content_byte_size
  from supabash.current_documents d join touched t using(path)
  where d.workspace_id = p_workspace_id;

  update supabash.workspaces
  set head_revision = v_revision, updated_at = v_committed_at
  where id = p_workspace_id;

  return jsonb_build_object('receipt', supabash.receipt(p_workspace_id, v_revision), 'replayed', false);
end
$function$;

create or replace function public.supabash_purge(
  p_workspace_id uuid,
  p_max_revisions integer default null,
  p_max_age_ms bigint default null,
  p_dry_run boolean default false,
  p_delegated_grant text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, supabash
set row_security = on
as $function$
declare
  v_max_revisions integer;
  v_revisions uuid[];
  v_bodies text[];
  v_bytes bigint := 0;
  v_objects text[];
begin
  perform * from supabash.authorize_workspace(p_workspace_id, array['purge'], p_delegated_grant);
  select default_max_revisions into v_max_revisions from supabash.settings where singleton;
  v_max_revisions := coalesce(p_max_revisions, v_max_revisions);
  if v_max_revisions < 0 or p_max_age_ms is not null and p_max_age_ms < 0 then
    raise exception using errcode = '54000', message = 'SUPABASH_QUOTA_PURGE';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('supabash:' || p_workspace_id::text, 0));

  with recursive causal as (
    select r.revision_id, r.parent_revision, 0 as depth
    from supabash.workspaces w
    join supabash.workspace_revisions r
      on r.workspace_id = w.id and r.revision_id = w.head_revision
    where w.id = p_workspace_id
    union all
    select parent.revision_id, parent.parent_revision, child.depth + 1
    from causal child
    join supabash.workspace_revisions parent
      on parent.workspace_id = p_workspace_id
      and parent.revision_id = child.parent_revision
  ), classified as (
    select r.revision_id, r.committed_at, causal.depth
    from supabash.workspace_revisions r
    left join causal on causal.revision_id = r.revision_id
    where r.workspace_id = p_workspace_id
  )
  select coalesce(array_agg(revision_id order by depth desc nulls first, revision_id), '{}'::uuid[])
  into v_revisions
  from classified
  where (depth is null or depth >= v_max_revisions
      or (p_max_age_ms is not null and committed_at < clock_timestamp() - make_interval(secs => p_max_age_ms / 1000.0)))
    and revision_id <> (select head_revision from supabash.workspaces where id = p_workspace_id)
    and not exists (
      select 1 from supabash.checkpoints c
      where c.workspace_id = p_workspace_id and c.revision_id = classified.revision_id
    );

  select
    coalesce(array_agg(b.body_hash order by b.body_hash), '{}'::text[]),
    coalesce(sum(b.byte_size), 0)
  into v_bodies, v_bytes
  from supabash.bodies b
  where b.workspace_id = p_workspace_id
    and not exists (
      select 1 from supabash.current_documents d
      where d.workspace_id = b.workspace_id and d.body_hash = b.body_hash
    )
    and not exists (
      select 1 from supabash.revision_entries e
      where e.workspace_id = b.workspace_id and e.body_hash = b.body_hash
        and not (e.revision_id = any(v_revisions))
    )
    and not exists (
      select 1 from supabash.document_versions e
      join supabash.workspace_revisions r on r.workspace_id = e.workspace_id
        and r.storage_sequence >= e.valid_from
        and (e.valid_until is null or r.storage_sequence < e.valid_until)
      where e.workspace_id = b.workspace_id and e.body_hash = b.body_hash
        and not (r.revision_id = any(v_revisions))
    );

  select coalesce(array_agg(value order by value), '{}'::text[]) into v_objects
  from (
    select 'revision:' || value::text as value from unnest(v_revisions) revision(value)
    union all
    select 'body:' || value from unnest(v_bodies) body(value)
  ) listed;

  if not coalesce(p_dry_run, false) then
    delete from supabash.workspace_revisions
    where workspace_id = p_workspace_id and revision_id = any(v_revisions);
    delete from supabash.document_versions e
    where e.workspace_id = p_workspace_id and e.valid_until is not null
      and not exists (
        select 1 from supabash.workspace_revisions r
        where r.workspace_id = e.workspace_id and r.storage_sequence >= e.valid_from
          and r.storage_sequence < e.valid_until
      );
    delete from supabash.bodies
    where workspace_id = p_workspace_id and body_hash = any(v_bodies);
  end if;

  return jsonb_build_object(
    'bytes', v_bytes,
    'dryRun', coalesce(p_dry_run, false),
    'objects', to_jsonb(v_objects)
  );
end
$function$;


alter function public.supabash_commit(uuid, uuid, jsonb, jsonb, text, text, uuid, text, text, text, jsonb, uuid, text) set lock_timeout = '1s';
alter function public.supabash_purge(uuid, integer, bigint, boolean, text) set lock_timeout = '1s';
notify pgrst, 'reload schema';
commit;
