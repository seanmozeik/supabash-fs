\set ON_ERROR_STOP on
\ir ../../sql/postgres/0001_install.sql
\ir ../../sql/postgres/0002_lazy_reads.sql

select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated"}', false);
create temporary table upgrade_fixture (workspace_id uuid, legacy_revision uuid, new_revision uuid);
insert into upgrade_fixture(workspace_id)
select (public.supabash_create_workspace()->>'workspaceId')::uuid;

create function pg_temp.write_fixture(p_path text, p_body text) returns uuid
language plpgsql as $fn$
declare
  w uuid := (select workspace_id from upgrade_fixture);
  parent uuid := (select head_revision from supabash.workspaces where id = w);
  hash text := supabash.sha256_text(p_body);
  old_hash text;
  old_size bigint;
  result jsonb;
begin
  select content_hash, content_byte_size into old_hash, old_size
  from supabash.current_documents where workspace_id = w and path = p_path;
  result := public.supabash_commit(w, parent,
    jsonb_build_array(jsonb_build_object('kind', 'upsert', 'path', p_path,
      'body', p_body, 'bodyHash', hash, 'bodyByteSize', octet_length(p_body),
      'metadata', '{}'::jsonb, 'contentHash', hash, 'byteSize', octet_length(p_body))),
    jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('kind', 'upsert', 'entryKind', 'file',
      'path', p_path, 'beforeHash', old_hash, 'beforeSize', old_size,
      'afterHash', hash, 'afterSize', octet_length(p_body), 'contentHash', hash))),
    'upgrade-test', 'upgrade-test', gen_random_uuid(), hash);
  return (result->'receipt'->>'revision')::uuid;
end
$fn$;

select pg_temp.write_fixture('/unchanged.md', 'unchanged');
update upgrade_fixture set legacy_revision = pg_temp.write_fixture('/changed.md', 'before');

\ir ../../sql/postgres/0003_versioned_entries.sql

update upgrade_fixture set new_revision = pg_temp.write_fixture('/changed.md', 'after');

-- Reproduce the original 0.7.0 ACLs even when using the updated installer.
revoke update (metadata, cause) on supabash.workspace_revisions from supabash_api;
revoke update (change) on supabash.revision_changes from supabash_api;

