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

create or replace function public.supabash_test_register_verifier(
  p_key_id text,
  p_public_key_hex text,
  p_issuer text,
  p_audience text,
  p_origin text
)
returns void
language sql
security definer
set search_path = pg_catalog, supabash
as $function$
  insert into supabash.capability_verifiers (
    key_id,
    public_key,
    issuer,
    audience,
    origin
  ) values (
    p_key_id,
    decode(p_public_key_hex, 'hex'),
    p_issuer,
    p_audience,
    p_origin
  )
  on conflict (key_id) do update set
    public_key = excluded.public_key,
    issuer = excluded.issuer,
    audience = excluded.audience,
    origin = excluded.origin,
    active = true;
$function$;

revoke all on function public.supabash_test_fail_next_commit(uuid) from public, anon, authenticated;
revoke all on function public.supabash_test_clear_commit_failure(uuid) from public, anon, authenticated;
revoke all on function public.supabash_test_manifest_stats(uuid) from public, anon, authenticated;
revoke all on function public.supabash_test_register_verifier(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.supabash_test_fail_next_commit(uuid) to service_role;
grant execute on function public.supabash_test_clear_commit_failure(uuid) to service_role;
grant execute on function public.supabash_test_manifest_stats(uuid) to service_role;
grant execute on function public.supabash_test_register_verifier(text, text, text, text, text) to service_role;

notify pgrst, 'reload schema';
