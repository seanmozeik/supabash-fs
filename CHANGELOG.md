# Changelog

## 0.4.2

- Describe the supported compound Bash syntax in the shared AI SDK tool
  contract so every agent can use the native shell surface without host-specific
  prompt instructions.

## 0.4.1

- Let Just Bash resolve command substitutions, path substitutions, loop values,
  and process substitutions inside the scoped virtual filesystem. The command
  policy still inspects concrete nested commands, including `find -exec`, and
  blocks visible network, host, reserved-path, and destructive-root operations.
- Add one shared tool-facing filesystem view for Bash, Apply Patch, and image
  viewing. A host can present one workspace subtree as `/` and hide private
  roots while retaining the complete host workspace for commit and history.
- Expose detached committed Postgres snapshots. Staged edits remain separate
  until commit.
- Expose verified delegated-session details and let callers require an exact
  capability operation set before a database exchange or workspace load.
- Let a clean delegated read-only workspace discard as a no-op. Discarding
  staged changes still requires write permission.
- Normalize thrown Postgres transport failures as typed retryable errors. A
  lost commit response also records that its durable outcome is unknown.

## 0.4.0

- Parse Bash with Unbash before policy evaluation. Inspect pipelines,
  redirections, substitutions, literal variables, loops, conditionals,
  functions, heredocs, and grouped commands without treating ordinary compound
  Bash as unsupported. Unresolved words stay dynamic and fail closed.
- Keep command policy as a damage limiter. Workspace scoping and backend
  authorization remain the security boundary.
- Add a Postgres text-document codec contract and a YAML-frontmatter parser.
  Persist the UTF-8 body and flat scalar metadata separately. One canonical
  renderer, shared with SQL, projects the Markdown file into Just Bash.
- Include document metadata in immutable revision manifests, visible content
  hashes, diffs, historical reads, moves, restore, and atomic commits.
- Generate a portable `SUPABASH_TEST_RUN_ID` for live Postgres tests on macOS.
- Let hosts register explicit Just Bash commands through the AI SDK adapter.
  Custom commands keep normal pipes, redirections, compound syntax, workspace
  scoping, execution deadlines, and command-policy inspection.

## 0.3.0

- Add an explicit Postgres workspace backend behind the existing `Workspace`
  contract while preserving the Supabase Storage backend and import paths.
- Ship versioned install and removal SQL with FORCE RLS, execute-only RPC
  access, a non-login execution role, pinned snapshots, atomic compare-and-swap
  commits, complete immutable revision manifests, checkpoints, and retention.
- Define the Postgres backend as a UTF-8 text tree. Reject binary data, NUL,
  symbolic links, mode changes, and durable empty directories with typed errors.
- Keep Just Bash runtime paths out of user snapshots and mutations.
- Add database-verified delegated capability exchange for Postgres workspaces.
- Add optional privacy-safe operation events for snapshot, projection, commit,
  history, diff, checkpoint, revision, and purge work.
- Export the Postgres SQL assets and prove the packed package from Bun and Deno.
- Update `@seanmozeik/de-clank` to 0.1.8 and repair the stricter findings.

## 0.2.0

Agent workspace APIs on top of the authenticated Storage filesystem.

- Copy and adapt OpenAI's V4A `applyDiff` implementation, with a staged
  `applyPatch` executor for create, update, move, and delete.
- Add `@seanmozeik/supabash-fs/ai-sdk` with Bash, Apply Patch, and optional
  image-view tools bound to one workspace. The root export does not load AI SDK
  peers.
- Add a Deno-safe command policy inspired by Tripwire's design. It is a damage
  limiter, not an authorization boundary.
- Record immutable transactions and logical revisions on commit, with history,
  diff, readRevision, checkpoint, restore planning, and purge.
- Add Ed25519 delegated capabilities for trusted background jobs without
  weakening `Supabash.open`.
- Expose a stable commit/history cursor for later derived indexes.
- Prove mixed-tool, history, restore, and delegated isolation against a local
  Supabase Docker stack from Deno 2.
- Reopen dangling symbolic links without following their missing targets.
- Restore matches the target tree, including leftover uncommitted paths, and
  inspects symlink nodes with `lstat`.
- Delegated jobs bind commit actor/correlation to the capability, require
  `read` or `write` for filesystem access, and no longer take an unused
  publishable key.
- Nested `bash -c` scripts use the same command-policy evaluation as the outer
  command.
- Checkpoint names a revision and never publishes staged edits.
- History page size and diff preview limits are enforced. Commit probes
  existing content-addressed objects before downloading file bodies.
- Unknown history cursors fail instead of restarting at page 0.
- Restore rebuilds the live tree through the same installer as open/discard
  and stages the result against the current baseline.
- Open fast-forwards `head.json` when a later complete transaction exists.
- Diff emits truncated text previews for added, deleted, and modified files.
- Recover incomplete transactions to the prior head or initial snapshot before
  opening a workspace. Completed transactions publish the head last, and
  retries use a deterministic operation fingerprint.
- Reject reuse of an idempotency key for different changes or transaction
  context with `IDEMPOTENCY_CONFLICT`.
- Record moves and complete before-and-after hash, ETag, and size fields in
  receipts and reopened history.
- Order history by the published parent chain and return stable exact-end page
  cursors, including when commits have the same timestamp.
- Record restore provenance automatically on the next commit. Add host methods
  to list and release checkpoints so retention classes do not pin revisions
  forever.
- Purge stale idempotency records and recovered transaction markers while
  preserving all content referenced by retained or checkpointed revisions.
- Make each Apply Patch operation locally atomic, including implicit directory
  creation and moves that fail after the filesystem has changed.
- Return `{ tools, workspace }` from `createTools`, keep the workspace out of
  the AI SDK tool map, and emit AI SDK image-content output from `view_image`.
- Add a 30-second default Bash deadline and typed validation for workspace,
  patch, Bash, image, history, diff, and purge limits.
- Limit delegated capabilities to 15 minutes by default and consume replay
  nonces only after scope checks and Storage open succeed.
- Test the packed root and AI SDK exports in clean Bun consumers and Deno 2.
  Keep optional image support in a separate production chunk.
- Add before-and-after fault injection for every durable publish mutation,
  concurrent lease tests, in-flight history tests, and restore-after-recovery
  tests.
- Serialize open-time and partial-discard recovery through the optional
  per-scope coordinator so recovery cannot overtake an active coordinated
  commit.

## 0.1.0

Initial authenticated Supabase Storage filesystem for Just Bash.
