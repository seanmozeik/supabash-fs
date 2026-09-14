begin;

-- PostgreSQL requires the new function owner to have CREATE on its schema.
-- The foundation removes this privilege after installation; restore it only
-- for the ownership transfer within this transaction.
grant create on schema public to supabash_api;

create function public.supabash_load_manifest(
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
        'path', e.path, 'bodyHash', e.body_hash, 'bodyByteSize', e.byte_size,
        'metadata', e.metadata, 'contentHash', e.content_hash, 'byteSize', e.content_byte_size
      ) order by e.path)
      from supabash.revision_entries e
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
  return v_result;
end
$function$;

create function public.supabash_load_document(
  p_workspace_id uuid,
  p_revision_id uuid,
  p_path text,
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
  if p_revision_id is distinct from (
    select head_revision from supabash.workspaces where id = p_workspace_id
  ) then
    perform * from supabash.authorize_workspace(p_workspace_id, array['history'], p_delegated_grant);
  end if;
  select jsonb_build_object(
    'path', e.path, 'body', b.body, 'bodyHash', e.body_hash, 'bodyByteSize', e.byte_size,
    'metadata', e.metadata, 'contentHash', e.content_hash, 'byteSize', e.content_byte_size
  ) into v_result
  from supabash.revision_entries e
  join supabash.bodies b on b.workspace_id = e.workspace_id and b.body_hash = e.body_hash
  where e.workspace_id = p_workspace_id and e.revision_id = p_revision_id and e.path = p_path;
  if v_result is null then
    raise exception using errcode = '22023', message = 'SUPABASH_REVISION_NOT_FOUND';
  end if;
  return v_result;
end
$function$;

create function public.supabash_load_pinned_snapshot(
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
  perform * from supabash.authorize_workspace(p_workspace_id, array['read'], p_delegated_grant);
  if p_revision_id is distinct from (
    select head_revision from supabash.workspaces where id = p_workspace_id
  ) then
    perform * from supabash.authorize_workspace(p_workspace_id, array['history'], p_delegated_grant);
  end if;
  v_result := supabash.snapshot_at(p_workspace_id, p_revision_id);
  if v_result is null then
    raise exception using errcode = '22023', message = 'SUPABASH_REVISION_NOT_FOUND';
  end if;
  return v_result;
end
$function$;

alter function public.supabash_load_pinned_snapshot(uuid, uuid, text) owner to supabash_api;
revoke all on function public.supabash_load_pinned_snapshot(uuid, uuid, text) from public, anon;
grant execute on function public.supabash_load_pinned_snapshot(uuid, uuid, text) to authenticated, service_role;

alter function public.supabash_load_manifest(uuid, text) owner to supabash_api;
alter function public.supabash_load_document(uuid, uuid, text, text) owner to supabash_api;
revoke create on schema public from supabash_api;
revoke all on function public.supabash_load_manifest(uuid, text) from public, anon;
revoke all on function public.supabash_load_document(uuid, uuid, text, text) from public, anon;
grant execute on function public.supabash_load_manifest(uuid, text) to authenticated, service_role;
grant execute on function public.supabash_load_document(uuid, uuid, text, text) to authenticated, service_role;

-- Bound waits for an occupied workspace while preserving the atomic revision check.
alter function public.supabash_commit(uuid, uuid, jsonb, jsonb, text, text, uuid, text, text, text, jsonb, uuid, text)
  set lock_timeout = '1s';
alter function public.supabash_checkpoint(uuid, text, text, text, text) set lock_timeout = '1s';
alter function public.supabash_purge(uuid, integer, bigint, boolean, text) set lock_timeout = '1s';

notify pgrst, 'reload schema';
commit;
