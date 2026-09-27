# Forgetting, retention, and restore fences

These redaction and fence APIs are available on `PostgresWorkspace` and
`DelegatedPostgresWorkspace`. Storage supports the retention floor and cursor
recovery options, but does not provide atomic redaction or a SQL restore fence.

## API

```ts
interface RedactOptions {
  paths?: readonly string[];
  bodyHashes?: readonly string[];
  before?: string;
  dryRun?: boolean;
  reason?: string;
  metadataKeys?: readonly string[];
  clearCause?: boolean;
}
interface RedactReceipt {
  redactionId: string;
  revisions: readonly string[];
  bodies: readonly string[];
  bytes: number;
  dryRun: boolean;
}

workspace.redact(options: RedactOptions): Promise<RedactReceipt>;
workspace.restoreFloor(): Promise<string | null>;
workspace.purge(options: {
  dryRun?: boolean;
  maxAgeMs?: number;
  maxRevisions?: number;
  keepAfterRevision?: string;
}): Promise<PurgeReceipt>;
workspace.history(query?: {
  cursor?: string;
  limit?: number;
  cursorMissing?: 'error' | 'oldest';
}): Promise<HistoryPage>;
```

Paths are exact canonical file paths, not directory prefixes or globs. Paths and
stored **body** hashes form a union, not an intersection. With frontmatter codecs,
`bodyHash` differs from the rendered document's `contentHash`.

`before` is exclusive and defaults to the current head. Redaction preserves the
current tree and revisions at or after this boundary. Commit the edited/deleted
files first, then redact their older versions. There is no substring replacement:
redacting a path makes the entire historical document unavailable.

```ts
const forgotten = await workspace.commit();
const options = {
  paths: ['/memories/preferences.md'],
  before: forgotten.revision,
  metadataKeys: ['summary'],
  clearCause: true,
  reason: 'user-requested-forget',
};
const preview = await workspace.redact({ ...options, dryRun: true });
const applied = await workspace.redact(options);
```

Non-current matching entries point to the workspace's empty-body tombstone with
`metadata.redacted = true`. The redacted marker is reserved for this purpose.
Intervals shared with retained revisions are split at the boundary. Legacy
manifests are rewritten in place. Document metadata on tombstoned entries is
replaced too, because frontmatter can contain forgotten text.

`revisions` lists selected historical revisions; `bodies` and `bytes` describe
original body rows actually reclaimed (or reclaimable in a dry run), not the
number or size of affected manifest entries. A body still referenced by another
retained entry remains stored. If a selected original body is still current at
any path not explicitly included in `paths`, redaction fails with
`REDACTION_CURRENT_BODY`. Include that path only when retaining its current
content is intentional, or edit/delete it first. A path-only redaction does not
promise workspace-wide erasure of copies at other paths. Use body hashes to
select all historical copies of known stored bodies.

`metadataKeys` removes top-level revision metadata keys from selected revisions.
When no path/hash selectors are supplied, it applies to all revisions before the
boundary. `cause` is text, so `clearCause: true` clears the entire field; it is not
parsed as JSON or searched for substrings. The current revision's metadata is
outside this operation's historical range. If it contains sensitive metadata,
commit a clean new revision, then scrub the older revision. `reason` is audit
text: do not put forgotten content in it.

Dry runs execute the same mutation and FK checks in a rolled-back subtransaction;
they leave no body, manifest, metadata, fence, or audit changes. Their generated
`redactionId` is a preview identifier, not an applied event. A subsequent apply
can differ if another transaction changes the workspace. Applied requests each
record an event; repeating a request is safe but does not reuse an event ID.

## Read and restore guarantees

SQL snapshots and diffs expose tombstones as `kind: 'unavailable'`. Diffs involving
one suppress previews, including when both sides are tombstones. Stored change
previews for affected paths are removed. Historical body fetches fail with
`SUPABASH_REDACTED`. TypeScript `readRevision` rejects the whole view with
`SupabashError.code === 'REDACTED'`, including views behind the restore fence. It
does not silently turn unavailable documents into empty files or a partial tree.

