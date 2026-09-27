begin;
lock table supabash.workspaces in access exclusive mode;
grant create on schema public to supabash_api;

-- Preserve a unique order across purge gaps. Timestamps order disconnected
-- components; parent links order timestamp ties. UUIDs only stabilize an already
-- validated order, never resolve missing causal evidence.
alter table supabash.workspace_revisions add column if not exists legacy_sequence bigint;
alter table supabash.workspaces add column if not exists redaction_epoch bigint not null default 0
  check (redaction_epoch >= 0);

do $ordering$
declare v_workspace uuid;
begin
  for v_workspace in select distinct workspace_id from supabash.workspace_revisions
    where storage_sequence is null and legacy_sequence is null
  loop
    -- Never renumber published positions: fences must survive later purges.
    if exists (select 1 from supabash.workspace_revisions where workspace_id = v_workspace
      and storage_sequence is null and legacy_sequence is not null) then
      raise exception 'SUPABASH_LEGACY_ORDER_AMBIGUOUS workspace %: partially assigned order', v_workspace;
    end if;
    if exists (
      select 1 from supabash.workspace_revisions child
      join supabash.workspace_revisions parent on parent.workspace_id = child.workspace_id
        and parent.revision_id = child.parent_revision
      where child.workspace_id = v_workspace and (
        parent.storage_sequence is null and child.storage_sequence is null
          and parent.committed_at > child.committed_at
        or parent.storage_sequence is not null and (child.storage_sequence is null
          or parent.storage_sequence >= child.storage_sequence))
    ) or exists (
      select 1 from supabash.workspace_revisions where workspace_id = v_workspace
        and parent_revision is not null group by parent_revision having count(*) > 1
    ) then
      raise exception 'SUPABASH_LEGACY_ORDER_AMBIGUOUS workspace %: conflicting order evidence', v_workspace;
    end if;

    -- Only timestamp ties require ancestor expansion. Expanding the entire
    -- retained history would be quadratic even when timestamps are all unique.
    create temporary table supabash_legacy_ancestry on commit drop as
    with recursive ancestry as (
      select child.revision_id as descendant, parent.revision_id as ancestor, child.committed_at
      from supabash.workspace_revisions child
      join supabash.workspace_revisions parent on parent.workspace_id = child.workspace_id
        and parent.revision_id = child.parent_revision and parent.committed_at = child.committed_at
      where child.workspace_id = v_workspace and child.storage_sequence is null
      union
      select a.descendant, parent.revision_id, a.committed_at from ancestry a
      join supabash.workspace_revisions r on r.workspace_id = v_workspace and r.revision_id = a.ancestor
      join supabash.workspace_revisions parent on parent.workspace_id = r.workspace_id
        and parent.revision_id = r.parent_revision and parent.committed_at = a.committed_at
    ) select descendant, ancestor from ancestry;
    if exists (select 1 from supabash_legacy_ancestry where descendant = ancestor)
      or exists (
        select 1 from supabash.workspace_revisions a
        join supabash.workspace_revisions b on a.workspace_id = b.workspace_id
          and a.committed_at = b.committed_at and a.revision_id < b.revision_id
        where a.workspace_id = v_workspace and a.storage_sequence is null and b.storage_sequence is null
          and not exists (select 1 from supabash_legacy_ancestry p
            where (p.descendant = a.revision_id and p.ancestor = b.revision_id)
              or (p.descendant = b.revision_id and p.ancestor = a.revision_id))
      ) then
      raise exception 'SUPABASH_LEGACY_ORDER_AMBIGUOUS workspace %: disconnected timestamp ties or cycle', v_workspace;
    end if;
    with ordered as (
      select r.revision_id, row_number() over (order by r.committed_at,
        (select count(*) from supabash_legacy_ancestry a where a.descendant = r.revision_id),
        r.revision_id) - count(*) over () - 1 as position
      from supabash.workspace_revisions r where r.workspace_id = v_workspace and r.storage_sequence is null
    )
    update supabash.workspace_revisions r set legacy_sequence = o.position
    from ordered o where r.workspace_id = v_workspace and r.revision_id = o.revision_id;
    drop table supabash_legacy_ancestry;
  end loop;
end
$ordering$;
create unique index if not exists workspace_revision_position
  on supabash.workspace_revisions(workspace_id, (coalesce(storage_sequence, legacy_sequence)));

