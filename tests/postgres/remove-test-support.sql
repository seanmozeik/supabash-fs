\set ON_ERROR_STOP on

do $verifier$
begin
  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'supabash_test_revoke_verifier'
  ) then
    perform public.supabash_test_revoke_verifier('integration');
  end if;
end
$verifier$;

drop function if exists public.supabash_test_revoke_verifier(text);
drop function if exists public.supabash_test_privilege_report;
drop function if exists public.supabash_test_secret_present;
drop function if exists public.supabash_test_register_verifier(text, text, text, text);
drop function if exists public.supabash_test_set_revision_time(uuid, uuid[], timestamptz);
drop function if exists public.supabash_test_manifest_stats(uuid);
drop function if exists public.supabash_test_clear_commit_failure(uuid);
drop function if exists public.supabash_test_fail_next_commit(uuid);
drop schema if exists supabash_test cascade;

notify pgrst, 'reload schema';
