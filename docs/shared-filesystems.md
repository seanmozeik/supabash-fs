# Shared files and private workspaces

Supabash 0.6 separates the filesystem presented to an agent from the workspaces
that the host commits. One tool filesystem can contain private writable memory,
shared documentation and shared knowledge. Each backing workspace retains its
own authorization, revisions, restore and purge operations.

Read-only is an access rule on the agent's mount. The publishing host retains
full control of the original files.

## Mount private memory and shared documentation

Open the user's workspace through its verified JWT or a delegated capability.
Open the shared collection through a separately authorized publisher or reader.
Use an explicit published revision for the shared snapshot:

```ts
import { createMountedFileSystem, readWorkspaceSnapshot } from '@seanmozeik/supabash-fs';
import { createTools } from '@seanmozeik/supabash-fs/ai-sdk';

const documentation = await readWorkspaceSnapshot({
  workspace: documentationReader,
  sourceId: 'app-docs',
  revision: publishedDocumentationRevision,
});

const mounted = createMountedFileSystem([
  {
    mountPoint: '/memories',
    access: 'read-write',
    sourceId: userWorkspaceId,
    workspace: userWorkspace,
    view: { hiddenRoots: ['/.internal'] },
  },
  { mountPoint: '/docs', access: 'read-only', snapshot: documentation },
]);

const { tools } = await createTools({ filesystem: mounted.fs });
// Run the agent using tools, then validate the private changes.
const receipt = await userWorkspace.commit();
```

`documentationReader` and `userWorkspace` are already-authorized handles. Mount
configuration is trusted host configuration. Source IDs are labels for provenance;
they confer no authority. The agent receives neither handles nor credentials.

The same immutable `documentation` object can be reused across authorized users
in one host process. Durable source files remain in one shared collection. An
agent sees `/memories/note.md`, while the private workspace still stores `/note.md`.
Existing stored paths and receipt history can remain in place.

The host still addresses `userWorkspace.fs` in its original path namespace. Tools
address `mounted.fs` in the visible namespace. The mounted object exposes no
combined commit, restore or purge method. Multiple writable mounts have separate
commit boundaries; there is no distributed transaction across them.

## Publish, update and delete shared files

Use a publisher identity that owns the shared Postgres workspace, or a delegated
writer authorized for that exact workspace. `Supabash.openPostgres` preserves the
normal owner check. A user's private JWT does not gain access to shared storage
merely because a host later mounts a snapshot.

Provision a collection once with `Supabash.createPostgresWorkspace` under the
publisher's verified request, and retain the returned workspace ID in host
configuration. Reopen that same ID for subsequent publications:

```ts
import { Supabash } from '@seanmozeik/supabash-fs';

const publisher = await Supabash.openPostgres({
  workspace: sharedWorkspaceId,
  request: publisherRequest, // Contains the publisher identity's bearer token.
  publishableKey,
  supabaseUrl,
});
```

The publisher uses the existing filesystem and commit API:

```ts
await publisher.fs.mkdir('/guides', { recursive: true });

// writeFile creates a file or replaces its complete contents.
await publisher.fs.writeFile('/guides/calendar.md', '# Calendar\n\nUse the calendar tab.\n');
await publisher.fs.writeFile('/guides/medications.md', '# Medications\n\nRecord your schedule.\n');

// Read and update an existing file when the change depends on its contents.
const previous = await publisher.fs.readFile('/guides/calendar.md');
await publisher.fs.writeFile('/guides/calendar.md', `${previous}\nReminders are optional.\n`);

if (await publisher.fs.exists('/retired-guide.md')) {
  await publisher.fs.rm('/retired-guide.md');
}

const release = await publisher.commit({
  context: {
    actor: 'documentation-publisher',
    correlationId: publicationId,
    idempotencyKey: publicationId,
  },
});
if (release.status !== 'complete') {
  throw new Error('Complete publication recovery before selecting this revision.');
}
```

Apply Patch is also available to trusted publishing code through
`applyPatch(publisher, operation)`. Check its result before committing. The
publisher's document codec still applies: the default Postgres codec accepts
plain UTF-8 text; a configured frontmatter codec enforces its own metadata rules.
The Storage backend also supports binary assets.

For Postgres, the commit atomically publishes the staged document changes and
uses the existing revision conflict checks. On a conflict, reopen the workspace,
reapply the intended change to current content, and retry under the documented
commit/idempotency rules. Storage retains its existing partial-commit and recovery
contract. Require `release.status === 'complete'` before selecting that revision
for readers.

Store `release.revision` as the application's selected documentation release only
after the commit succeeds. That release pointer belongs to the application;
Supabash supplies immutable revision IDs. Use a guarded or compare-and-set pointer
update when more than one publisher can select a release. A commit that succeeds
before pointer selection leaves a valid unpublished revision that can be selected
later.

Keep the publisher's writable handle separate from the reader's snapshot. Updating
the publisher never mutates an existing snapshot. New turns load the newly selected
revision; turns already in progress keep their original snapshot.

## Read-only credentials and shared authorization