-- A populated 0.7.0 database; apply twice to prove upgrade idempotence.
\ir ../../sql/postgres/0004_redact_retention.sql
\ir ../../sql/postgres/0004_redact_retention.sql
-- Assert column grants, including denial on every unrelated revision column.
do $acl$
declare c record;
begin
  for c in select table_name, column_name from information_schema.columns
    where table_schema = 'supabash' and table_name in ('workspace_revisions', 'revision_changes')
  loop
    if has_column_privilege('supabash_api', 'supabash.' || c.table_name, c.column_name, 'UPDATE')
      is distinct from (c.table_name = 'workspace_revisions' and c.column_name in ('metadata', 'cause')
        or c.table_name = 'revision_changes' and c.column_name = 'change') then
      raise exception 'Unexpected UPDATE privilege: %.%', c.table_name, c.column_name;
    end if;
  end loop;
  if has_table_privilege('supabash_api', 'supabash.bodies', 'UPDATE')
    or has_table_privilege('supabash_api', 'supabash.redactions', 'UPDATE,DELETE')
    or has_table_privilege('authenticated', 'supabash.redactions', 'SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('service_role', 'supabash.redactions', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'Unexpected table write or direct audit access';
  end if;
end
$acl$;

update supabash.workspace_revisions set metadata = '{"secret":"private","keep":"safe"}', cause = 'private'
where revision_id = (select legacy_revision from upgrade_fixture);
update supabash.revision_changes set change = change || '{"preview":"private"}'
where revision_id = (select legacy_revision from upgrade_fixture);

-- A rollback-based implementation fails here even if its writes have grants.
begin read only;
select public.supabash_redact(workspace_id, array['/changed.md'],
  p_before_revision => new_revision, p_dry_run => true,
  p_metadata_keys => array['secret'], p_clear_cause => true) from upgrade_fixture;
commit;

do $test$
declare
  w uuid := (select workspace_id from upgrade_fixture);
  old_revision uuid := (select legacy_revision from upgrade_fixture);
  new_revision uuid := (select new_revision from upgrade_fixture);
  doc jsonb;
  dry jsonb;
  applied jsonb;
begin
  doc := public.supabash_load_document(w, old_revision, '/changed.md');
  if doc->>'body' <> 'before' then raise exception 'Upgrade damaged legacy history'; end if;
  doc := public.supabash_load_document(w, new_revision, '/unchanged.md');
  if doc->>'body' <> 'unchanged' then raise exception 'Upgrade lost unchanged file'; end if;
  if (select count(*) from supabash.document_versions where workspace_id = w) <> 3 then
    raise exception 'Upgrade copied unchanged entries';
  end if;
  dry := public.supabash_redact(w, array['/changed.md'], p_before_revision => new_revision, p_dry_run => true,
    p_metadata_keys => array['secret'], p_clear_cause => true);
  doc := public.supabash_load_document(w, old_revision, '/changed.md');
  if doc->>'body' <> 'before' then raise exception 'Dry run changed legacy history'; end if;
  applied := public.supabash_redact(w, array['/changed.md'], p_before_revision => new_revision,
    p_metadata_keys => array['secret'], p_clear_cause => true);
  if dry - 'redactionId' - 'dryRun' <> applied - 'redactionId' - 'dryRun'
    or dry->'bodies' <> jsonb_build_array(supabash.sha256_text('before'))
    or (dry->>'bytes')::integer <> 6 then
    raise exception 'Dry run receipt differs from application';
  end if;
  if exists (select 1 from supabash.workspace_revisions where workspace_id = w
    and revision_id = old_revision and (metadata <> '{"keep":"safe"}'::jsonb or cause is not null))
    or exists (select 1 from supabash.revision_changes where workspace_id = w
      and revision_id = old_revision and change ? 'preview') then
    raise exception 'Receipt context survived redaction';
  end if;
  if exists (select 1 from supabash.bodies where workspace_id = w and body = 'before') then
    raise exception 'Legacy body survived redaction';
  end if;
  if not exists (select 1 from supabash.revision_entries where workspace_id = w
    and revision_id = old_revision and metadata @> '{"redacted":true}') then
    raise exception 'Legacy manifest was not tombstoned';
  end if;
  begin
    perform public.supabash_load_revision(w, old_revision);
    raise exception 'Legacy restore crossed fence';
  exception when invalid_parameter_value then
    if sqlerrm <> 'SUPABASH_RESTORE_CROSSES_REDACTION' then raise; end if;
  end;
  perform public.supabash_checkpoint(w, 'upgrade-pin');
  perform pg_temp.write_fixture('/changed.md', 'latest');
  perform public.supabash_purge(w, 1);
  doc := public.supabash_load_document(w, new_revision, '/changed.md');
  if doc->>'body' <> 'after' then raise exception 'Purge damaged pinned interval'; end if;
  if jsonb_array_length(public.supabash_load_pinned_snapshot(w, new_revision)->'documents') <> 2 then
    raise exception 'Purge damaged full pinned snapshot';
  end if;
end
$test$;

-- Exercise the audit policy as actual RPC caller roles, including delegated
-- authorization and a foreign owner. Roll back fixtures and role changes.
begin;
insert into supabash.delegated_grants
  (grant_hash, workspace_id, owner_id, actor_subject, operations, correlation_id, expires_at)
select extensions.digest('upgrade-redact-grant', 'sha256'), workspace_id,
  '90000000-0000-4000-8000-000000000001', 'upgrade-agent',
  array['redact', 'history'], 'upgrade', clock_timestamp() + interval '1 hour'
from upgrade_fixture;
do $rls$
declare
  w uuid := (select workspace_id from upgrade_fixture);
  boundary uuid := (select head_revision from supabash.workspaces where id = w);
  receipt jsonb;
begin
  set local role authenticated;
  receipt := public.supabash_redact(w, array['/owner-fence.md']);
  if public.supabash_restore_floor(w) <> to_jsonb(boundary) then
    raise exception 'Owner cannot read audit fence';
  end if;
  reset role;
  if not exists (select 1 from supabash.redactions where workspace_id = w
    and redaction_id = (receipt->>'redactionId')::uuid) then
    raise exception 'Owner audit insert missing';
  end if;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  receipt := public.supabash_redact(w, array['/delegated-fence.md'],
    p_delegated_grant => 'upgrade-redact-grant');
  if public.supabash_restore_floor(w, 'upgrade-redact-grant') <> to_jsonb(boundary) then
    raise exception 'Delegate cannot read audit fence';
  end if;
  reset role;
  if not exists (select 1 from supabash.redactions where workspace_id = w
    and redaction_id = (receipt->>'redactionId')::uuid) then
    raise exception 'Delegated audit insert missing';
  end if;
  perform set_config('request.jwt.claims',
    '{"sub":"90000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
  set local role authenticated;
  begin
    perform public.supabash_restore_floor(w);
    raise exception 'Foreign owner read audit fence';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.supabash_redact(w, array['/foreign.md']);
    raise exception 'Foreign owner inserted audit fence';
  exception when insufficient_privilege then null;
  end;
  reset role;
  -- Check RLS itself as the function owner, independent of RPC authorization.
  set local role supabash_api;
  if exists (select 1 from supabash.redactions where workspace_id = w) then
    raise exception 'Audit RLS exposed another owner';
  end if;
  begin
    insert into supabash.redactions(workspace_id, at_revision, boundary_sequence, paths)
    values(w, boundary, 0, array['/foreign.md']);
    raise exception 'Audit RLS allowed another owner insert';
  exception when insufficient_privilege then null;
  end;
  reset role;
end
$rls$;
rollback;

\ir ../../sql/postgres/0001_remove.sql