create table if not exists supabash.redactions (
  workspace_id uuid not null references supabash.workspaces(id) on delete cascade,
  redaction_id uuid not null default gen_random_uuid(),
  at_revision uuid not null,
  boundary_sequence bigint not null,
  paths text[] not null,
  created_at timestamptz not null default clock_timestamp(),
  reason text,
  primary key (workspace_id, redaction_id)
);
-- No revision FK: purging a boundary must never remove the fence.
alter table supabash.redactions enable row level security;
alter table supabash.redactions force row level security;
drop policy if exists redaction_owner on supabash.redactions;
create policy redaction_owner on supabash.redactions to supabash_api
  using (workspace_id in (select supabash.allowed_workspaces()))
  with check (workspace_id in (select supabash.allowed_workspaces()));
-- Match the private-table ACLs even when the installer has default grants.
revoke all on supabash.redactions from public, anon, authenticated, service_role;
revoke update, delete on supabash.redactions from supabash_api;
grant select, insert on supabash.redactions to supabash_api;
-- Existing installations keep immutable revision identity/order and body content.
-- Only receipt context and the JSON change payload need new UPDATE rights.
grant update (metadata, cause) on supabash.workspace_revisions to supabash_api;
grant update (change) on supabash.revision_changes to supabash_api;

-- User metadata may contain redacted=true. Only this deliberately non-renderable
-- tuple is internal: valid frontmatter has a nonempty rendered content hash/size.
create or replace function supabash.is_redacted_document(
  p_body_hash text, p_metadata jsonb, p_content_hash text, p_content_byte_size bigint
)
returns boolean language sql immutable security invoker
set search_path = pg_catalog, supabash
as $function$
  select coalesce(p_body_hash = supabash.sha256_text('')
    and p_metadata = '{"redacted":true}'::jsonb
    and p_content_hash = p_body_hash and p_content_byte_size = 0, false);
$function$;
revoke all on function supabash.is_redacted_document(text, jsonb, text, bigint) from public, anon, authenticated, service_role;
grant execute on function supabash.is_redacted_document(text, jsonb, text, bigint) to supabash_api;

create or replace function supabash.assert_restore_allowed(p_workspace_id uuid, p_revision_id uuid)
returns void language plpgsql stable security invoker
set search_path = pg_catalog, supabash
as $function$
declare v_sequence bigint;
begin
  select coalesce(storage_sequence, legacy_sequence) into v_sequence
  from supabash.workspace_revisions where workspace_id = p_workspace_id and revision_id = p_revision_id;
  if not found then
    raise exception using errcode = '22023', message = 'SUPABASH_REVISION_NOT_FOUND';
  end if;
  -- A full-tree restore also deletes paths absent from the target. Every recorded
  -- path is therefore in its scope, including forgotten files absent in the target.
  if exists (select 1 from supabash.redactions where workspace_id = p_workspace_id
    and cardinality(paths) > 0 and boundary_sequence > v_sequence) then
    raise exception using errcode = '22023', message = 'SUPABASH_RESTORE_CROSSES_REDACTION';
  end if;
end
$function$;

