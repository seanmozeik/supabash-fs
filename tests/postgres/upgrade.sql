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

-- A populated 0.7.0 database; apply twice to prove upgrade idempotence.
\ir ../../sql/postgres/0004_redact_retention.sql
\ir ../../sql/postgres/0004_redact_retention.sql
do $test$
declare
  w uuid := (select workspace_id from upgrade_fixture);
  old_revision uuid := (select legacy_revision from upgrade_fixture);
  new_revision uuid := (select new_revision from upgrade_fixture);
  doc jsonb;
begin
  doc := public.supabash_load_document(w, old_revision, '/changed.md');
  if doc->>'body' <> 'before' then raise exception 'Upgrade damaged legacy history'; end if;
  doc := public.supabash_load_document(w, new_revision, '/unchanged.md');
  if doc->>'body' <> 'unchanged' then raise exception 'Upgrade lost unchanged file'; end if;
  if (select count(*) from supabash.document_versions where workspace_id = w) <> 3 then
    raise exception 'Upgrade copied unchanged entries';
  end if;
  perform public.supabash_redact(w, array['/changed.md'], p_before_revision => new_revision, p_dry_run => true);
  doc := public.supabash_load_document(w, old_revision, '/changed.md');
  if doc->>'body' <> 'before' then raise exception 'Dry run changed legacy history'; end if;
  perform public.supabash_redact(w, array['/changed.md'], p_before_revision => new_revision);
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

\ir ../../sql/postgres/0001_remove.sql
