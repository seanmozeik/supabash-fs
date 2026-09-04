\set ON_ERROR_STOP on

begin;

create extension if not exists pgcrypto with schema extensions;

do $role$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'supabash_api') then
    create role supabash_api nologin noinherit nobypassrls;
  end if;
  alter role supabash_api nologin noinherit nobypassrls;
end
$role$;

grant supabash_api to postgres;
grant usage on schema extensions to supabash_api;
grant usage, create on schema public to supabash_api;

create schema supabash;
revoke all on schema supabash from public, anon, authenticated, service_role;
grant usage on schema supabash to supabash_api;

create function supabash.request_role()
returns text
language sql
stable
parallel safe
set search_path = pg_catalog
as $function$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  );
$function$;

create function supabash.request_user_id()
returns uuid
language plpgsql
stable
parallel safe
set search_path = pg_catalog
as $function$
declare
  v_subject text;
begin
  v_subject := coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  );
  if v_subject is null then
    return null;
  end if;
  return v_subject::uuid;
exception when invalid_text_representation then
  return null;
end
$function$;

create function supabash.delegated_subject()
returns uuid
language plpgsql
stable
parallel safe
set search_path = pg_catalog
as $function$
declare
  v_subject text := nullif(current_setting('supabash.delegated_subject', true), '');
begin
  return case when v_subject is null then null else v_subject::uuid end;
exception when invalid_text_representation then
  return null;
end
$function$;

create function supabash.capability_exchange_authorized()
returns boolean
language sql
stable
parallel safe
set search_path = pg_catalog
as $function$
  select current_setting('supabash.capability_exchange', true) = 'on';
$function$;

create function supabash.sha256_text(p_value text)
returns text
language sql
immutable
strict
parallel safe
set search_path = pg_catalog, extensions
as $function$
  select encode(extensions.digest(convert_to(p_value, 'UTF8'), 'sha256'), 'hex');
$function$;

create function supabash.is_document_metadata(p_metadata jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $function$
  select
    jsonb_typeof(p_metadata) = 'object'
    and not exists (
      select 1
      from jsonb_each(p_metadata) as field(key, value)
      where field.key !~ '^[A-Za-z_][A-Za-z0-9_-]*$'
        or jsonb_typeof(field.value) not in ('null', 'boolean', 'number', 'string')
    );
$function$;

create function supabash.render_document(p_body text, p_metadata jsonb)
returns text
language sql
immutable
strict
parallel safe
set search_path = pg_catalog
as $function$
  select case
    when p_metadata = '{}'::jsonb then p_body
    else '---' || chr(10)
      || (
        select string_agg(field.key || ': ' || field.value::text, chr(10) order by field.key collate "C")
        from jsonb_each(p_metadata) as field(key, value)
      )
      || chr(10) || '---' || chr(10) || p_body
  end;
$function$;

create function supabash.decode_stored_document(p_document jsonb)
returns table (
  body text,
  body_hash text,
  body_byte_size bigint,
  metadata jsonb,
  content text,
  content_hash text,
  content_byte_size bigint
)
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, supabash
as $function$
declare
  v_body text;
  v_body_hash text;
  v_body_byte_size bigint;
  v_metadata jsonb;
  v_content text;
  v_content_hash text;
  v_content_byte_size bigint;
begin
  if p_document is null
    or jsonb_typeof(p_document) <> 'object'
    or not (p_document ?& array[
      'body', 'bodyByteSize', 'bodyHash', 'byteSize', 'contentHash', 'metadata'
    ])
    or jsonb_typeof(p_document -> 'body') <> 'string'
    or jsonb_typeof(p_document -> 'bodyByteSize') <> 'number'
    or jsonb_typeof(p_document -> 'byteSize') <> 'number'
    or (p_document ->> 'bodyHash') !~ '^[0-9a-f]{64}$'
    or (p_document ->> 'contentHash') !~ '^[0-9a-f]{64}$'
    or not coalesce(supabash.is_document_metadata(p_document -> 'metadata'), false)
  then
    raise exception using errcode = '22023', message = 'SUPABASH_UNSUPPORTED_CONTENT';
  end if;
  v_body := p_document ->> 'body';
  v_body_hash := supabash.sha256_text(v_body);
  v_body_byte_size := octet_length(v_body);
  v_metadata := p_document -> 'metadata';
  v_content := supabash.render_document(v_body, v_metadata);
  v_content_hash := supabash.sha256_text(v_content);
  v_content_byte_size := octet_length(v_content);
  if (p_document ->> 'bodyByteSize')::bigint <> v_body_byte_size
    or p_document ->> 'bodyHash' <> v_body_hash
    or (p_document ->> 'byteSize')::bigint <> v_content_byte_size
    or p_document ->> 'contentHash' <> v_content_hash
  then
    raise exception using errcode = '22023', message = 'SUPABASH_UNSUPPORTED_CONTENT';
  end if;
  body := v_body;
  body_hash := v_body_hash;
  body_byte_size := v_body_byte_size;
  metadata := v_metadata;
  content := v_content;
  content_hash := v_content_hash;
  content_byte_size := v_content_byte_size;
  return next;
end
$function$;

create function supabash.base64url_decode(p_value text)
returns bytea
language plpgsql
immutable
strict
parallel safe
set search_path = pg_catalog
as $function$
declare
  v_remainder integer := length(p_value) % 4;
begin
  if p_value !~ '^[A-Za-z0-9_-]*$' or v_remainder = 1 then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_BASE64URL';
  end if;
  return decode(
    translate(p_value, '-_', '+/') || repeat('=', (4 - v_remainder) % 4),
    'base64'
  );
end
$function$;

create function supabash.base64url_encode(p_value bytea)
returns text
language sql
immutable
strict
parallel safe
set search_path = pg_catalog
as $function$
  select translate(rtrim(encode(p_value, 'base64'), '='), '+/', '-_');
$function$;

create function supabash.is_document_path(p_path text)
returns boolean
language sql
immutable
strict
parallel safe
set search_path = pg_catalog
as $function$
  select
    p_path <> '/'
    and left(p_path, 1) = '/'
    and right(p_path, 1) <> '/'
    and octet_length(p_path) <= 4096
    and p_path !~ '[[:cntrl:]]'
    and position(chr(92) in p_path) = 0
    and p_path !~* '%(2e|2f|5c)'
    and not (
      p_path = any(array['/bin', '/dev', '/proc', '/tmp', '/usr'])
      or p_path like any(array['/bin/%', '/dev/%', '/proc/%', '/tmp/%', '/usr/%'])
    )
    and not exists (
      select 1
      from unnest(string_to_array(substr(p_path, 2), '/')) as segment(value)
      where value = ''
        or value in ('.', '..', '.supabash', '.supabash-directory')
        or octet_length(value) > 255
    );
$function$;

create function supabash.utf8_prefix(p_value text, p_max_bytes integer)
returns text
language plpgsql
immutable
strict
parallel safe
set search_path = pg_catalog
as $function$
declare
  v_low integer := 0;
  v_high integer := char_length(p_value);
  v_middle integer;
begin
  if p_max_bytes < 0 then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_PREVIEW_LIMIT';
  end if;
  while v_low < v_high loop
    v_middle := (v_low + v_high + 1) / 2;
    if octet_length(left(p_value, v_middle)) <= p_max_bytes then
      v_low := v_middle;
    else
      v_high := v_middle - 1;
    end if;
  end loop;
  return left(p_value, v_low);
end
$function$;

create table supabash.settings (
  singleton boolean primary key default true check (singleton),
  default_max_revisions integer not null default 50 check (default_max_revisions >= 0),
  max_changes_per_commit integer check (max_changes_per_commit is null or max_changes_per_commit > 0),
  max_diff_preview_bytes integer not null default 8192 check (max_diff_preview_bytes >= 0),
  max_history_page_size integer not null default 1000 check (max_history_page_size > 0)
);

insert into supabash.settings (singleton) values (true);

create table supabash.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  head_revision uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, owner_id)
);