create or replace function public.supabash_restore_floor(p_workspace_id uuid, p_delegated_grant text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, supabash set row_security = on
as $function$
begin
  perform * from supabash.authorize_workspace(p_workspace_id, array['history', 'restore'], p_delegated_grant);
  return coalesce((select to_jsonb(at_revision) from supabash.redactions
    where workspace_id = p_workspace_id and cardinality(paths) > 0
    order by boundary_sequence desc, created_at desc limit 1), 'null'::jsonb);
end
$function$;


create or replace function public.supabash_exchange_capability(p_capability text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, supabash, extensions
set row_security = on
as $function$
declare
  v_parts text[];
  v_header jsonb;
  v_payload jsonb;
  v_signature bytea;
  v_verifier supabash.capability_verifiers;
  v_now bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  v_iat bigint;
  v_exp bigint;
  v_actor_subject text;
  v_owner uuid;
  v_workspace uuid;
  v_ops text[];
  v_nonce text;
  v_nonce_hash bytea;
  v_raw_grant text;
begin
  if supabash.request_role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SUPABASH_AUTHENTICATION_REQUIRED';
  end if;
  if p_capability is null or octet_length(p_capability) > 32768 then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CAPABILITY';
  end if;

  v_parts := string_to_array(p_capability, '.');
  if cardinality(v_parts) <> 3 or '' = any(v_parts) then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CAPABILITY';
  end if;

  begin
    v_header := convert_from(supabash.base64url_decode(v_parts[1]), 'UTF8')::jsonb;
    v_payload := convert_from(supabash.base64url_decode(v_parts[2]), 'UTF8')::jsonb;
    v_signature := supabash.base64url_decode(v_parts[3]);
  exception when others then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CAPABILITY';
  end;

  if jsonb_typeof(v_header) <> 'object'
    or v_header ->> 'alg' <> 'HS256'
    or v_header ->> 'typ' <> 'JWS'
    or coalesce(v_header ->> 'kid', '') = ''
    or octet_length(v_signature) <> 32
  then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CAPABILITY';
  end if;

  select k.* into v_verifier
  from supabash.capability_verifiers k
  where k.key_id = v_header ->> 'kid' and k.active;
  if not found then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CAPABILITY';
  end if;

  if not supabash.capability_signature_valid(
    v_verifier.key_id,
    convert_to(v_parts[1] || '.' || v_parts[2], 'UTF8'),
    v_signature
  ) then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CAPABILITY';
  end if;

  if jsonb_typeof(v_payload) <> 'object'
    or v_payload ->> 'backend' <> 'postgres'
    or v_payload ->> 'iss' <> v_verifier.issuer
    or v_payload ->> 'aud' <> v_verifier.audience
    or v_payload ->> 'origin' <> v_verifier.origin
    or jsonb_typeof(v_payload -> 'sv') <> 'number'
    or (v_payload ->> 'sv')::integer <> 3
    or jsonb_typeof(v_payload -> 'iat') <> 'number'
    or jsonb_typeof(v_payload -> 'exp') <> 'number'
    or jsonb_typeof(v_payload -> 'ops') <> 'array'
    or jsonb_array_length(v_payload -> 'ops') = 0
    or coalesce(btrim(v_payload ->> 'sub'), '') = ''
    or octet_length(v_payload ->> 'sub') > 1014
    or coalesce(v_payload ->> 'nonce', '') = ''
    or octet_length(v_payload ->> 'nonce') > 1024
    or coalesce(v_payload ->> 'corr', '') = ''
    or octet_length(v_payload ->> 'corr') > 1024
  then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CAPABILITY';
  end if;

  begin
    v_iat := (v_payload ->> 'iat')::bigint;
    v_exp := (v_payload ->> 'exp')::bigint;
    v_actor_subject := v_payload ->> 'sub';
    v_workspace := (v_payload ->> 'workspace')::uuid;
  exception when others then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CAPABILITY';
  end;

  if v_payload ->> 'workspace' <> v_workspace::text
    or v_iat > v_now + v_verifier.clock_skew_seconds
    or v_exp <= v_iat
    or v_exp - v_iat > v_verifier.max_lifetime_seconds
  then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CAPABILITY';
  end if;
  if v_exp + v_verifier.clock_skew_seconds < v_now then
    raise exception using errcode = '22023', message = 'SUPABASH_EXPIRED_CAPABILITY';
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_payload -> 'ops') op
    where jsonb_typeof(op) <> 'string'
  ) then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CAPABILITY';
  end if;
  select array_agg(value order by value) into v_ops
  from jsonb_array_elements_text(v_payload -> 'ops') operation(value);
  if not v_ops <@ array['checkpoint', 'commit', 'history', 'purge', 'redact', 'read', 'restore', 'write']::text[]
    or cardinality(v_ops) <> (select count(distinct value) from unnest(v_ops) operation(value))
  then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CAPABILITY';
  end if;

  perform set_config('supabash.capability_exchange', 'on', true);
  select w.owner_id into v_owner
  from supabash.workspaces w
  where w.id = v_workspace;
  if not found then
    perform set_config('supabash.capability_exchange', 'off', true);
    raise exception using errcode = '42501', message = 'SUPABASH_WORKSPACE_DENIED';
  end if;
  perform set_config('supabash.capability_exchange', 'off', true);
  perform set_config('supabash.delegated_subject', v_owner::text, true);

  delete from supabash.capability_nonces where expires_at < clock_timestamp();
  delete from supabash.delegated_grants where expires_at < clock_timestamp();
  v_nonce := jsonb_build_array(v_verifier.issuer, v_payload ->> 'nonce')::text;
  v_nonce_hash := extensions.digest(convert_to(v_nonce, 'UTF8'), 'sha256');
  begin
    /*
     * The exchange accepts a capability until exp plus the clock skew, so the
     * nonce row must survive that whole window. A shorter row would be purged
     * at the top of a later call and let the same capability mint twice.
     */
    insert into supabash.capability_nonces (nonce_hash, expires_at)
    values (
      v_nonce_hash,
      to_timestamp(v_exp) + make_interval(secs => v_verifier.clock_skew_seconds)
    );
  exception when unique_violation then
    raise exception using errcode = '22023', message = 'SUPABASH_CAPABILITY_NONCE_REUSED';
  end;

  v_raw_grant := supabash.base64url_encode(extensions.gen_random_bytes(32));
  insert into supabash.delegated_grants (
    grant_hash, workspace_id, owner_id, actor_subject, operations, correlation_id, expires_at
  ) values (
    extensions.digest(convert_to(v_raw_grant, 'UTF8'), 'sha256'),
    v_workspace,
    v_owner,
    v_actor_subject,
    v_ops,
    v_payload ->> 'corr',
    to_timestamp(v_exp)
  );

  return jsonb_build_object(
    'actorSubject', v_actor_subject,
    'delegatedGrant', v_raw_grant,
    'expiresAt', to_timestamp(v_exp),
    'workspace', v_workspace,
    'operations', to_jsonb(v_ops),
    'correlationId', v_payload ->> 'corr'
  );
