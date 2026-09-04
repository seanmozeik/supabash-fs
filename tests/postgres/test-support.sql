\set ON_ERROR_STOP on

create schema if not exists supabash_test;
revoke all on schema supabash_test from public, anon, authenticated;

create table supabash_test.commit_failures (
  workspace_id uuid primary key,
  created_at timestamptz not null default clock_timestamp()
);

create function supabash_test.fail_after_head_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, supabash_test
as $function$
begin
  if exists (
    select 1
    from supabash_test.commit_failures failure
    where failure.workspace_id = new.id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'SUPABASH_TEST_INJECTED_FAILURE';
  end if;
  return new;
end
$function$;

drop trigger if exists supabash_test_fail_after_head_update on supabash.workspaces;
create trigger supabash_test_fail_after_head_update
after update of head_revision on supabash.workspaces
for each row
execute function supabash_test.fail_after_head_update();

create or replace function public.supabash_test_fail_next_commit(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, supabash_test
as $function$
begin
  insert into supabash_test.commit_failures (workspace_id)
  values (p_workspace_id)
  on conflict (workspace_id) do nothing;
end
$function$;

create or replace function public.supabash_test_clear_commit_failure(p_workspace_id uuid)
returns void
language sql
security definer
set search_path = pg_catalog, supabash_test
as $function$
  delete from supabash_test.commit_failures where workspace_id = p_workspace_id;
$function$;

create or replace function public.supabash_test_manifest_stats(p_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, supabash
as $function$
  select jsonb_build_object(
    'bodyCount', (select count(*) from supabash.bodies where workspace_id = p_workspace_id),
    'currentDocumentCount', (
      select count(*) from supabash.current_documents where workspace_id = p_workspace_id
    ),
    'manifestEntryCount', (
      select count(*) from supabash.revision_entries where workspace_id = p_workspace_id
    ),
    'revisionCount', (
      select count(*) from supabash.workspace_revisions where workspace_id = p_workspace_id
    )
  );
$function$;

/*
 * Deliberate test-only privilege bridge. `supabash_register_capability_verifier`
 * is revoked from every PostgREST role on purpose, so the integration suite
 * cannot call it. These two wrappers are `security definer` and are granted to
 * `service_role` so the suite can register and revoke a key. They exist only in
 * the test-support asset and are dropped by remove-test-support.sql. Never ship
 * anything like them: a wrapper granted to `service_role` hands the minting
 * secret to the role the capability system is designed to constrain.
 */
create or replace function public.supabash_test_register_verifier(
  p_key_id text,
  p_issuer text,
  p_audience text,
  p_origin text
)
returns text
language sql
security definer
set search_path = pg_catalog, public
as $function$
  select public.supabash_register_capability_verifier(
    p_key_id => p_key_id,
    p_issuer => p_issuer,
    p_audience => p_audience,
    p_origin => p_origin
  );
$function$;

create or replace function public.supabash_test_revoke_verifier(p_key_id text)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $function$
  select public.supabash_revoke_capability_verifier(p_key_id);
$function$;

/*
 * Reports every privilege that a PostgREST role holds on the capability
 * registration path and on the table that holds the signing secret. The suite
 * asserts that all three lists are empty.
 */
create or replace function public.supabash_test_privilege_report()
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $function$
  select jsonb_build_object(
    'functionPrivileges', coalesce((
      select jsonb_agg(distinct rest_role.rolname || ' -> ' || n.nspname || '.' || p.proname)
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      cross join (
        select rolname from pg_catalog.pg_roles
        where rolname in ('anon', 'authenticated', 'service_role')
      ) rest_role
      where (
          (n.nspname = 'public' and p.proname in (
            'supabash_register_capability_verifier', 'supabash_revoke_capability_verifier'
          ))
          or (n.nspname = 'supabash' and p.proname = 'capability_signature_valid')
        )
        and pg_catalog.has_function_privilege(rest_role.rolname, p.oid, 'execute')
    ), '[]'::jsonb),
    'tablePrivileges', coalesce((
      select jsonb_agg(distinct
        rest_role.rolname || ' -> ' || grant_kind.privilege || ' ' || n.nspname || '.' || c.relname
      )
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join (
        select rolname from pg_catalog.pg_roles
        where rolname in ('anon', 'authenticated', 'service_role')
      ) rest_role
      cross join (values ('select'), ('insert'), ('update'), ('delete'), ('references'))
        grant_kind(privilege)
      where n.nspname = 'supabash'
        and c.relname = 'capability_secrets'
        and pg_catalog.has_table_privilege(rest_role.rolname, c.oid, grant_kind.privilege)
    ), '[]'::jsonb),
    'schemaUsage', coalesce((
      select jsonb_agg(distinct rest_role.rolname || ' -> supabash')
      from (
        select rolname from pg_catalog.pg_roles
        where rolname in ('anon', 'authenticated', 'service_role')
      ) rest_role
      where pg_catalog.has_schema_privilege(rest_role.rolname, 'supabash', 'usage')
    ), '[]'::jsonb)
  );
$function$;

/* Proves that revoking a key cascades its secret away. */
create or replace function public.supabash_test_secret_present(p_key_id text)
returns boolean
language sql
security definer
set search_path = pg_catalog, supabash
as $function$
  select exists (select 1 from supabash.capability_secrets where key_id = p_key_id);
$function$;

create or replace function public.supabash_test_set_revision_time(
  p_workspace_id uuid,
  p_revision_ids uuid[],
  p_committed_at timestamptz
)
returns void
language sql
security definer
set search_path = pg_catalog, supabash
as $function$
  update supabash.workspace_revisions
  set committed_at = p_committed_at
  where workspace_id = p_workspace_id and revision_id = any(p_revision_ids);
$function$;

revoke all on function public.supabash_test_fail_next_commit(uuid) from public, anon, authenticated;
revoke all on function public.supabash_test_clear_commit_failure(uuid) from public, anon, authenticated;
revoke all on function public.supabash_test_manifest_stats(uuid) from public, anon, authenticated;
revoke all on function public.supabash_test_register_verifier(text, text, text, text) from public, anon, authenticated;
revoke all on function public.supabash_test_revoke_verifier(text) from public, anon, authenticated;
revoke all on function public.supabash_test_privilege_report() from public, anon, authenticated;
revoke all on function public.supabash_test_secret_present(text) from public, anon, authenticated;
revoke all on function public.supabash_test_set_revision_time(uuid, uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.supabash_test_fail_next_commit(uuid) to service_role;
grant execute on function public.supabash_test_clear_commit_failure(uuid) to service_role;
grant execute on function public.supabash_test_manifest_stats(uuid) to service_role;
grant execute on function public.supabash_test_register_verifier(text, text, text, text) to service_role;
grant execute on function public.supabash_test_revoke_verifier(text) to service_role;
grant execute on function public.supabash_test_privilege_report() to service_role;
grant execute on function public.supabash_test_secret_present(text) to service_role;
grant execute on function public.supabash_test_set_revision_time(uuid, uuid[], timestamptz) to service_role;

notify pgrst, 'reload schema';