create table supabash.workspace_revisions (
  workspace_id uuid not null references supabash.workspaces(id) on delete cascade,
  revision_id uuid not null default gen_random_uuid(),
  parent_revision uuid,
  transaction_id uuid not null,
  actor text not null check (actor <> '' and octet_length(actor) <= 1024),
  cause text check (cause is null or octet_length(cause) <= 4096),
  correlation_id text not null check (correlation_id <> '' and octet_length(correlation_id) <= 1024),
  cursor text not null,
  idempotency_key text check (idempotency_key is null or (idempotency_key <> '' and octet_length(idempotency_key) <= 1024)),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  source_revision uuid,
  schema_version integer not null default 1 check (schema_version = 1),
  status text not null default 'complete' check (status = 'complete'),
  committed_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, revision_id),
  unique (revision_id),
  unique (transaction_id),
  unique (cursor),
  unique (workspace_id, idempotency_key)
);

alter table supabash.workspaces
  add constraint workspaces_head_revision_fk
  foreign key (id, head_revision)
  references supabash.workspace_revisions(workspace_id, revision_id)
  deferrable initially deferred;

create index workspace_revisions_history_idx
  on supabash.workspace_revisions (workspace_id, committed_at, revision_id);

create table supabash.bodies (
  workspace_id uuid not null references supabash.workspaces(id) on delete cascade,
  body_hash text not null check (body_hash ~ '^[0-9a-f]{64}$'),
  body text not null,
  byte_size bigint not null check (byte_size >= 0 and byte_size = octet_length(body)),
  primary key (workspace_id, body_hash),
  unique (workspace_id, body_hash, byte_size)
);

create table supabash.current_documents (
  workspace_id uuid not null references supabash.workspaces(id) on delete cascade,
  path text not null check (supabash.is_document_path(path)),
  body_hash text not null,
  byte_size bigint not null check (byte_size >= 0),
  metadata jsonb not null default '{}'::jsonb check (supabash.is_document_metadata(metadata)),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  content_byte_size bigint not null check (content_byte_size >= 0),
  primary key (workspace_id, path),
  foreign key (workspace_id, body_hash, byte_size)
    references supabash.bodies(workspace_id, body_hash, byte_size)
);

