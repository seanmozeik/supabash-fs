# Changelog

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

## 0.1.0

Initial authenticated Supabase Storage filesystem for Just Bash.
