\set ON_ERROR_STOP on

drop function if exists public.supabash_test_register_verifier(text, text, text, text, text);
drop function if exists public.supabash_test_manifest_stats(uuid);
drop function if exists public.supabash_test_clear_commit_failure(uuid);
drop function if exists public.supabash_test_fail_next_commit(uuid);
drop schema if exists supabash_test cascade;

notify pgrst, 'reload schema';