create table supabash.revision_entries (
  workspace_id uuid not null,
  revision_id uuid not null,
  path text not null check (supabash.is_document_path(path)),
  body_hash text not null,
  byte_size bigint not null check (byte_size >= 0),
  metadata jsonb not null default '{}'::jsonb check (supabash.is_document_metadata(metadata)),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  content_byte_size bigint not null check (content_byte_size >= 0),
  primary key (workspace_id, revision_id, path),
  foreign key (workspace_id, revision_id)
    references supabash.workspace_revisions(workspace_id, revision_id) on delete cascade,
  foreign key (workspace_id, body_hash, byte_size)
    references supabash.bodies(workspace_id, body_hash, byte_size)
);

create index revision_entries_revision_idx
  on supabash.revision_entries (workspace_id, revision_id, path);

create table supabash.revision_changes (
  workspace_id uuid not null,
  revision_id uuid not null,
  ordinal integer not null check (ordinal > 0),
  change jsonb not null check (jsonb_typeof(change) = 'object'),
  primary key (workspace_id, revision_id, ordinal),
  foreign key (workspace_id, revision_id)
    references supabash.workspace_revisions(workspace_id, revision_id) on delete cascade
);

create table supabash.checkpoints (
  workspace_id uuid not null references supabash.workspaces(id) on delete cascade,
  checkpoint_id uuid not null default gen_random_uuid(),
  revision_id uuid not null,
  label text check (label is null or octet_length(label) <= 4096),
  retention_class text check (retention_class is null or octet_length(retention_class) <= 255),
  idempotency_key text check (idempotency_key is null or (idempotency_key <> '' and octet_length(idempotency_key) <= 1024)),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, checkpoint_id),
  unique (checkpoint_id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, revision_id)
    references supabash.workspace_revisions(workspace_id, revision_id) on delete restrict
);

create table supabash.capability_verifiers (
  key_id text primary key check (key_id <> '' and octet_length(key_id) <= 255),
  secret_name text not null check (secret_name ~ '^supabash_capability_[A-Za-z0-9._-]{1,235}$'),
  issuer text not null check (issuer <> '' and octet_length(issuer) <= 2048),
  audience text not null check (audience <> '' and octet_length(audience) <= 2048),
  origin text not null check (origin <> '' and octet_length(origin) <= 2048),
  clock_skew_seconds integer not null default 60 check (clock_skew_seconds between 0 and 3600),
  max_lifetime_seconds integer not null default 900 check (max_lifetime_seconds between 1 and 86400),
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp()
);

create table supabash.capability_nonces (
  nonce_hash bytea primary key check (octet_length(nonce_hash) = 32),
  expires_at timestamptz not null,
  consumed_at timestamptz not null default clock_timestamp()
);

create table supabash.delegated_grants (
  grant_hash bytea primary key check (octet_length(grant_hash) = 32),
  workspace_id uuid not null,
  owner_id uuid not null,
  actor_subject text not null check (
    btrim(actor_subject) <> '' and octet_length(actor_subject) <= 1014
  ),
  operations text[] not null check (cardinality(operations) > 0),
  correlation_id text not null check (correlation_id <> '' and octet_length(correlation_id) <= 1024),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, owner_id)
    references supabash.workspaces(id, owner_id) on delete cascade
);

create index delegated_grants_expiry_idx on supabash.delegated_grants (expires_at);
create index capability_nonces_expiry_idx on supabash.capability_nonces (expires_at);