Every full-tree restore touches all paths, including paths absent from the target
that it would delete. Therefore `supabash_load_revision` rejects any target older
than the latest path redaction boundary with
`SUPABASH_RESTORE_CROSSES_REDACTION`; `Workspace.restore` exposes the corresponding
`RESTORE_CROSSES_REDACTION` code. Equality with the boundary is allowed. Metadata-only
redactions do not create a path fence. `restoreFloor()` returns the latest boundary
revision ID, or null. UUIDs are identifiers, not sortable revision positions.

Fence events retain their numeric position even when the boundary revision is
purged. The returned floor ID may therefore no longer be loadable. SQL remains
authoritative; callers must not infer permission from a missing floor record.
The fence is checked again under the workspace lock when committing a restore
with `p_source_revision`, preventing a restore staged before redaction from being
committed afterward. Custom restore implementations must also submit their source
revision at commit; arbitrary writes containing previously read text cannot be
recognized as restores automatically.

All mutation work uses the same workspace advisory lock as commit and purge.
Authorization precedes workspace reads, and RLS remains forced under the
`supabash_api` security-definer role. Delegated redaction needs the distinct
`redact` operation; `purge`, `history`, and `restore` do not imply it. Floor reads
require `history` or `restore`. No grant can redact another workspace.

Redaction removes content from the active database's historical API and deletes
unreferenced body rows. It cannot revoke already returned views, client caches,
exports, backups, WAL, or arbitrary copies in other files/metadata fields. Hashes,
transaction fingerprints, and nonselected audit fields are not erased. Checkpoints
protect revisions from purge, not from redaction.

## Retention

`keepAfterRevision` protects the floor itself and every newer revision, overriding
both age and count deletion criteria. An unknown or foreign floor fails closed
with `REVISION_NOT_FOUND`. Head and checkpoint protections remain in force. Storage
requires its floor on the retained head chain; Postgres uses durable revision
order, including retained revisions separated by purge gaps.

`cursorMissing: 'oldest'` explicitly restarts from the oldest retained revision
when a cursor is unknown or purged. The default remains strict. Postgres history
uses durable order across purge gaps so isolated checkpointed revisions remain
visible. A restarted consumer must tolerate replay. A retained record's parent
can still be purged: callers should handle `REVISION_NOT_FOUND` when diffing that
parent, and `unavailable` diff entries after redaction.

## Installation and upgrade

Fresh databases apply `0001_install.sql`, `0002_lazy_reads.sql`,
`0003_versioned_entries.sql`, then `0004_redact_retention.sql`. Existing 0.7.0
installations apply **only** `0004_redact_retention.sql`. It is transactional and
idempotent, preserves existing data, and notifies PostgREST to reload its schema.
It takes an exclusive workspace-table lock while installing, so schedule the
upgrade accordingly. `0001_remove.sql` removes the new public functions and schema.

New SQL RPCs (all return JSONB):

```sql
public.supabash_redact(
  p_workspace_id uuid,
  p_paths text[] default null,
  p_body_hashes text[] default null,
  p_before_revision uuid default null,
  p_dry_run boolean default false,
  p_reason text default null,
  p_metadata_keys text[] default null,
  p_clear_cause boolean default false,
  p_delegated_grant text default null
)
public.supabash_restore_floor(
  p_workspace_id uuid, p_delegated_grant text default null
)
```

`supabash_purge` appends `p_keep_after_revision uuid default null` after the
existing grant argument. `supabash_history` appends
`p_cursor_missing text default 'error'` after its existing grant argument. The old
signatures are replaced, avoiding ambiguous PostgREST overloads; existing calls
can omit the new arguments. Snapshot, diff, load, capability exchange, and commit
functions are replaced with compatible signatures. The migration adds
`supabash.redactions` and legacy revision ordering metadata.

The live suite applies the upgrade twice to populated legacy/versioned data,
checks preservation and redaction, and removes it afterward. It then installs a
fresh schema for the HTTP, capability, and restore tests.
