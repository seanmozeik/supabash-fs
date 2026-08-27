# supabash-fs

`@seanmozeik/supabash-fs` mounts one verified Storage prefix as a lazy, writable
filesystem for [Just Bash](https://github.com/vercel-labs/just-bash). Agents
edit a staged in-memory tree. The host commits, inspects history, and restores.
No tool call publishes durable state by itself.

The package uses Supabase Storage as the durable file authority. It loads object
metadata when a workspace opens, downloads a file body on first read, stages
changes in memory, and writes changed objects plus an immutable revision when
the host commits.

The public API can still change before version 1.0.

## Architecture

One opened `Workspace` is the unit of work:

1. `Supabash.open` verifies a user bearer token and derives the object prefix
   from that user ID. Callers cannot supply a user ID, root, or prefix.
2. `Supabash.openDelegated` is a separate trusted-host path. It verifies a
   short-lived Ed25519 capability and mounts only the signed prefix.
3. `workspace.fs` is a Just Bash `IFileSystem`. Bash, Apply Patch, and optional
   image inspection all use this same staged tree.
4. `commit` publishes staged edits, writes content-addressed history under
   `.supabash/`, and returns an immutable transaction receipt.
5. `checkpoint`, `history`, `diff`, `readRevision`, `restore`, and `purge` are
   host APIs. They are not model tools.

Authorization is not command-string filtering. The real boundaries are the
virtual filesystem, canonical path checks, the verified user or capability,
the fixed bucket, and Storage RLS. The command policy is a damage limiter.

The root export does not load `ai`, `@ai-sdk/openai`, or `bash-tool`. AI SDK
tools live on `@seanmozeik/supabash-fs/ai-sdk`.

## Install

```sh
bun add @seanmozeik/supabash-fs just-bash
```

`just-bash` is a peer dependency. `ai`, `@ai-sdk/openai`, and `bash-tool` are
optional peers for the AI SDK export. The package does not use Effect or a
Node.js filesystem.

Deno 2 can load the package through npm compatibility:

```ts
import { Supabash } from 'npm:@seanmozeik/supabash-fs';
import { Bash } from 'npm:just-bash/browser';
```

When `deno run` uses a restricted environment allow-list, also allow reads of
`__MINIMATCH_TESTING_PLATFORM__`. Just Bash's pattern-matching dependency reads
that name during import. The variable does not need a value.

## Configure Supabase

Create a private Storage bucket. The examples in this document use `workspaces`.

Apply the four policies in
[`examples/storage-policies.sql`](./examples/storage-policies.sql). Change the
bucket name in that file if you use a different name.

The policies allow an authenticated user to access only object names whose
first path segment is that user's Supabase Auth ID. Keep these policies even if
the package runs only in server functions. Package path checks and Storage RLS
are separate security barriers.

The package needs all four object operations:

- `SELECT` for list, file information, download, and upsert checks.
- `INSERT` for new objects.
- `UPDATE` for object replacement through upsert.
- `DELETE` for removed files and replaced entry types.

Do not make the bucket public. Do not pass a service-role key to
`Supabash.open`. Delegated access is a separate API with its own trust
boundary, documented below.

## Open a user workspace

Pass the incoming request, the Supabase URL, the publishable key, and the
bucket name. The request must contain the user's bearer access token.

```ts
import { Supabash } from '@seanmozeik/supabash-fs';
import { Bash } from 'just-bash/browser';

export const runCommand = async (
  request: Request,
  command: string,
  config: { publishableKey: string; supabaseUrl: string },
) => {
  const workspace = await Supabash.open({
    bucket: 'workspaces',
    publishableKey: config.publishableKey,
    request,
    supabaseUrl: config.supabaseUrl,
  });

  const bash = new Bash({ cwd: '/', fs: workspace.fs });
  const result = await bash.exec(command);

  if (result.exitCode !== 0) {
    await workspace.discard();
    return { result };
  }

  const receipt = await workspace.commit({
    context: { actor: 'workspace', correlationId: crypto.randomUUID() },
  });
  return { receipt, result };
};
```

Use `just-bash/browser` in edge runtimes. It excludes commands that need
Node.js or an operating-system filesystem.

`Supabash.open()` does this work before it lists Storage objects:

1. It accepts only a Supabase publishable key or a legacy anon key.
2. It reads one bearer token from the supplied `Request`.
3. It rejects a user token with the `service_role` claim.
4. It calls `supabase.auth.getUser(token)` to verify the session.
5. It derives the object prefix from the verified user ID.

The API does not accept a user ID or an object prefix. Extra caller properties
cannot select a different root. Every Storage call uses the user's bearer
token, so the configured RLS policies also check each operation.

## Writable Bash and Apply Patch

Normal file edits inside the mounted root are allowed: redirection, `sed`,
`mv`, `rm`, `mkdir`, and similar Just Bash commands. The host still decides
when those staged edits become durable.

```ts
import { applyPatch, Supabash } from '@seanmozeik/supabash-fs';
import { Bash } from 'just-bash/browser';

const workspace = await Supabash.open({
  bucket: 'workspaces',
  publishableKey,
  request,
  supabaseUrl,
});

const bash = new Bash({ cwd: '/', fs: workspace.fs });
await bash.exec(String.raw`printf 'alpha\n' > /notes.md`);

const patched = await applyPatch(workspace, {
  diff: '-alpha\n+beta\n',
  path: '/notes.md',
  type: 'update_file',
});

if (patched.status !== 'completed') {
  await workspace.discard();
} else {
  await workspace.commit();
}
```

`applyPatch` supports `create_file`, `update_file` with optional `moveTo`, and
`delete_file`. Paths go through the same canonical parser as the filesystem.
A failed operation does not leave a partial local mutation. Batches default to
all-or-nothing; pass `{ mode: 'ordered' }` to keep earlier successful edits.

Apply Patch never calls `commit`. Bash never calls `commit`.

## AI SDK tools

```ts
import { createTools } from '@seanmozeik/supabash-fs/ai-sdk';

const tools = await createTools({
  workspace,
  bash: { policyOptions: { allowNetwork: false } },
  applyPatch: true,
  viewImage: { enabled: false },
});
```

The factory binds tools to an already-open workspace. It does not open a
second filesystem and does not commit after a tool call. Tool descriptions
state that the root is already scoped. The model cannot select a bucket, user,
prefix, access token, or storage client.

Optional `view_image` reads only from `workspace.fs`, allowlists image MIME
types, enforces a byte limit before decoding, and rejects symbolic-link
escapes. It is loaded only when `viewImage.enabled` is true.

Tool text is truncated with a stable `\n[truncated]\n` marker. Errors and
outputs redact bearer tokens, signed URLs, and secret-looking keys.

`bash-tool` does not expose a typed preflight hook, so the AI SDK adapter
wraps `execute` and inspects the command first. That is a damage limiter, not
an authorization boundary.

This package does not compact model context. Context management belongs to the
AI runtime.

## Command policy

```ts
import { createCommandPolicy } from '@seanmozeik/supabash-fs';

const policy = createCommandPolicy({
  allowNetwork: false,
  extraDenyCommands: ['reboot'],
  inspectors: [
    {
      inspect: (command) =>
        command.includes('prod-secret')
          ? { allow: false, code: 'custom-deny', reason: 'Blocked by host policy.' }
          : { allow: true },
    },
  ],
});
```

The default policy allows ordinary in-root work and denies or bounds:

- paths outside the virtual root or reserved `.supabash` segments
- recursive operations whose target is the mounted root
- excessive command length, pipeline depth, or segment count
- network commands when network is disabled
- host-process escapes and unsupported syntax that cannot be inspected

Do not treat command-string filtering as the security boundary.

## Revisions, recovery, and retention

```ts
const staged = workspace.changes();
const marker = await workspace.checkpoint({ label: 'safe' });
const receipt = await workspace.commit({
  context: { actor: 'host', correlationId: 'job-1', idempotencyKey: 'job-1' },
});
const page = await workspace.history({ limit: 20 });
const diff = await workspace.diff({
  from: { checkpoint: marker.checkpointId },
  to: { staged: true },
});
const previous = await workspace.readRevision(marker.revision);
const plan = await workspace.restore(marker.revision);
await workspace.commit({
  context: {
    actor: 'host',
    correlationId: 'restore-1',
    metadata: { sourceRevision: plan.sourceRevision },
  },
});
await workspace.purge({ dryRun: true, maxRevisions: 50 });
```

- `changes` returns the current staged set without a durable write.
- `checkpoint` names the current complete revision. It does not publish staged
  edits unless `commitStaged: true`.
- `commit` publishes staged changes and returns an immutable receipt.
- `discard` drops uncommitted changes only.
- `history` reads committed transactions with cursor pagination.
- `diff` compares two committed revisions, a checkpoint, or staged state.
- `readRevision` returns a read-only historical view.
- `restore` stages a forward change set. It does not commit.
- `purge` never makes a retained revision unreadable and can dry-run.

Visible files stay in their filesystem paths. History lives under a private
namespace that the virtual filesystem cannot list, read, write, move, link, or
delete:

```text
<verified-scope>/
  notes.md
  .supabash/
    objects/<sha256>
    revisions/<revision>.json
    transactions/<transaction>/intent.json
    transactions/<transaction>/complete.json
    checkpoints/<checkpoint>.json
    head.json
```

The path parser reserves `.supabash` and `.supabash-directory`. Storage
listings filter the private namespace before constructing filesystem entries.

A retry with the same idempotency key does not create a second logical
transaction. Restore creates a new forward transaction when the host commits
it. It never rewrites earlier history.

## Storage consistency

Supabase Storage does not provide an atomic multi-object transaction or a
conditional compare-and-swap write. This package does not claim atomic
revision publish.

The write sequence is:

1. freeze staged mutation and hash uploads
2. conflict-check changed paths
3. write an intent record
4. upload visible objects and delete removed paths
5. write content-addressed bodies, the revision manifest, and complete.json
6. update `head.json` last

A network failure can stop the sequence after some uploads. The last complete
revision remains readable. Retry `commit()` on the same workspace after a
transient failure. A lost optional commit lease fails with
`COMMIT_COORDINATION` before a complete revision is published.

When no coordinator is supplied, a check-to-write race remains. Another writer
can change an object between conflict preflight and upload. Applications that
need strict per-scope serialization should supply a `CommitCoordinator`:

```ts
interface CommitCoordinator {
  readonly acquire: (input: {
    readonly scope: string;
    readonly transactionId: string;
  }) => Promise<{
    readonly lost: () => Promise<boolean>;
    readonly release: () => Promise<void>;
  }>;
}
```

The package does not require Postgres. A caller can implement the coordinator
with a database lock, queue, Durable Object, or another system.

## Indexing feed

Commit receipts and history records expose a stable cursor for later text,
vector, or graph indexes. Those indexes are not an authority and are not
implemented here.

Each receipt includes logical revision, parent revision, transaction ID, opaque
scope digest, changed paths, change kinds, content hashes, entry kinds,
committed time, actor, cause, correlation ID, schema version, and `cursor`.

An indexer should:

1. read only committed transactions through `history({ cursor })`
2. fetch new bodies through the scoped read API or `readRevision`
3. ignore uncommitted state
4. resume from `receipt.cursor` / `record.cursor`
5. treat restore as a normal forward transaction
6. rebuild from one retained revision when needed

## Delegated access

Trusted background jobs can open one scoped workspace when no live user JWT
exists. This is not `openAsUser`. The host signs a compact Ed25519 JWS and
passes it to `Supabash.openDelegated`. Signing uses a `CryptoKey` private key.
Verification accepts one or more keyed public keys. Shared text secrets are
not accepted.

```ts
import {
  createDelegatedCapability,
  CAPABILITY_SCHEMA_VERSION,
  Supabash,
} from '@seanmozeik/supabash-fs';

const capability = await createDelegatedCapability({
  claims: {
    aud: 'supabash-jobs',
    bucket: 'workspaces',
    corr: 'job-1',
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    iss: 'https://example.invalid/issuer',
    nonce: 'job-1',
    ops: ['read', 'write', 'commit', 'history'],
    origin: supabaseUrl,
    prefix: userId,
    sub: 'job-1',
    sv: CAPABILITY_SCHEMA_VERSION,
  },
  keyId: 'k1',
  privateKey,
});

const workspace = await Supabash.openDelegated({
  bucket: 'workspaces',
  capability,
  publishableKey,
  serviceRoleKey,
  supabaseUrl,
  verifier: {
    audience: 'supabash-jobs',
    issuer: 'https://example.invalid/issuer',
    origin: supabaseUrl,
    publicKeys: { k1: publicKey },
    nonceStore,
  },
});
```

`openDelegated` options must never be passed to `createTools` or retained on
`Workspace`. The model and Just Bash never receive the signing key, the
service-role credential, or unverified claims.

The capability binds issuer, audience, subject, origin, bucket, exact prefix,
allowed operations, issued-at, expiry, nonce, correlation ID, and schema
version. Verification rejects expired tokens, future issued-at times outside
clock skew, the wrong issuer or audience, the wrong project, bucket, or
prefix, a changed subject, and an invalid signature. A host nonce store
prevents replay.

Storage RLS alone may not express this server-side delegation. After the
capability verifies, the package uses a trusted Supabase client clamped to the
signed prefix. That is a host trust boundary: anyone who can call
`openDelegated` with a valid capability and the service-role key can read and
write that prefix.

Threat model, in short:

- Changing the subject or prefix in a copied token fails signature checks.
- Copying a valid capability to another bucket or origin fails verification.
- A parent prefix is not implied by a child prefix.
- Expiry and optional nonce stores block stale or replayed jobs.
- A compromised model prompt cannot select a bucket, user, or credential.
- Tool input and output redact tokens, signed URLs, and capabilities.
- Cross-user history, diff, and restore fail because each workspace is scoped
  to one verified prefix.

## Options and limits

```ts
interface SupabashOptions {
  readonly bucket: string;
  readonly coordinator?: CommitCoordinator;
  readonly fetch?: typeof globalThis.fetch;
  readonly limits?: WorkspaceLimits;
  readonly maxFileSystemBytes?: number;
  readonly publishableKey: string;
  readonly request: Request;
  readonly supabaseUrl: string;
  readonly uploadConcurrency?: number;
}
```

Documented defaults:

| Limit | Default |
| --- | --- |
| `maxVisibleFiles` | 10_000 |
| `maxPathLength` | 1_024 |
| `maxFileSize` | 10_485_760 |
| `maxStagedBytes` | 52_428_800 |
| `maxPatchSize` | 1_048_576 |
| `maxCommandLength` | 32_768 |
| `maxBashOutput` | 262_144 |
| `maxToolExecutionMs` | 30_000 |
| `maxHistoryPageSize` | 100 |
| `maxDiffPreviewBytes` | 8_192 |
| `maxTransactionMetadataBytes` | 16_384 |
| `maxRevisions` purge hint | 50 |
| `uploadConcurrency` | 4 |

Limits fail before a durable mutation when possible and return a typed error.

## Errors

All package errors are `SupabashError` values:

| Code | Meaning |
| --- | --- |
| `AUTHENTICATION` | The bearer token is missing, malformed, or not verified. |
| `AUTHORIZATION` | A key, verified identity, bucket, or root is unsafe. |
| `COMMIT_CONFLICT` | A changed remote entry no longer matches the opened version. |
| `COMMIT_COORDINATION` | The optional commit lease was lost. |
| `COMMIT_IN_PROGRESS` | Code tried to mutate or commit an active commit. |
| `EXPIRED_CAPABILITY` | The delegated capability has expired. |
| `HISTORY_CORRUPTION` | A history record could not be parsed. |
| `INVALID_CAPABILITY` | The delegated capability is not acceptable. |
| `INVALID_PATCH` | The V4A patch could not be applied. |
| `INVALID_PATH` | A virtual path is unsafe or invalid. |
| `PARTIAL_COMMIT` | Remote writes stopped before a complete revision. |
| `POLICY_DENIED` | The command policy denied a Bash command. |
| `QUOTA_EXCEEDED` | A configured limit was exceeded. |
| `REVISION_NOT_FOUND` | The requested revision is missing. |
| `STORAGE` | A Supabase Storage operation failed. |
| `UNSUPPORTED_CONTENT` | The path or bytes cannot be used for this operation. |

`SupabashError.path` identifies the affected virtual path when one is
available. The original error is available through `error.cause`.

## Runtime and package size

The package builds for browser, Deno, and edge runtimes. It uses web-standard
`Request`, `fetch`, `crypto`, `Blob`, and encoding APIs. It imports Just Bash
from `just-bash/browser`.

Opening a workspace lists every object below the prefix. Regular file bodies
stay lazy. A very large object count increases open time.

The root bundle is tree-shakeable relative to the AI SDK export. Importing
`@seanmozeik/supabash-fs` must not resolve `ai`, `@ai-sdk/openai`, or
`bash-tool`. Import `@seanmozeik/supabash-fs/ai-sdk` only when those optional
peers are installed. `view_image` stays out of the AI SDK bundle until it is
enabled.

Just Bash is an in-process virtual shell. It does not start a container and
does not provide operating-system isolation.

## Development

Install Bun 1.4 and Deno 2, then install the pinned dependencies:

```sh
bun install --frozen-lockfile
```

```sh
just verify
just live
```

`just live` expects a local Supabase API at `SUPABASH_TEST_SUPABASE_URL` plus a
publishable key, service-role key, and two user tokens or emails. It creates
the `workspaces` bucket when needed and runs the Deno suite. Point those
variables at a Docker stack, not a hosted project.

The gate checks formatting, lint, TypeScript, source size, tests, the browser
build, Deno type resolution, production dependencies, and package contents.
This repository does not add CI.

## Licence

MIT. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for source and
dependency notices.
