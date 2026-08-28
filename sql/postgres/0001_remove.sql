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

drop schema if exists supabash cascade;

do $role$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabash_api') then
    revoke all on schema public, extensions, pgsodium from supabash_api;
    revoke supabash_api from postgres;
    drop role supabash_api;
  end if;
end
$role$;

notify pgrst, 'reload schema';

commit;
