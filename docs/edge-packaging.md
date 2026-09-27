# Edge packaging

Every public JavaScript entry (`@seanmozeik/supabash-fs` and its `/ai-sdk`
subpath) targets Supabase Edge Functions (Deno). Bun and Node are also tested.
Supabash uses web-standard APIs; the published JavaScript has zero `node:*`
imports. Compression is unsupported: the policy denies `gzip`, `gunzip`, `zcat`,
`rg -z` / `--search-zip`, and `rg --pre` / `--pre=...`. A throwing `node:zlib`
alias prevents hidden or direct-shell compression calls from using a host built-in.
See the [compression call-site audit](compression-audit.md).

Install Supabash and `@supabase/supabase-js` (`>=2.112.1 <3`). AI tool consumers
also install `ai` (`>=7 <8`) and `@ai-sdk/openai` (`>=4 <5`). There are no runtime
npm dependencies. Zod is not imported by Supabash; AI peers manage their own
requirements. Remove direct `just-bash` and `bash-tool` dependencies if your
application used them only for Supabash.

```ts
import {
  Bash,
  defineCommand,
  InMemoryFs,
  type CustomCommand,
  type IFileSystem,
  type FsStat,
} from '@seanmozeik/supabash-fs';
```

Both JavaScript and declarations are bundled with tsdown. Shared chunks avoid
shipping duplicate shell implementations when both entries are used. Optional
image support remains a dynamic chunk. The build checks JavaScript and declaration
imports against local files and the three peers. Every `node:*` import fails
the build, including `node:zlib`.

Declaration checks also validate triple-slash `types` and `path` references and
external module augmentations. Local references must resolve to bundled files;
external references must name declared peers. A declaration-only adapter exposes
Just Bash's browser DNS transport interfaces without its internal Node test
helpers, which otherwise pull Undici's Node declarations into the browser bundle.
The core packed-consumer check compiles declarations with `skipLibCheck: false`,
no ambient type packages, and no `@types/node` installation. The optional AI SDK
peer's own declarations use Node types, so its separate consumer retains them.
All packed-consumer checks accept `--offline` for cache-only installation.

Just Bash 3.4.2 publishes its browser implementation as a single prebundle, with
no per-command JavaScript exports. tsdown can tree-shake exports and inline its
remaining external libraries, but cannot fully eliminate individual command
registrations without changing tool discovery. We alias `turndown` to a small
throwing constructor; this removes turndown and its @mixmark-io/domino dependency.
Only `html-to-markdown` constructs that converter in the upstream browser file.
The command is absent from `src/policy/commands.ts`'s default allow list. Policy
inspection rejects direct, wrapped, nested-shell and `find -exec` invocations;
the built smoke test covers these paths. No default-allowed command uses it.

Hosts can override policy or add `extraAllowCommands`. If they previously opted
into `html-to-markdown`, they must now supply a custom implementation. Raw `Bash`
also has no working built-in HTML converter. Command discovery still lists its
name to preserve the complete model-facing description. Other blocked command
registrations remain inside the upstream prebundle; no allowed command is stubbed.

The owned AI SDK bash tool preserves bash-tool 1.3.19's name, JSON schema and
complete description, including discovery order and scoped-root instructions.
It executes `cd "/" && <command>`, keeps Bash's default environment, returns only
`stdout`, `stderr`, `exitCode`, truncates each stream before redaction, and retains
policy inspection, custom commands and the configured execution deadline.

`deno.json` resolves the built package. `deno.check.json` resolves source and
therefore retains development mappings for Just Bash, YAML and Unbash. Consumers
need none of those mappings or Just Bash declaration files.
