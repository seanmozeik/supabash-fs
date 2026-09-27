# Compression removal audit

Audited dependency: `just-bash@3.4.2`, exported JavaScript
`dist/bundle/browser.js`. It is a minified prebundle. The local identifiers below
refer to that exact installed artifact; `tests/policy/compression-source.test.ts`
pins its zlib imports and operation sites so a dependency change requires review.

## Complete zlib call-site inventory

The browser file has exactly two `node:zlib` import statements:

```js
import { gunzipSync as bx } from 'node:zlib';
import { constants as Cf, gunzipSync as pv, gzipSync as hv } from 'node:zlib';
```

There is one call to each imported function, three operation sites in total.

| Site                           | Call chain and trigger                                                                  | Policy block                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Ky` calls `hv` (`gzipSync`)   | `gzip` → `kf` → `t6` → `Ky`; file, stdin, stdout and recursive compression paths        | All `gzip` invocations: `compression-unsupported`                                                              |
| `vf` calls `pv` (`gunzipSync`) | `kf` → `t6` → `vf` for file/stdin decompression; `kf` → `Sv` → `vf` for integrity tests | All `gzip`, `gunzip`, `zcat` invocations, including `gzip -d`, `--decompress`, `--uncompress`, `-t` / `--test` |
| `Nx` calls `bx` (`gunzipSync`) | `rg` → `Ox` → `Nx`, guarded by `searchZip`, a `.gz` path and gzip magic bytes           | `rg -z`, `--search-zip` and short-flag clusters that enable `z`                                                |
| `Zy` reads `Cf` constants      | Compression-level selection inside the gzip execution path                              | All `gzip` invocations; import-safe numeric constants remain in the stub                                       |

`searchZip` defaults to false. Its only enabling options in the upstream parser
are `z` and `--search-zip`. No extension auto-detection enables compressed search.
`rg --pre` is an additional indirect route: `Nx` can call `ctx.exec` on the supplied
preprocessor without Supabash's top-level preflight. All `--pre` and `--pre=...`
uses are therefore denied, including custom script paths. `--pre-glob` alone
cannot launch a preprocessor and remains allowed.

The policy distinguishes flags from option values. For example, `rg -ez file`
and `rg -e -z file` use a literal pattern and remain allowed; `rg -nez pattern
file` activates compression in Just Bash and is denied. The scanner follows the
upstream parser's leading value options and its unusual short-cluster handling.
`--search-zip=...` is conservatively denied too, although this Just Bash version
does not accept a value for that boolean option.

`gzip` and `gunzip` were removed from the allow list. `zcat` was already absent;
it now gets the same explicit typed denial. `extraAllowCommands` cannot re-enable
these built-ins. The compression check runs before the allow-list check and covers
path-qualified command names too. Existing traversal covers wrapper commands,
static nested shell scripts, `find -exec`, substitutions, bound variables,
functions and literal loops. The focused tests exercise these routes; built
smoke checks exercise the resulting tool denial (`exitCode: 126`) in Bun and Node.

No other browser-build command calls zlib. In particular, `file` probes compressed
formats using the web-standard `DecompressionStream`; it does not use these
imports. There is no tar command registration in this version's browser build.
No other command or flag was removed on speculation.

## Scope of the policy proof

The call-site table proves the directly inspectable routes. The existing policy
explicitly defers unresolved runtime command names, option expansions and generated
scripts to the scoped Bash interpreter (`tests/policy/adversarial.test.ts`). For
example, `compressor=$(printf gzip); $compressor` is not statically denied. This
existing behavior is retained, so there is no claim that static policy inspection
can prove all dynamically generated programs compression-free. A host-supplied
replacement policy can also bypass preflight entirely.

The published bundle still cannot use host zlib: both imports resolve to
`scripts/build/blocked-zlib.ts`. Its `gzipSync` and `gunzipSync` throw
`Compression is not supported in Supabash.` The built smoke check verifies this
backstop with raw `Bash` and a dynamic command name. Just Bash catches compression
errors; gzip/gunzip return them as command failures, while `rg` catches read errors
and may skip the file. Thus callers that bypass the default preflight must not
expect a typed policy result. Neither route performs zlib compression.

The build allow-list and emitted-import scan reject **every** `node:*` import and
any external package other than the declared peers. The stub has no runtime
imports. Source-only repository checks use the development Just Bash package;
the alias applies to every published entry through tsdown.

## Model-facing description: zero bytes changed

The description optionally lists discovered names from bash-tool 1.3.19's fixed
known-tool set. That set contains none of `gzip`, `gunzip`, `zcat`, or `rg`.
For an InMemoryFs, the exact existing line remains:

```text
Available tools: awk, cat, column, comm, cut, diff, expand, find, fold, grep, head, html-to-markdown, join, jq, nl, od, paste, printf, rev, sed, sort, split, strings, tail, tee, tr, unexpand, uniq, wc, xargs, and more
```

For a Storage workspace without bin directories, the available-tools line remains
absent. The complete description, scoped-root instructions, input schema and tool
name remain byte-identical. The permanent model-surface fixtures are unchanged.
The shell's own `help` output is separate from the tool definition and still sees
upstream command registrations; calling a removed command through the tool is
denied by policy.
