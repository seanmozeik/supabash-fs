\set ON_ERROR_STOP on

begin;

drop function if exists public.supabash_purge(uuid, integer, bigint, boolean, text);
drop function if exists public.supabash_delete_checkpoint(uuid, uuid, text);
drop function if exists public.supabash_diff(uuid, jsonb, jsonb, text[], integer, jsonb, text);
drop function if exists public.supabash_checkpoints(uuid, text);
drop function if exists public.supabash_checkpoint(uuid, text, text, text, text);
drop function if exists public.supabash_history(uuid, text, integer, text);
drop function if exists public.supabash_commit(uuid, uuid, jsonb, jsonb, text, text, uuid, text, text, text, jsonb, uuid, text);
drop function if exists public.supabash_load_revision(uuid, uuid, text);
drop function if exists public.supabash_load_workspace(uuid, text);
drop function if exists public.supabash_create_workspace();
drop function if exists public.supabash_exchange_capability(text);
drop function if exists public.supabash_revoke_capability_verifier(text);
drop function if exists public.supabash_register_capability_verifier(text, text, text, text, text, integer, integer);

do $secrets$
begin
  if exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'supabash' and c.relname = 'capability_verifiers'
  ) then
    delete from vault.secrets
    where name in (select secret_name from supabash.capability_verifiers);
  end if;
exception when undefined_table or undefined_function or insufficient_privilege then
  raise notice 'Supabash capability secrets were left in the vault.';
end
$secrets$;

drop schema if exists supabash cascade;

do $role$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabash_api') then
    revoke all on schema public, extensions from supabash_api;
    revoke supabash_api from postgres;
    drop role supabash_api;
  end if;
end
$role$;

notify pgrst, 'reload schema';

commit;