A Postgres publisher can issue a separate capability for the shared workspace
with `ops: ['read', 'history']`. Open it with
`Supabash.openPostgresDelegated({ capability, expectedOperations: ['read', 'history'],
serviceRoleKey, supabaseUrl })`, then call `readWorkspaceSnapshot` with the selected
revision. This uses the database-verified delegation flow described in the README.
The runtime reader requires no write, commit, restore or purge authority. Keep the
capability-signing secret in the trusted issuer.

Mount-level read-only checks also reject mutation when a trusted publisher handle
was used to construct the snapshot. The agent filesystem enforces the restriction
for Bash, Apply Patch and direct filesystem methods. Filesystem composition does
not broaden underlying database grants or provide a generic SQL query tool.

Detached snapshots retain their bytes after the load finishes. Capability expiry,
source deletion or revocation does not recall an in-memory copy. The host owns
cache lifetime and invalidation. Cache by authorized source, revision and content
digest; discard relevant cached snapshots when access is revoked or content must
be removed. Use shared snapshots only for content whose audience matches the users
receiving that mount.

## Mount rows from an existing table

A shared collection can come from your own table, API or release bundle. Read one
consistent version under the source's normal authorization, then adapt the rows:

```ts
import { createFileSystemSnapshot } from '@seanmozeik/supabash-fs';

const snapshot = await createFileSystemSnapshot({
  sourceId: 'condition-reference',
  revision: selectedReleaseId,
  files: rows.map((row) => ({ path: row.path, content: row.markdown })),
  limits: { maxFiles: 2_000, maxBytes: 8 * 1024 * 1024 },
});
```

This is a detached projection of the selected table version. To update it, upsert
or delete rows through the authorized publishing application, select the new
version, and construct a new snapshot. Supabash does not write through a read-only
mount into that table.

`SnapshotFile.content` accepts strings or `Uint8Array`. Strings are encoded as
UTF-8; byte arrays are copied. The factory rejects duplicate normalized paths,
file/directory collisions and invalid paths. Defaults are 10,000 files and 16 MiB
of file bytes per snapshot. The digest covers sorted paths and file bytes, so row
order does not affect it. Empty directories, symbolic links and filesystem modes
are not part of a shared snapshot. Workspace revision loading rejects symbolic
links and verifies file bytes against the retained size and content hash.

Snapshot files use mode `0444` and an unknown modification time represented by the
Unix epoch. Put meaningful publication dates in document content or application
release metadata; file modification time is not the publication date.

Snapshots are bounded, eager projections. Use a compact published collection for
agent filesystem reads, with a separate search service for a corpus that exceeds
the selected limits. The host should also bound the number and combined size of
mounts it supplies to one execution.

## Retrieval, context and links

Keep retrieval scoped to the correct backing source. Search personal memory in
the user's workspace and reference material in its shared collection. Compose
their paths for tools only after retrieving source-specific results:

```ts
const visiblePath = mounted.toVirtualPath('/memories', '/appointments.md');
// /memories/appointments.md

const source = mounted.toSourcePath('/docs/guides/calendar.md');
// { mountPoint: '/docs', sourceId: 'app-docs', path: '/guides/calendar.md' }
```

These functions honor an optional mount `view.root` and hidden paths. They translate
names; they do not establish that a file exists. Relative links within a collection
retain their meaning when mounted. Existing absolute links need updating to the
visible namespace, or explicit translation by the application that renders them.
Supabash does not rewrite document content or treat reference text as user memory.

Record `mounted.mounts` alongside the turn's private memory revision. Each read-only
descriptor includes its source ID, revision, content digest, mount point, source
root and hidden roots. Choose content-free IDs and paths for this manifest. The
manifest contains no document bodies, credentials or combined commit state.

## Restore, retention and deletion

To roll a documentation release back for future turns, select a retained older
revision in the application. To make that content the publisher's new current
head, restore and commit it as a forward transaction:

```ts
await publisher.restore(previousReleaseRevision);
const restored = await publisher.commit({
  context: {
    actor: 'documentation-publisher',
    correlationId: rollbackId,
    idempotencyKey: rollbackId,
  },
});
// Select restored.revision after a complete commit.
```

Retain revisions used by selected releases and any required replay window. Use
the workspace checkpoint and purge APIs under the publishing host's retention
policy. Release-pointer changes, checkpoints and commits are separate operations;
coordinate them in the publishing workflow.

Restoring, purging or deleting a user's backing workspace affects that user's
state. Shared collections have independent lifecycle and deletion policies.
Deleting a shared source does not modify private files to which an agent or host
previously copied reference content; copied files belong to their destination
workspace. Account deletion should invalidate the user's open sessions and cached
private state as usual.

## Filesystem boundaries

- Mount points are fixed for one composed view. They must be canonical, disjoint
  absolute paths outside `/dev`. Root and overlapping mounts are rejected.
- Unmounted paths and mount points are read-only. `/dev/null` is an empty sink.
- Cross-mount moves are rejected before the move. Explicit copies into a writable
  mount are supported; the copied file becomes private staged data.
- Links cannot be created through the composed view. Existing link targets remain
  subject to each source view's path checks.
- Directory operations that would affect hidden descendants are rejected. Hidden
  files stay available only through the host's original workspace handle.
- A mounted filesystem has no aggregate commit or restore. Validate and commit
  each backing writable workspace under its own lifecycle contract.