end
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
    'redactionEpoch', w.redaction_epoch::text,
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
    'redactionEpoch', w.redaction_epoch::text,
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
        'kind', case when supabash.is_redacted_document(e.body_hash, e.metadata, e.content_hash, e.content_byte_size) then 'unavailable' else 'file' end,
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

create or replace function public.supabash_load_revision(
  p_workspace_id uuid,
  p_revision_id uuid,
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
  perform * from supabash.authorize_workspace(
    p_workspace_id, array['history', 'restore'], p_delegated_grant
  );
  perform supabash.assert_restore_allowed(p_workspace_id, p_revision_id);
  v_result := supabash.snapshot_at(p_workspace_id, p_revision_id);
  if v_result is null then
    raise exception using errcode = '22023', message = 'SUPABASH_REVISION_NOT_FOUND';
  end if;
  return v_result;
end
$function$;

drop function if exists public.supabash_commit(uuid, uuid, jsonb, jsonb, text, text, uuid, text, text, text, jsonb, uuid, text);

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
  p_delegated_grant text default null,
  p_redaction_epoch bigint default null
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

  if p_source_revision is not null then
    perform supabash.assert_restore_allowed(p_workspace_id, p_source_revision);
  end if;

  if p_redaction_epoch is distinct from (select redaction_epoch from supabash.workspaces where id = p_workspace_id) then
    raise exception using errcode = '22023', message = 'SUPABASH_REDACTION_INVALIDATED';
  end if;

  if v_auth.delegated then
    p_actor := 'delegated:' || v_auth.actor_subject;
    p_correlation_id := v_auth.correlation_id;
  end if;

  v_request_hash := supabash.sha256_text(jsonb_build_object(
    'workspaceId', p_workspace_id,
    'baseRevision', p_base_revision,
    'redactionEpoch', p_redaction_epoch,
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
  if supabash.is_redacted_document(v_result->>'bodyHash', v_result->'metadata',
    v_result->>'contentHash', (v_result->>'byteSize')::bigint) then
    raise exception using errcode = '22023', message = 'SUPABASH_REDACTED';
  end if;
  return v_result;
end
$function$;

create or replace function public.supabash_load_pinned_snapshot(
  p_workspace_id uuid,
  p_revision_id uuid,
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
  v_result := supabash.snapshot_at(p_workspace_id, p_revision_id);
  if v_result is null then
    raise exception using errcode = '22023', message = 'SUPABASH_REVISION_NOT_FOUND';
  end if;
  if exists (select 1 from jsonb_array_elements(v_result->'documents') d
    where d->>'kind' = 'unavailable') then
    raise exception using errcode = '22023', message = 'SUPABASH_REDACTED';
  end if;
  return v_result;
end
$function$;

create or replace function public.supabash_diff(
  p_workspace_id uuid,
  p_from jsonb,
  p_to jsonb,
  p_paths text[] default null,
  p_preview_bytes integer default null,
  p_staged_documents jsonb default null,
  p_delegated_grant text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, supabash
set row_security = on
as $function$
declare
  v_from jsonb;
  v_to jsonb;
  v_entries jsonb;
  v_preview integer;
  v_max_preview integer;
  v_path text;
begin
  perform * from supabash.authorize_workspace(
    p_workspace_id, array['history', 'restore'], p_delegated_grant
  );
  select max_diff_preview_bytes into v_max_preview from supabash.settings where singleton;
  v_preview := coalesce(p_preview_bytes, v_max_preview);
  if v_preview < 0 or v_preview > v_max_preview then
    raise exception using errcode = '54000', message = 'SUPABASH_QUOTA_DIFF_PREVIEW';
  end if;
  if p_paths is not null then
    foreach v_path in array p_paths loop
      if not coalesce(supabash.is_document_path(v_path), false) then
        raise exception using errcode = '22023', message = 'SUPABASH_INVALID_PATH';
      end if;
    end loop;
  end if;

  v_from := supabash.resolve_diff_ref(p_workspace_id, p_from, p_staged_documents);
  v_to := supabash.resolve_diff_ref(p_workspace_id, p_to, p_staged_documents);

  with before_stored as (
    select * from jsonb_to_recordset(v_from -> 'documents')
      as document(
        path text, body text, "bodyHash" text, "bodyByteSize" bigint,
        metadata jsonb, "contentHash" text, "byteSize" bigint
      )
  ), before_documents as (
    select
      path,
      supabash.is_redacted_document("bodyHash", metadata, "contentHash", "byteSize") as redacted,
      supabash.render_document(body, metadata) as body,
      "contentHash" as "bodyHash",
      "byteSize"
    from before_stored
  ), after_stored as (
    select * from jsonb_to_recordset(v_to -> 'documents')
      as document(
        path text, body text, "bodyHash" text, "bodyByteSize" bigint,
        metadata jsonb, "contentHash" text, "byteSize" bigint
      )
  ), after_documents as (
    select
      path,
      supabash.is_redacted_document("bodyHash", metadata, "contentHash", "byteSize") as redacted,
      supabash.render_document(body, metadata) as body,
      "contentHash" as "bodyHash",
      "byteSize"
    from after_stored
  ), changed as (
    select
      coalesce(a.path, b.path) as path,
      b.body as before_body,
      a.body as after_body,
      b."bodyHash" as before_hash,
      a."bodyHash" as after_hash,
      case
        when coalesce(a.redacted, false) or coalesce(b.redacted, false) then 'unavailable'
        when b.path is null then 'added'
        when a.path is null then 'deleted'
        else 'modified'
      end as kind
    from before_documents b
    full join after_documents a using (path)
    where b."bodyHash" is distinct from a."bodyHash" or coalesce(a.redacted, false) or coalesce(b.redacted, false)
  ), numbered as (
    select *,
      case when kind = 'deleted' then row_number() over (partition by before_hash, kind order by path) end as deleted_number,
      case when kind = 'added' then row_number() over (partition by after_hash, kind order by path) end as added_number
    from changed
  ), moves as (
    select
      added.path,
      deleted.path as move_from,
      added.path as move_to,
      deleted.before_hash,
      added.after_hash
    from numbered deleted
    join numbered added
      on deleted.kind = 'deleted'
      and added.kind = 'added'
      and deleted.before_hash = added.after_hash
      and deleted.deleted_number = added.added_number
  ), ordinary as (
    select changed.*
    from changed
    where not exists (
      select 1 from moves
      where (changed.kind = 'deleted' and moves.move_from = changed.path)
        or (changed.kind = 'added' and moves.move_to = changed.path)
    )
  ), described as (
    select
      ordinary.kind,
      ordinary.path,
      null::text as move_from,
      null::text as move_to,
      ordinary.before_hash,
      ordinary.after_hash,
      case
        when ordinary.kind = 'added' then ordinary.after_body
        when ordinary.kind = 'deleted' then ordinary.before_body
        when ordinary.kind = 'modified' then
          '--- before' || chr(10)
          || ordinary.before_body
          || case when right(ordinary.before_body, 1) = chr(10) then '' else chr(10) end
          || '+++ after' || chr(10)
          || ordinary.after_body
      end as preview
    from ordinary
    union all
    select
      'moved', moves.path, moves.move_from, moves.move_to,
      moves.before_hash, moves.after_hash, null::text
    from moves
  ), filtered as (
    select * from described
    where p_paths is null or path = any(p_paths) or move_from = any(p_paths)
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'kind', kind,
    'path', path,
    'moveFrom', move_from,
    'moveTo', move_to,
    'beforeHash', before_hash,
    'afterHash', after_hash,
    'preview', case
      when v_preview = 0 or preview is null then null
      when octet_length(preview) <= v_preview then preview
      else supabash.utf8_prefix(preview, v_preview) || chr(10) || '[truncated]' || chr(10)
    end
  )) order by path), '[]'::jsonb)
  into v_entries
  from filtered;

  return jsonb_build_object(
    'fromRevision', v_from ->> 'label',
    'toRevision', v_to ->> 'label',
    'entries', v_entries
  );
end
$function$;

drop function if exists public.supabash_history(uuid, text, integer, text);

create or replace function public.supabash_history(
  p_workspace_id uuid,
  p_cursor text default null,
  p_limit integer default null,
  p_delegated_grant text default null,
  p_cursor_missing text default 'error'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, supabash
set row_security = on
as $function$
declare
  v_limit integer;
  v_max integer;
  v_cursor_depth integer;
  v_records jsonb;
  v_count integer;
  v_next text;
begin
  perform * from supabash.authorize_workspace(p_workspace_id, array['history'], p_delegated_grant);
  if p_cursor_missing is null or p_cursor_missing not in ('error', 'oldest') then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CURSOR_MODE';
  end if;
  select max_history_page_size into v_max from supabash.settings where singleton;
  v_limit := coalesce(p_limit, least(100, v_max));
  if v_limit < 1 or v_limit > v_max then
    raise exception using errcode = '54000', message = 'SUPABASH_QUOTA_HISTORY_PAGE';
  end if;
  if p_cursor is not null then
    select 1 into v_cursor_depth from supabash.workspace_revisions
    where workspace_id = p_workspace_id and cursor = p_cursor;
    if not found then
      if p_cursor_missing = 'error' then
        raise exception using errcode = '22023', message = 'SUPABASH_REVISION_NOT_FOUND';
      end if;
      p_cursor := null;
    end if;
  end if;

  with ordered as (
    select revision_id, coalesce(storage_sequence, legacy_sequence) as position_order
    from supabash.workspace_revisions where workspace_id = p_workspace_id
  ), page as (
    select revision_id, -position_order as depth from ordered
    where p_cursor is null or position_order > (select coalesce(storage_sequence, legacy_sequence)
      from supabash.workspace_revisions where workspace_id = p_workspace_id and cursor = p_cursor)
    order by position_order limit v_limit + 1
  ), numbered as (
    select *, row_number() over (order by depth desc) as position from page
  )
  select
    coalesce(jsonb_agg(supabash.receipt(p_workspace_id, revision_id) order by depth desc)
      filter (where position <= v_limit), '[]'::jsonb),
    count(*)::integer,
    max((supabash.receipt(p_workspace_id, revision_id) ->> 'cursor'))
      filter (where position = v_limit)
  into v_records, v_count, v_next
  from numbered;

  return jsonb_strip_nulls(jsonb_build_object(
    'records', v_records,
    'nextCursor', case when v_count > v_limit then v_next else null end
  ));
end
$function$;

drop function if exists public.supabash_purge(uuid, integer, bigint, boolean, text);

create or replace function public.supabash_purge(
  p_workspace_id uuid,
  p_max_revisions integer default null,
  p_max_age_ms bigint default null,
  p_dry_run boolean default false,
  p_delegated_grant text default null,
  p_keep_after_revision uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, supabash
set row_security = on
as $function$
declare
  v_floor bigint;
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

  if p_keep_after_revision is not null then
    select coalesce(storage_sequence, legacy_sequence) into v_floor
    from supabash.workspace_revisions where workspace_id = p_workspace_id and revision_id = p_keep_after_revision;
    if not found then
      raise exception using errcode = '22023', message = 'SUPABASH_REVISION_NOT_FOUND';
    end if;
  end if;
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
    select r.revision_id, r.committed_at, coalesce(r.storage_sequence, r.legacy_sequence) as position_order, causal.depth
    from supabash.workspace_revisions r
    left join causal on causal.revision_id = r.revision_id
    where r.workspace_id = p_workspace_id
  )
  select coalesce(array_agg(revision_id order by depth desc nulls first, revision_id), '{}'::uuid[])
  into v_revisions
  from classified
  where (depth is null or depth >= v_max_revisions
      or (p_max_age_ms is not null and committed_at < clock_timestamp() - make_interval(secs => p_max_age_ms / 1000.0)))
    and (v_floor is null or position_order < v_floor)
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

-- The same workspace advisory lock serializes commit, purge and redaction.
create or replace function public.supabash_redact(
  p_workspace_id uuid,
  p_paths text[] default null,
  p_body_hashes text[] default null,
  p_before_revision uuid default null,
  p_dry_run boolean default false,
  p_reason text default null,
  p_metadata_keys text[] default null,
  p_clear_cause boolean default false,
  p_delegated_grant text default null
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, supabash set row_security = on
as $function$
declare
  v_head uuid;
  v_boundary uuid;
  v_cutoff bigint;
  v_revisions uuid[];
  v_paths text[];
  v_hashes text[];
  v_deleted text[];
  v_bytes bigint;
  v_id uuid := gen_random_uuid();
  v_tombstone text := supabash.sha256_text('');
begin
  perform * from supabash.authorize_workspace(p_workspace_id, array['redact'], p_delegated_grant);
  if coalesce(cardinality(p_paths), 0) + coalesce(cardinality(p_body_hashes), 0)
      + coalesce(cardinality(p_metadata_keys), 0) = 0 and not coalesce(p_clear_cause, false)
    or exists (select 1 from unnest(p_paths) p where not coalesce(supabash.is_document_path(p), false))
    or exists (select 1 from unnest(p_body_hashes) h where h is null or h !~ '^[0-9a-f]{64}$')
    or exists (select 1 from unnest(p_metadata_keys) k where k is null or k = '')
    or octet_length(p_reason) > 4096
  then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_REDACTION';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('supabash:' || p_workspace_id::text, 0));
  select head_revision into v_head from supabash.workspaces where id = p_workspace_id;
  v_boundary := coalesce(p_before_revision, v_head);
  select coalesce(storage_sequence, legacy_sequence) into v_cutoff
  from supabash.workspace_revisions where workspace_id = p_workspace_id and revision_id = v_boundary;
  if not found then
    raise exception using errcode = '22023', message = 'SUPABASH_REVISION_NOT_FOUND';
  end if;

  select coalesce(array_agg(distinct r.revision_id), '{}'),
    coalesce(array_agg(distinct e.path) filter (where e.path is not null), '{}'),
    coalesce(array_agg(distinct e.body_hash) filter (where e.body_hash is not null
      and not supabash.is_redacted_document(e.body_hash, e.metadata, e.content_hash, e.content_byte_size)), '{}')
  into v_revisions, v_paths, v_hashes
  from supabash.workspace_revisions r
  left join lateral supabash.entries_at(p_workspace_id, r.revision_id) e
    on (e.path = any(p_paths) or e.body_hash = any(p_body_hashes))
  where r.workspace_id = p_workspace_id and r.revision_id <> v_head
    and coalesce(r.storage_sequence, r.legacy_sequence) < v_cutoff
    and (e.path is not null or
      (coalesce(cardinality(p_paths), 0) + coalesce(cardinality(p_body_hashes), 0) = 0));

  -- Explicit hashes include bodies left unreferenced by an upsert overwritten
  -- later in the same commit, without ever crossing the workspace boundary.
  select coalesce(array_agg(distinct h), '{}') into v_hashes from (
    select unnest(v_hashes) as h
    union select body_hash from supabash.bodies
      where workspace_id = p_workspace_id and body_hash = any(p_body_hashes)
  ) candidates;

  if exists (select 1 from supabash.current_documents d
    where d.workspace_id = p_workspace_id and d.body_hash = any(v_hashes)
      and not supabash.is_redacted_document(d.body_hash, d.metadata, d.content_hash, d.content_byte_size)
      and not coalesce(d.path = any(p_paths), false)) then
    raise exception using errcode = '22023', message = 'SUPABASH_REDACTION_CURRENT_BODY';
  end if;
  select coalesce(array_agg(distinct p order by p), '{}') into v_paths
  from unnest(v_paths || coalesce(p_paths, '{}')) p;

  -- Compute the post-redaction references without writing. Legacy entries
  -- survive unless selected; interval references survive if unselected or on
  -- the retained side of the split. Current documents always retain their body.
  -- Use this same receipt for application and dry-run under the workspace lock.
  select coalesce(array_agg(b.body_hash order by b.body_hash), '{}'), coalesce(sum(b.byte_size), 0)
  into v_deleted, v_bytes from supabash.bodies b
  where b.workspace_id = p_workspace_id and b.body_hash = any(v_hashes) and b.body_hash <> v_tombstone
    and not exists (select 1 from supabash.current_documents d
      where d.workspace_id = b.workspace_id and d.body_hash = b.body_hash)
    and not exists (select 1 from supabash.revision_entries e
      where e.workspace_id = b.workspace_id and e.body_hash = b.body_hash
        and not (e.revision_id = any(v_revisions)
          and coalesce(e.path = any(p_paths) or e.body_hash = any(p_body_hashes), false)))
    and not exists (select 1 from supabash.document_versions e
      join supabash.workspace_revisions r on r.workspace_id = e.workspace_id
        and r.storage_sequence >= e.valid_from
        and (e.valid_until is null or r.storage_sequence < e.valid_until)
      where e.workspace_id = b.workspace_id and e.body_hash = b.body_hash
        and (r.storage_sequence >= v_cutoff
          or not coalesce(e.path = any(p_paths) or e.body_hash = any(p_body_hashes), false)));

  if not coalesce(p_dry_run, false) then
    update supabash.workspaces set redaction_epoch = redaction_epoch + 1 where id = p_workspace_id;
    insert into supabash.bodies(workspace_id, body_hash, body, byte_size)
    values(p_workspace_id, v_tombstone, '', 0) on conflict do nothing;

    -- Split any shared interval at the exclusive boundary. The current half
    -- retains its original body, hashes and metadata.
    with candidates as materialized (
      select * from supabash.document_versions e
      where e.workspace_id = p_workspace_id and e.valid_from < v_cutoff
        and (e.valid_until is null or e.valid_until > v_cutoff)
        and (e.path = any(p_paths) or e.body_hash = any(p_body_hashes))
    ), split as (
      update supabash.document_versions e set valid_until = v_cutoff
      where e.workspace_id = p_workspace_id and e.valid_from < v_cutoff
        and (e.valid_until is null or e.valid_until > v_cutoff)
        and (e.path = any(p_paths) or e.body_hash = any(p_body_hashes))
      returning e.*
    )
    insert into supabash.document_versions
      (workspace_id, path, valid_from, valid_until, body_hash, byte_size, metadata, content_hash, content_byte_size)
    select s.workspace_id, s.path, v_cutoff,
      c.valid_until,
      s.body_hash, s.byte_size, s.metadata, s.content_hash, s.content_byte_size
    from split s join candidates c using(workspace_id, path, valid_from);

    update supabash.document_versions e set body_hash = v_tombstone, byte_size = 0,
      metadata = '{"redacted":true}', content_hash = v_tombstone, content_byte_size = 0
    where e.workspace_id = p_workspace_id and e.valid_from < v_cutoff
      and (e.path = any(p_paths) or e.body_hash = any(p_body_hashes));
    update supabash.revision_entries e set body_hash = v_tombstone, byte_size = 0,
      metadata = '{"redacted":true}', content_hash = v_tombstone, content_byte_size = 0
    where e.workspace_id = p_workspace_id and e.revision_id = any(v_revisions)
      and (e.path = any(p_paths) or e.body_hash = any(p_body_hashes));

    update supabash.workspace_revisions set
      metadata = metadata - coalesce(p_metadata_keys, '{}'),
      cause = case when coalesce(p_clear_cause, false) then null else cause end
    where workspace_id = p_workspace_id and revision_id = any(v_revisions);
    update supabash.revision_changes set change = change - 'preview'
    where workspace_id = p_workspace_id
      and (change->>'path' = any(v_paths) or change->>'moveFrom' = any(v_paths) or change->>'moveTo' = any(v_paths));

    delete from supabash.document_versions e
    where e.workspace_id = p_workspace_id and e.valid_until is not null
      and not exists (select 1 from supabash.workspace_revisions r
        where r.workspace_id = e.workspace_id and r.storage_sequence >= e.valid_from
          and r.storage_sequence < e.valid_until);
    delete from supabash.bodies where workspace_id = p_workspace_id and body_hash = any(v_deleted);
    insert into supabash.redactions(workspace_id, redaction_id, at_revision, boundary_sequence, paths, reason)
    values(p_workspace_id, v_id, v_boundary, v_cutoff, v_paths, p_reason);
  end if;
  return jsonb_build_object('redactionId', v_id, 'revisions', v_revisions,
    'bodies', v_deleted, 'bytes', v_bytes, 'dryRun', coalesce(p_dry_run, false));
end
$function$;

revoke all on function supabash.assert_restore_allowed(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function supabash.assert_restore_allowed(uuid, uuid) to supabash_api;
alter function public.supabash_redact(uuid, text[], text[], uuid, boolean, text, text[], boolean, text) owner to supabash_api;
alter function public.supabash_restore_floor(uuid, text) owner to supabash_api;
alter function public.supabash_history(uuid, text, integer, text, text) owner to supabash_api;
alter function public.supabash_purge(uuid, integer, bigint, boolean, text, uuid) owner to supabash_api;
revoke all on function public.supabash_redact(uuid, text[], text[], uuid, boolean, text, text[], boolean, text) from public, anon;
revoke all on function public.supabash_restore_floor(uuid, text) from public, anon;
revoke all on function public.supabash_history(uuid, text, integer, text, text) from public, anon;
revoke all on function public.supabash_purge(uuid, integer, bigint, boolean, text, uuid) from public, anon;
grant execute on function public.supabash_redact(uuid, text[], text[], uuid, boolean, text, text[], boolean, text) to authenticated, service_role;
grant execute on function public.supabash_restore_floor(uuid, text) to authenticated, service_role;
grant execute on function public.supabash_history(uuid, text, integer, text, text) to authenticated, service_role;
grant execute on function public.supabash_purge(uuid, integer, bigint, boolean, text, uuid) to authenticated, service_role;
alter function public.supabash_redact(uuid, text[], text[], uuid, boolean, text, text[], boolean, text) set lock_timeout = '1s';
alter function public.supabash_purge(uuid, integer, bigint, boolean, text, uuid) set lock_timeout = '1s';
alter function public.supabash_commit(uuid, uuid, jsonb, jsonb, text, text, uuid, text, text, text, jsonb, uuid, text, bigint) owner to supabash_api;
revoke all on function public.supabash_commit(uuid, uuid, jsonb, jsonb, text, text, uuid, text, text, text, jsonb, uuid, text, bigint) from public, anon;
grant execute on function public.supabash_commit(uuid, uuid, jsonb, jsonb, text, text, uuid, text, text, text, jsonb, uuid, text, bigint) to authenticated, service_role;
alter function public.supabash_commit(uuid, uuid, jsonb, jsonb, text, text, uuid, text, text, text, jsonb, uuid, text, bigint) set lock_timeout = '1s';
revoke create on schema public from supabash_api;
notify pgrst, 'reload schema';
commit;