create function supabash.owns_workspace(p_workspace_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, supabash
as $function$
  select exists (
    select 1
    from supabash.workspaces w
    where w.id = p_workspace_id
      and (
        (supabash.request_role() = 'authenticated' and w.owner_id = supabash.request_user_id())
        or (
          supabash.request_role() = 'service_role'
          and w.owner_id = supabash.delegated_subject()
        )
      )
  );
$function$;

alter table supabash.settings enable row level security;
alter table supabash.settings force row level security;
alter table supabash.workspaces enable row level security;
alter table supabash.workspaces force row level security;
alter table supabash.workspace_revisions enable row level security;
alter table supabash.workspace_revisions force row level security;
alter table supabash.bodies enable row level security;
alter table supabash.bodies force row level security;
alter table supabash.current_documents enable row level security;
alter table supabash.current_documents force row level security;
alter table supabash.revision_entries enable row level security;
alter table supabash.revision_entries force row level security;
alter table supabash.revision_changes enable row level security;
alter table supabash.revision_changes force row level security;
alter table supabash.checkpoints enable row level security;
alter table supabash.checkpoints force row level security;
alter table supabash.capability_verifiers enable row level security;
alter table supabash.capability_verifiers force row level security;
alter table supabash.capability_nonces enable row level security;
alter table supabash.capability_nonces force row level security;
alter table supabash.delegated_grants enable row level security;
alter table supabash.delegated_grants force row level security;

create policy settings_api on supabash.settings for select to supabash_api using (true);
create policy workspace_owner on supabash.workspaces to supabash_api
  using (
    (supabash.request_role() = 'authenticated' and owner_id = supabash.request_user_id())
    or (
      supabash.request_role() = 'service_role'
      and (
        owner_id = supabash.delegated_subject()
        or supabash.capability_exchange_authorized()
      )
    )
  )
  with check (
    (supabash.request_role() = 'authenticated' and owner_id = supabash.request_user_id())
    or (
      supabash.request_role() = 'service_role'
      and (
        owner_id = supabash.delegated_subject()
        or supabash.capability_exchange_authorized()
      )
    )
  );
create policy revision_owner on supabash.workspace_revisions to supabash_api
  using (supabash.owns_workspace(workspace_id))
  with check (supabash.owns_workspace(workspace_id));
create policy body_owner on supabash.bodies to supabash_api
  using (supabash.owns_workspace(workspace_id))
  with check (supabash.owns_workspace(workspace_id));
create policy current_document_owner on supabash.current_documents to supabash_api
  using (supabash.owns_workspace(workspace_id))
  with check (supabash.owns_workspace(workspace_id));
create policy revision_entry_owner on supabash.revision_entries to supabash_api
  using (supabash.owns_workspace(workspace_id))
  with check (supabash.owns_workspace(workspace_id));
create policy revision_change_owner on supabash.revision_changes to supabash_api
  using (supabash.owns_workspace(workspace_id))
  with check (supabash.owns_workspace(workspace_id));
create policy checkpoint_owner on supabash.checkpoints to supabash_api
  using (supabash.owns_workspace(workspace_id))
  with check (supabash.owns_workspace(workspace_id));
create policy capability_verifier_exchange on supabash.capability_verifiers
  for select to supabash_api using (supabash.request_role() = 'service_role');
create policy capability_nonce_exchange on supabash.capability_nonces
  to supabash_api
  using (supabash.request_role() = 'service_role')
  with check (supabash.request_role() = 'service_role');
create policy delegated_grant_exchange on supabash.delegated_grants
  to supabash_api
  using (supabash.request_role() = 'service_role')
  with check (supabash.request_role() = 'service_role');

revoke all on all tables in schema supabash from public, anon, authenticated, service_role;
grant select on supabash.settings to supabash_api;
grant select, insert, update, delete on supabash.workspaces to supabash_api;
grant select, insert, delete on supabash.workspace_revisions to supabash_api;
grant select, insert, delete on supabash.bodies to supabash_api;
grant select, insert, update, delete on supabash.current_documents to supabash_api;
grant select, insert, update, delete on supabash.revision_entries to supabash_api;
grant select, insert, delete on supabash.revision_changes to supabash_api;
grant select, insert, delete on supabash.checkpoints to supabash_api;
grant select on supabash.capability_verifiers to supabash_api;
grant select, insert, delete on supabash.capability_nonces to supabash_api;
grant select, insert, delete on supabash.delegated_grants to supabash_api;
grant execute on all functions in schema supabash to supabash_api;

create function supabash.authorize_workspace(
  p_workspace_id uuid,
  p_required_operations text[],
  p_delegated_grant text
)
returns table(owner_id uuid, actor_subject text, correlation_id text, delegated boolean)
language plpgsql
security invoker
set search_path = pg_catalog, supabash, extensions
as $function$
declare
  v_role text := supabash.request_role();
  v_grant supabash.delegated_grants;
  v_subject uuid;
begin
  if p_workspace_id is null or p_required_operations is null or cardinality(p_required_operations) = 0 then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_AUTHORIZATION_REQUEST';
  end if;

  if v_role = 'authenticated' then
    if p_delegated_grant is not null then
      raise exception using errcode = '42501', message = 'SUPABASH_WORKSPACE_DENIED';
    end if;
    v_subject := supabash.request_user_id();
    if v_subject is null then
      raise exception using errcode = '42501', message = 'SUPABASH_AUTHENTICATION_REQUIRED';
    end if;
    if not exists (
      select 1 from supabash.workspaces w
      where w.id = p_workspace_id and w.owner_id = v_subject
    ) then
      raise exception using errcode = '42501', message = 'SUPABASH_WORKSPACE_DENIED';
    end if;
    return query select v_subject, v_subject::text, null::text, false;
    return;
  end if;

  if v_role <> 'service_role' or p_delegated_grant is null or p_delegated_grant = '' then
    raise exception using errcode = '42501', message = 'SUPABASH_AUTHENTICATION_REQUIRED';
  end if;

  select g.* into v_grant
  from supabash.delegated_grants g
  where g.grant_hash = extensions.digest(convert_to(p_delegated_grant, 'UTF8'), 'sha256')
    and g.workspace_id = p_workspace_id
    and g.expires_at >= clock_timestamp()
    and g.operations && p_required_operations;

  if not found then
    raise exception using errcode = '42501', message = 'SUPABASH_WORKSPACE_DENIED';
  end if;

  perform set_config('supabash.delegated_subject', v_grant.owner_id::text, true);
  if not exists (
    select 1 from supabash.workspaces w
    where w.id = p_workspace_id and w.owner_id = v_grant.owner_id
  ) then
    raise exception using errcode = '42501', message = 'SUPABASH_WORKSPACE_DENIED';
  end if;

  return query select v_grant.owner_id, v_grant.actor_subject, v_grant.correlation_id, true;
end
$function$;

create function supabash.receipt(p_workspace_id uuid, p_revision_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, supabash
as $function$
  select jsonb_strip_nulls(jsonb_build_object(
    'actor', r.actor,
    'cause', r.cause,
    'changes', coalesce((
      select jsonb_agg(c.change order by c.ordinal)
      from supabash.revision_changes c
      where c.workspace_id = r.workspace_id and c.revision_id = r.revision_id
    ), '[]'::jsonb),
    'committedAt', r.committed_at,
    'correlationId', r.correlation_id,
    'cursor', r.cursor,
    'idempotencyKey', r.idempotency_key,
    'metadata', r.metadata,
    'parentRevision', r.parent_revision,
    'revision', r.revision_id,
    'schemaVersion', r.schema_version,
    'scope', supabash.sha256_text(r.workspace_id::text),
    'status', r.status,
    'transactionId', r.transaction_id
  ))
  from supabash.workspace_revisions r
  where r.workspace_id = p_workspace_id and r.revision_id = p_revision_id;
$function$;

create function supabash.snapshot_at(p_workspace_id uuid, p_revision_id uuid)
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
      from supabash.revision_entries e
      join supabash.bodies b
        on b.workspace_id = e.workspace_id and b.body_hash = e.body_hash
      where e.workspace_id = r.workspace_id and e.revision_id = r.revision_id
    ), '[]'::jsonb)
  )
  from supabash.workspace_revisions r
  where r.workspace_id = p_workspace_id and r.revision_id = p_revision_id;
