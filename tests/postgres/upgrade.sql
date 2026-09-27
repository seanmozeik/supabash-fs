\set ON_ERROR_STOP on
\ir ../../sql/postgres/0001_install.sql
\ir ../../sql/postgres/0002_lazy_reads.sql

select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated"}', false);
create temporary table upgrade_fixture (workspace_id uuid, legacy_revision uuid, new_revision uuid);
insert into upgrade_fixture(workspace_id)
select (public.supabash_create_workspace()->>'workspaceId')::uuid;

create function pg_temp.write_fixture(p_path text, p_body text,
  p_workspace_id uuid default null, p_metadata jsonb default '{}') returns uuid
language plpgsql as $fn$
declare
  w uuid := coalesce(p_workspace_id, (select workspace_id from upgrade_fixture));
  parent uuid := (select head_revision from supabash.workspaces where id = w);
  hash text := supabash.sha256_text(p_body);
  content text := supabash.render_document(p_body, p_metadata);
  rendered_hash text := supabash.sha256_text(content);
  old_hash text;
  old_size bigint;
  result jsonb;
  epoch_argument text := '';
begin
  select content_hash, content_byte_size into old_hash, old_size
  from supabash.current_documents where workspace_id = w and path = p_path;
  if to_regprocedure('public.supabash_commit(uuid,uuid,jsonb,jsonb,text,text,uuid,text,text,text,jsonb,uuid,text,bigint)') is not null then
    epoch_argument := ', p_redaction_epoch => $9';
  end if;
  execute 'select public.supabash_commit($1,$2,$3,$4,$5,$6,$7,$8' || epoch_argument || ')'
  into result using w, parent,
    jsonb_build_array(jsonb_build_object('kind', 'upsert', 'path', p_path,
      'body', p_body, 'bodyHash', hash, 'bodyByteSize', octet_length(p_body),
      'metadata', p_metadata, 'contentHash', rendered_hash, 'byteSize', octet_length(content))),
    jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('kind', 'upsert', 'entryKind', 'file',
      'path', p_path, 'beforeHash', old_hash, 'beforeSize', old_size,
      'afterHash', rendered_hash, 'afterSize', octet_length(content), 'contentHash', rendered_hash))),
    'upgrade-test', 'upgrade-test', gen_random_uuid(), hash,
    (select redaction_epoch from supabash.workspaces where id = w);
  return (result->'receipt'->>'revision')::uuid;
end
$fn$;

-- Checkpoints retain three disconnected legacy components after a real purge.
-- The final two revisions share a timestamp, with a parent link resolving it.
create temporary table legacy_order_fixture(workspace_id uuid, ordinal integer, revision uuid);
do $fixture$
declare w uuid := (public.supabash_create_workspace()->>'workspaceId')::uuid;
  r uuid;
  i integer;
begin
  for i in 1..6 loop
    if i = 6 then
      r := pg_temp.write_fixture('/flag.md', '', w, '{"redacted":true}');
    else
      r := pg_temp.write_fixture('/memory.md', case when i < 5 then 'legacy secret' else 'safe' end, w);
    end if;
    insert into legacy_order_fixture values(w, i, r);
    update supabash.workspace_revisions set committed_at = '2020-01-01'::timestamptz + least(i, 5) * interval '1 second'
      where workspace_id = w and revision_id = r;
    if i in (1, 3, 5) then perform public.supabash_checkpoint(w, 'legacy-' || i); end if;
  end loop;
  perform public.supabash_purge(w, 1);
  if (select count(*) from supabash.workspace_revisions where workspace_id = w) <> 4 then
    raise exception 'Legacy purge-gap fixture did not retain the expected checkpoints';
  end if;
end
$fixture$;

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
-- All consumers must use the same total order, including across purged parents.
do $order$
declare
  w uuid := (select workspace_id from legacy_order_fixture limit 1);
  first_revision uuid := (select revision from legacy_order_fixture where ordinal = 1);
  floor_revision uuid := (select revision from legacy_order_fixture where ordinal = 3);
  expected uuid[] := array(select revision from legacy_order_fixture where ordinal in (1,3,5,6) order by ordinal);
  seen uuid[] := '{}';
  page jsonb;
  next_cursor text;
  result jsonb;
  doc jsonb;
begin
  loop
    page := public.supabash_history(w, next_cursor, 1);
    seen := seen || (page->'records'->0->>'revision')::uuid;
    next_cursor := page->>'nextCursor';
    exit when next_cursor is null;
    if cardinality(seen) > 4 then raise exception 'History pagination cycled'; end if;
  end loop;
  if seen <> expected then raise exception 'Legacy pagination order mismatch: %', seen; end if;
  if (select count(distinct legacy_sequence) from supabash.workspace_revisions where workspace_id = w) <> 4 then
    raise exception 'Legacy positions are not unique';
  end if;
  doc := public.supabash_load_pinned_snapshot(w, expected[4]);
  if doc->'documents'->0->>'kind' <> 'file' then raise exception 'User redacted=true metadata became a tombstone'; end if;
  begin
    perform * from supabash.decode_stored_document(jsonb_build_object(
      'path', '/forged.md', 'body', '', 'bodyByteSize', 0,
      'bodyHash', supabash.sha256_text(''), 'contentHash', supabash.sha256_text(''),
      'byteSize', 0, 'metadata', '{"redacted":true}'::jsonb));
    raise exception 'User input forged the internal tombstone tuple';
  exception when invalid_parameter_value then
    if sqlerrm <> 'SUPABASH_UNSUPPORTED_CONTENT' then raise; end if;
  end;
  doc := public.supabash_load_document(w, expected[4], '/flag.md');
  if doc->'metadata' <> '{"redacted":true}'::jsonb then raise exception 'Upgrade lost user frontmatter'; end if;
  delete from supabash.checkpoints where workspace_id = w;
  result := public.supabash_purge(w, 0, p_dry_run => true, p_keep_after_revision => floor_revision);
  if result->'objects' <> jsonb_build_array('revision:' || first_revision::text) then
    raise exception 'Legacy retention floor used a different order: %', result;
  end if;
  result := public.supabash_redact(w, array['/memory.md'], p_before_revision => floor_revision);
  if result->'revisions' <> jsonb_build_array(first_revision) then
    raise exception 'Legacy redaction boundary used a different order: %', result;
  end if;
  perform public.supabash_load_revision(w, floor_revision);
  begin
    perform public.supabash_load_revision(w, first_revision);
    raise exception 'Disconnected legacy revision crossed the redaction fence';
  exception when invalid_parameter_value then
    if sqlerrm <> 'SUPABASH_RESTORE_CROSSES_REDACTION' then raise; end if;
  end;
  begin
    perform public.supabash_load_document(w, first_revision, '/memory.md');
    raise exception 'Disconnected legacy body remained readable';
  exception when invalid_parameter_value then
    if sqlerrm <> 'SUPABASH_REDACTED' then raise; end if;
  end;
  -- A current user-created flag remains readable through new writes as well.
  perform pg_temp.write_fixture('/flag.md', 'readable', w, '{"redacted":true}');
  doc := public.supabash_load_document(w, (select head_revision from supabash.workspaces where id = w), '/flag.md');
  if doc->>'body' <> 'readable' then raise exception 'New user frontmatter is unreadable'; end if;
end
$order$;

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
