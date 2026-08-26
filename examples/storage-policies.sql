-- Change 'workspaces' in every policy if the private bucket has another name.
-- Each virtual path is one object key below the verified user ID.

create policy "supabash workspace select"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'workspaces'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy "supabash workspace insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'workspaces'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy "supabash workspace update"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'workspaces'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'workspaces'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy "supabash workspace delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'workspaces'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