$function$;

/*
 * Verifies one capability MAC without disclosing the secret.
 *
 * `public.supabash_exchange_capability` is owned by the least-privileged
 * `supabash_api` role, which has no vault access. This function keeps its
 * definer rights with the installing database owner, reads one vault secret,
 * and returns only a boolean. The name must carry the package prefix that
 * `supabash.capability_verifiers.secret_name` already enforces, so the
 * function cannot be steered at an unrelated vault secret. The comparison
 * runs under a fresh random blind, so it leaks no prefix of either MAC.
 */
create function supabash.capability_signature_valid(
  p_secret_name text,
  p_signing_input bytea,
  p_signature bytea
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, supabash, extensions
as $function$
declare
  v_secret_text text;
  v_secret bytea;
  v_blind bytea;
begin
  if coalesce(p_secret_name, '') !~ '^supabash_capability_[A-Za-z0-9._-]{1,235}$' then
    raise exception using
      errcode = '42501',
      message = 'SUPABASH_CAPABILITY_SECRET_UNAVAILABLE';
  end if;

  begin
    select s.decrypted_secret into v_secret_text
    from vault.decrypted_secrets s
    where s.name = p_secret_name;
    v_secret := supabash.base64url_decode(coalesce(v_secret_text, ''));
  exception when others then
    raise exception using
      errcode = '42501',
      message = 'SUPABASH_CAPABILITY_SECRET_UNAVAILABLE';
  end;
  if octet_length(v_secret) < 32 then
    raise exception using
      errcode = '42501',
      message = 'SUPABASH_CAPABILITY_SECRET_UNAVAILABLE';
  end if;

  v_blind := extensions.gen_random_bytes(32);
  return extensions.hmac(p_signature, v_blind, 'sha256')
    = extensions.hmac(
      extensions.hmac(p_signing_input, v_secret, 'sha256'),
      v_blind,
      'sha256'
    );
end
$function$;

create function public.supabash_exchange_capability(p_capability text)
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
    v_verifier.secret_name,
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
  if not v_ops <@ array['checkpoint', 'commit', 'history', 'purge', 'read', 'restore', 'write']::text[]
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
    insert into supabash.capability_nonces (nonce_hash, expires_at)
    values (v_nonce_hash, to_timestamp(v_exp));
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

create function public.supabash_register_capability_verifier(
  p_key_id text,
  p_issuer text,
  p_audience text,
  p_origin text,
  p_secret text default null,
  p_clock_skew_seconds integer default 60,
  p_max_lifetime_seconds integer default 900
)
returns text
language plpgsql
volatile
set search_path = pg_catalog, supabash, extensions
as $function$
declare
  v_secret_name text := 'supabash_capability_' || p_key_id;
  v_secret text := coalesce(p_secret, supabash.base64url_encode(extensions.gen_random_bytes(32)));
  v_secret_id uuid;
begin
  if coalesce(p_key_id, '') = '' or v_secret_name !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$' then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CAPABILITY_KEY_ID';
  end if;
  if octet_length(supabash.base64url_decode(v_secret)) < 32 then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CAPABILITY_SECRET';
  end if;

  select s.id into v_secret_id from vault.secrets s where s.name = v_secret_name;
  if v_secret_id is null then
    perform vault.create_secret(v_secret, v_secret_name);
  else
    perform vault.update_secret(v_secret_id, v_secret);
  end if;

  insert into supabash.capability_verifiers (
    key_id, secret_name, issuer, audience, origin, clock_skew_seconds, max_lifetime_seconds
  ) values (
    p_key_id, v_secret_name, p_issuer, p_audience, p_origin,
    p_clock_skew_seconds, p_max_lifetime_seconds
  )
  on conflict (key_id) do update set
    secret_name = excluded.secret_name,
    issuer = excluded.issuer,
    audience = excluded.audience,
    origin = excluded.origin,
    clock_skew_seconds = excluded.clock_skew_seconds,
    max_lifetime_seconds = excluded.max_lifetime_seconds,
    active = true;

  return v_secret;
end
$function$;

create function public.supabash_revoke_capability_verifier(p_key_id text)
returns void
language plpgsql
volatile
set search_path = pg_catalog, supabash
as $function$
declare
  v_secret_name text;
begin
  delete from supabash.capability_verifiers where key_id = p_key_id
  returning secret_name into v_secret_name;
  if v_secret_name is not null then
    delete from vault.secrets where name = v_secret_name;
  end if;
end
$function$;

create function public.supabash_create_workspace()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, supabash, extensions
set row_security = on
as $function$
declare
  v_subject uuid := supabash.request_user_id();
  v_workspace supabash.workspaces;
begin
  if supabash.request_role() <> 'authenticated' or v_subject is null then
    raise exception using errcode = '42501', message = 'SUPABASH_AUTHENTICATION_REQUIRED';
  end if;
  insert into supabash.workspaces (owner_id) values (v_subject) returning * into v_workspace;
  return jsonb_build_object('workspaceId', v_workspace.id, 'createdAt', v_workspace.created_at);
end
$function$;

create function public.supabash_load_workspace(
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
      from supabash.revision_entries e
      join supabash.bodies b
        on b.workspace_id = e.workspace_id and b.body_hash = e.body_hash
      where e.workspace_id = w.id and e.revision_id = w.head_revision
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

create function public.supabash_load_revision(
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
  v_result := supabash.snapshot_at(p_workspace_id, p_revision_id);
  if v_result is null then
    raise exception using errcode = '22023', message = 'SUPABASH_REVISION_NOT_FOUND';
  end if;
  return v_result;
end
$function$;

create function public.supabash_commit(
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
  v_derived_changes jsonb := '[]'::jsonb;
  v_ordinal integer := 0;
  v_limit integer;
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
    if v_kind = 'upsert' then
      perform * from supabash.decode_stored_document(v_change);
    elsif v_kind = 'move' then
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

  if v_head is not null then
    insert into supabash.revision_entries (
      workspace_id, revision_id, path, body_hash, byte_size,
      metadata, content_hash, content_byte_size
    )
    select
      workspace_id, v_revision, path, body_hash, byte_size,
      metadata, content_hash, content_byte_size
    from supabash.revision_entries
    where workspace_id = p_workspace_id and revision_id = v_head;
  end if;

  for v_change in select value from jsonb_array_elements(p_changes)
  loop
    v_ordinal := v_ordinal + 1;
    v_kind := v_change ->> 'kind';
    v_path := v_change ->> 'path';
    v_before_hash := null;
    v_before_size := null;
    select e.content_hash, e.content_byte_size into v_before_hash, v_before_size
    from supabash.revision_entries e
    where e.workspace_id = p_workspace_id and e.revision_id = v_revision and e.path = v_path;

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
      insert into supabash.revision_entries (
        workspace_id, revision_id, path, body_hash, byte_size,
        metadata, content_hash, content_byte_size
      )
      values (
        p_workspace_id, v_revision, v_path, v_hash, v_size,
        v_metadata, v_content_hash, v_content_size
      )
      on conflict (workspace_id, revision_id, path) do update
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
      delete from supabash.revision_entries
      where workspace_id = p_workspace_id and revision_id = v_revision and path = v_path;
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
      from supabash.revision_entries e
      where e.workspace_id = p_workspace_id and e.revision_id = v_revision and e.path = v_from;
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
      delete from supabash.revision_entries
      where workspace_id = p_workspace_id and revision_id = v_revision and path = v_path;
      update supabash.current_documents
      set path = v_path,
        body_hash = v_hash,
        byte_size = v_size,
        metadata = v_metadata,
        content_hash = v_content_hash,
        content_byte_size = v_content_size
      where workspace_id = p_workspace_id and path = v_from;
      update supabash.revision_entries
      set path = v_path,
        body_hash = v_hash,
        byte_size = v_size,
        metadata = v_metadata,
        content_hash = v_content_hash,
        content_byte_size = v_content_size
      where workspace_id = p_workspace_id and revision_id = v_revision and path = v_from;
      v_receipt_change := jsonb_build_object(
        'kind', 'move', 'entryKind', 'file', 'path', v_path,
        'moveFrom', v_from, 'moveTo', v_path,
        'beforeHash', v_source_content_hash, 'beforeSize', v_source_content_size,
        'afterHash', v_content_hash, 'afterSize', v_content_size,
        'contentHash', v_content_hash
      );
    end if;
    v_derived_changes := v_derived_changes || jsonb_build_array(v_receipt_change);
    insert into supabash.revision_changes (workspace_id, revision_id, ordinal, change)
    values (p_workspace_id, v_revision, v_ordinal, v_receipt_change);
  end loop;

  if v_derived_changes <> p_receipt_changes then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CHANGES';
  end if;

  update supabash.workspaces
  set head_revision = v_revision, updated_at = v_committed_at
  where id = p_workspace_id;

  return jsonb_build_object('receipt', supabash.receipt(p_workspace_id, v_revision), 'replayed', false);
end
$function$;

create function public.supabash_history(
  p_workspace_id uuid,
  p_cursor text default null,
  p_limit integer default null,
  p_delegated_grant text default null
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
  select max_history_page_size into v_max from supabash.settings where singleton;
  v_limit := coalesce(p_limit, least(100, v_max));
  if v_limit < 1 or v_limit > v_max then
    raise exception using errcode = '54000', message = 'SUPABASH_QUOTA_HISTORY_PAGE';
  end if;
  if p_cursor is not null then
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
    )
    select causal.depth into v_cursor_depth
    from causal
    join supabash.workspace_revisions r
      on r.workspace_id = p_workspace_id and r.revision_id = causal.revision_id
    where r.cursor = p_cursor;
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
  ), page as (
    select revision_id, depth
    from causal
    where p_cursor is null or depth < v_cursor_depth
    order by depth desc
    limit v_limit + 1
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

create function public.supabash_checkpoint(
  p_workspace_id uuid,
  p_label text default null,
  p_retention_class text default null,
  p_idempotency_key text default null,
  p_delegated_grant text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, supabash, extensions
set row_security = on
as $function$
declare
  v_head uuid;
  v_hash text;
  v_existing supabash.checkpoints;
  v_checkpoint supabash.checkpoints;
begin
  perform * from supabash.authorize_workspace(p_workspace_id, array['checkpoint'], p_delegated_grant);
  if p_label is not null and octet_length(p_label) > 4096
    or p_retention_class is not null and octet_length(p_retention_class) > 255
    or p_idempotency_key is not null and (p_idempotency_key = '' or octet_length(p_idempotency_key) > 1024)
  then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CHECKPOINT';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('supabash:' || p_workspace_id::text, 0));
  select head_revision into v_head from supabash.workspaces where id = p_workspace_id;
  if v_head is null then
    raise exception using errcode = '22023', message = 'SUPABASH_REVISION_NOT_FOUND';
  end if;
  v_hash := supabash.sha256_text(jsonb_build_object(
    'workspaceId', p_workspace_id, 'revision', v_head, 'label', p_label,
    'retentionClass', p_retention_class, 'idempotencyKey', p_idempotency_key
  )::text);
  if p_idempotency_key is not null then
    select * into v_existing from supabash.checkpoints
    where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
    if found then
      if v_existing.request_hash <> v_hash then
        raise exception using errcode = '23505', message = 'SUPABASH_IDEMPOTENCY_CONFLICT';
      end if;
      return jsonb_build_object(
        'checkpointId', v_existing.checkpoint_id,
        'createdAt', v_existing.created_at,
        'revision', v_existing.revision_id
      );
    end if;
  end if;
  insert into supabash.checkpoints (
    workspace_id, revision_id, label, retention_class, idempotency_key, request_hash
  ) values (
    p_workspace_id, v_head, p_label, p_retention_class, p_idempotency_key, v_hash
  ) returning * into v_checkpoint;
  return jsonb_build_object(
    'checkpointId', v_checkpoint.checkpoint_id,
    'createdAt', v_checkpoint.created_at,
    'revision', v_checkpoint.revision_id
  );
end
$function$;

create function public.supabash_checkpoints(
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
  perform * from supabash.authorize_workspace(p_workspace_id, array['checkpoint'], p_delegated_grant);
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'checkpointId', c.checkpoint_id,
    'createdAt', c.created_at,
    'revision', c.revision_id,
    'label', c.label,
    'retentionClass', c.retention_class,
    'idempotencyKey', c.idempotency_key
  )) order by c.created_at, c.checkpoint_id), '[]'::jsonb)
  into v_result
  from supabash.checkpoints c
  where c.workspace_id = p_workspace_id;
  return v_result;
end
$function$;

create function public.supabash_delete_checkpoint(
  p_workspace_id uuid,
  p_checkpoint_id uuid,
  p_delegated_grant text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, supabash
set row_security = on
as $function$
begin
  perform * from supabash.authorize_workspace(p_workspace_id, array['checkpoint'], p_delegated_grant);
  delete from supabash.checkpoints
  where workspace_id = p_workspace_id and checkpoint_id = p_checkpoint_id;
  if not found then
    raise exception using errcode = '22023', message = 'SUPABASH_CHECKPOINT_NOT_FOUND';
  end if;
end
$function$;

create function supabash.resolve_diff_ref(
  p_workspace_id uuid,
  p_ref jsonb,
  p_staged_documents jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, supabash
as $function$
declare
  v_revision uuid;
  v_checkpoint uuid;
  v_snapshot jsonb;
  v_document jsonb;
  v_path text;
  v_body text;
  v_hash text;
  v_size bigint;
  v_metadata jsonb;
  v_content text;
  v_content_hash text;
  v_content_size bigint;
begin
  if p_ref is null or jsonb_typeof(p_ref) <> 'object' then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_REVISION_REFERENCE';
  end if;

  if p_ref ? 'staged' then
    if p_ref -> 'staged' <> 'true'::jsonb
      or p_staged_documents is null
      or jsonb_typeof(p_staged_documents) <> 'array'
    then
      raise exception using errcode = '22023', message = 'SUPABASH_INVALID_REVISION_REFERENCE';
    end if;
    for v_document in select value from jsonb_array_elements(p_staged_documents)
    loop
      v_path := v_document ->> 'path';
      if not coalesce(supabash.is_document_path(v_path), false) then
        raise exception using errcode = '22023', message = 'SUPABASH_UNSUPPORTED_CONTENT';
      end if;
      perform * from supabash.decode_stored_document(v_document);
    end loop;
    if (
      select count(*) <> count(distinct document ->> 'path')
      from jsonb_array_elements(p_staged_documents) document
    ) then
      raise exception using errcode = '22023', message = 'SUPABASH_INVALID_CHANGES';
    end if;
    return jsonb_build_object(
      'label', 'staged',
      'documents', coalesce((
        select jsonb_agg(jsonb_build_object(
          'path', document ->> 'path',
          'body', document ->> 'body',
          'bodyHash', document ->> 'bodyHash',
          'bodyByteSize', (document ->> 'bodyByteSize')::bigint,
          'metadata', document -> 'metadata',
          'contentHash', document ->> 'contentHash',
          'byteSize', (document ->> 'byteSize')::bigint
        ) order by document ->> 'path')
        from jsonb_array_elements(p_staged_documents) document
      ), '[]'::jsonb)
    );
  end if;

  begin
    if p_ref ? 'checkpoint' then
      v_checkpoint := (p_ref ->> 'checkpoint')::uuid;
      select c.revision_id into v_revision
      from supabash.checkpoints c
      where c.workspace_id = p_workspace_id and c.checkpoint_id = v_checkpoint;
      if not found then
        raise exception using errcode = '22023', message = 'SUPABASH_CHECKPOINT_NOT_FOUND';
      end if;
    elsif p_ref ? 'revision' then
      v_revision := (p_ref ->> 'revision')::uuid;
    else
      raise exception using errcode = '22023', message = 'SUPABASH_INVALID_REVISION_REFERENCE';
    end if;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'SUPABASH_INVALID_REVISION_REFERENCE';
  end;

  v_snapshot := supabash.snapshot_at(p_workspace_id, v_revision);
  if v_snapshot is null then
    raise exception using errcode = '22023', message = 'SUPABASH_REVISION_NOT_FOUND';
  end if;
  return jsonb_build_object(
    'label', v_revision::text,
    'documents', v_snapshot -> 'documents'
  );
end
$function$;

create function public.supabash_diff(
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
        when b.path is null then 'added'
        when a.path is null then 'deleted'
        else 'modified'
      end as kind
    from before_documents b
    full join after_documents a using (path)
    where b."bodyHash" is distinct from a."bodyHash"
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

create function public.supabash_purge(
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

revoke execute on all functions in schema supabash from public, anon, authenticated, service_role;
grant execute on all functions in schema supabash to supabash_api;

alter function public.supabash_exchange_capability(text) owner to supabash_api;
alter function public.supabash_create_workspace() owner to supabash_api;
alter function public.supabash_load_workspace(uuid, text) owner to supabash_api;
alter function public.supabash_load_revision(uuid, uuid, text) owner to supabash_api;
alter function public.supabash_commit(uuid, uuid, jsonb, jsonb, text, text, uuid, text, text, text, jsonb, uuid, text) owner to supabash_api;
alter function public.supabash_history(uuid, text, integer, text) owner to supabash_api;
alter function public.supabash_checkpoint(uuid, text, text, text, text) owner to supabash_api;
alter function public.supabash_checkpoints(uuid, text) owner to supabash_api;
alter function public.supabash_delete_checkpoint(uuid, uuid, text) owner to supabash_api;
alter function public.supabash_diff(uuid, jsonb, jsonb, text[], integer, jsonb, text) owner to supabash_api;
alter function public.supabash_purge(uuid, integer, bigint, boolean, text) owner to supabash_api;

revoke create on schema public from supabash_api;

revoke all on function public.supabash_register_capability_verifier(
  text, text, text, text, text, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.supabash_revoke_capability_verifier(text)
  from public, anon, authenticated, service_role;
revoke all on function public.supabash_exchange_capability(text) from public, anon, authenticated;
grant execute on function public.supabash_exchange_capability(text) to service_role;
revoke all on function public.supabash_create_workspace() from public, anon, service_role;
grant execute on function public.supabash_create_workspace() to authenticated;

revoke all on function public.supabash_load_workspace(uuid, text) from public, anon;
revoke all on function public.supabash_load_revision(uuid, uuid, text) from public, anon;
revoke all on function public.supabash_commit(uuid, uuid, jsonb, jsonb, text, text, uuid, text, text, text, jsonb, uuid, text) from public, anon;
revoke all on function public.supabash_history(uuid, text, integer, text) from public, anon;
revoke all on function public.supabash_checkpoint(uuid, text, text, text, text) from public, anon;
revoke all on function public.supabash_checkpoints(uuid, text) from public, anon;
revoke all on function public.supabash_delete_checkpoint(uuid, uuid, text) from public, anon;
revoke all on function public.supabash_diff(uuid, jsonb, jsonb, text[], integer, jsonb, text) from public, anon;
revoke all on function public.supabash_purge(uuid, integer, bigint, boolean, text) from public, anon;

grant execute on function public.supabash_load_workspace(uuid, text) to authenticated, service_role;
grant execute on function public.supabash_load_revision(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.supabash_commit(uuid, uuid, jsonb, jsonb, text, text, uuid, text, text, text, jsonb, uuid, text) to authenticated, service_role;
grant execute on function public.supabash_history(uuid, text, integer, text) to authenticated, service_role;
grant execute on function public.supabash_checkpoint(uuid, text, text, text, text) to authenticated, service_role;
grant execute on function public.supabash_checkpoints(uuid, text) to authenticated, service_role;
grant execute on function public.supabash_delete_checkpoint(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.supabash_diff(uuid, jsonb, jsonb, text[], integer, jsonb, text) to authenticated, service_role;
grant execute on function public.supabash_purge(uuid, integer, bigint, boolean, text) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
