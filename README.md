# supabash-fs

`supabash-fs` mounts one authenticated user's area of a private Supabase Storage
bucket as a lazy, writable filesystem for
[Just Bash](https://github.com/vercel-labs/just-bash).

The package uses Supabase Storage as the durable file store. It loads object
metadata when a workspace opens, downloads a file body on its first read, keeps
changes in memory, and writes changed objects when the caller commits.

The public API is in active development and can change before version 1.0.

## Install

```sh
bun add @seanmozeik/supabash-fs just-bash
```

`just-bash` is a peer dependency. The package does not use Effect or a Node.js
filesystem.

Deno can load the package through its npm compatibility layer:

```ts
import { Supabash } from 'npm:@seanmozeik/supabash-fs';
import { Bash } from 'npm:just-bash/browser';
```

When `deno run` uses a restricted environment allow-list, also allow reads of
`__MINIMATCH_TESTING_PLATFORM__`. Just Bash's pattern-matching dependency reads
that name during import. The variable does not need a value.

## Configure Supabase

Create a private Storage bucket. The examples in this document use the bucket
name `workspaces`.

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

Do not make the bucket public. Do not give this package a secret or service-role
key.

## Open and use a workspace

Pass the incoming request, the Supabase URL, the publishable key, and the bucket
name. The request must contain the user's bearer access token.

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

  const receipt = await workspace.commit();
  return { receipt, result };
};
```

Use `just-bash/browser` in edge runtimes. It excludes commands that need Node.js
or an operating-system filesystem.

### Use the filesystem with `bash-tool`

[`bash-tool`](https://github.com/vercel-labs/bash-tool) can use a configured
Just Bash instance as its sandbox.

```ts
import { Supabash } from '@seanmozeik/supabash-fs';
import { createBashTool } from 'bash-tool';
import { Bash } from 'just-bash/browser';

const workspace = await Supabash.open({
  bucket: 'workspaces',
  publishableKey,
  request,
  supabaseUrl,
});

const bash = new Bash({ cwd: '/', fs: workspace.fs });
const { tools } = await createBashTool({ destination: '/', sandbox: bash });

// Give tools.bash to the AI SDK call, then commit accepted filesystem changes.
const receipt = await workspace.commit();
```

`bash-tool` and the AI SDK are optional and are not package dependencies.

## Authentication and user scope

`Supabash.open()` does the following work before it lists Storage objects:

1. It accepts only a Supabase publishable key or a legacy anon key.
2. It reads one bearer token from the supplied `Request`.
3. It rejects a user token with the `service_role` claim.
4. It calls `supabase.auth.getUser(token)` to verify the session.
5. It derives the object prefix from the verified user ID.

The API does not accept a user ID or an object prefix. Extra caller properties
cannot select a different root. Every Storage call uses the user's bearer token,
so the configured RLS policies also check each operation.

## Storage layout

Visible files keep their filesystem paths below the verified user ID:

```text
workspaces/
  <verified-user-id>/
    notes.md
    projects                 # directory object
    projects/plan.md
    current                  # symbolic-link object
```

Each virtual path maps to one object key. Regular files store their file bodies.
Directories store an empty body and their entry type in metadata, which also
preserves empty directories. A symbolic link stores its target in its body and
metadata. Replacing an entry type overwrites the same object key.

The following custom metadata fields preserve filesystem state and support safe
commit retries:

- `supabash_content_hash`
- `supabash_kind`
- `supabash_mode`
- `supabash_modified_at`
- `supabash_target`
- `supabash_version_hash`

The virtual paths `.supabash` and `.supabash-directory` are reserved. The path
parser also rejects root traversal, control characters, backslashes, and encoded
separator or traversal syntax.

## Read and write model

Opening a workspace lists object metadata under the authenticated prefix. It
does not download regular file bodies. A first read downloads the body and keeps
it in the current in-memory filesystem. Concurrent first reads share one
download.

Filesystem operations are staged until `commit()` runs. A commit:

1. freezes filesystem mutation;
2. creates content and version hashes for changed entries;
3. checks each changed remote path for a conflict;
4. uploads changed entries with bounded concurrency;
5. deletes removed entries; and
6. returns a typed receipt.

```ts
interface CommitReceipt {
  readonly changes: readonly WorkspaceChange[];
  readonly committedAt: Date;
  readonly revision: string;
}
```

Each change records its virtual path, operation, entry type, and available hash
or ETag. A separate indexer or audit writer can consume these receipts without a
change to the filesystem interface.

Supabase Storage does not provide an atomic transaction across several objects.
A network failure can stop a commit after some uploads complete. The generated
version hash makes a retry recognize an upload that has already completed. Keep
the workspace object and retry `commit()` after a transient failure.

Conflict checks use an ETag when both remote versions have one. They use the
stored version hash next, then size and modification time. A change found during
this check returns `COMMIT_CONFLICT` before the package starts its writes.
Supabase Storage does not provide a conditional compare-and-swap operation for
these object writes. Another writer can still change an object between the
check and upload. Applications that need strict serialization must coordinate
writers above the workspace.

`link()` is available during one in-memory run. Each linked path is stored as a
separate object and reopens as an independent regular file because object
storage has no shared inode.

## Options

```ts
interface SupabashOptions {
  readonly bucket: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxFileSystemBytes?: number;
  readonly publishableKey: string;
  readonly request: Request;
  readonly supabaseUrl: string;
  readonly uploadConcurrency?: number;
}
```

- `fetch` supports tests and runtimes with a custom fetch implementation.
- `maxFileSystemBytes` sets the Just Bash in-memory filesystem limit.
- `uploadConcurrency` sets the number of parallel uploads. Its default is `4`.

## Errors

All package errors are `SupabashError` values with one of these codes:

| Code                 | Meaning                                                      |
| -------------------- | ------------------------------------------------------------ |
| `AUTHENTICATION`     | The bearer token is missing, malformed, or not verified.     |
| `AUTHORIZATION`      | A key, verified user ID, bucket, or storage root is unsafe.  |
| `COMMIT_CONFLICT`    | A changed remote entry no longer matches the opened version. |
| `COMMIT_IN_PROGRESS` | Code tried to mutate or commit an active commit.             |
| `INVALID_PATH`       | A virtual path is unsafe or invalid.                         |
| `STORAGE`            | A Supabase Storage operation failed.                         |

`SupabashError.path` identifies the affected virtual path when one is available.
The original error is available through `error.cause`.

## Runtime limits

The package builds for browser, Deno, and edge runtimes. It uses web-standard
`Request`, `fetch`, `crypto`, `Blob`, and encoding APIs. It imports Just Bash
from `just-bash/browser`.

The first version lists every object below the user prefix when a workspace
opens. Supabase list responses omit custom object metadata, so the package then
loads metadata for each object with bounded concurrency. Regular file bodies
stay lazy, but a very large object count increases open time and request count.
The change receipt is the stable extension point for a later catalog, full-text
index, or search service.

Just Bash is an in-process virtual shell. It does not start a container and does
not provide operating-system isolation. Review the commands and optional network
features that you enable.

## Development

Install Bun 1.4 and Deno 2, then install the pinned dependencies:

```sh
bun install --frozen-lockfile
```

Run the complete local gate:

```sh
just verify
```

The gate checks formatting, strict lint rules, TypeScript, source size, tests,
the browser build, Deno type resolution, production dependencies, and the
package contents.

## Licence

MIT. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for source and
dependency notices.
