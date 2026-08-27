# Third-party notices

This project was developed with reference to and adapted source from the
following open-source projects.

## Files SDK

- Source: <https://github.com/haydenbleasel/files-sdk>
- Reviewed commit: `cd1095b8124385f09e57f2d2b713a39bbe602c24`
- Copyright: Copyright (c) 2026 Hayden Bleasel
- Licence: MIT

Files SDK was an architecture and implementation reference during the initial
package scaffold.

```
MIT License

Copyright (c) 2026 Hayden Bleasel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## filesystem-sdk

- Source: <https://github.com/uriafranko/filesystem-sdk>
- Reviewed commit: `1664aa8b63c78bb096fa1851ccbe76ffbb50235c`
- Copyright: Copyright (c) 2026 filesystem-sdk contributors
- Licence: MIT

filesystem-sdk was an architecture and implementation reference during the
initial package scaffold.

```
MIT License

Copyright (c) 2026 filesystem-sdk contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Just Bash

- Source: <https://github.com/vercel-labs/just-bash>
- Compatible package version during development: `3.4.2`
- Licence: Apache-2.0

## OpenAI Agents SDK applyDiff

- Source: <https://github.com/openai/openai-agents-js>
- Package: `@openai/agents-core` `0.16.1`
- Copied files:
  - `packages/agents-core/src/utils/applyDiff.ts`
  - `packages/agents-core/test/utils/applyDiff.test.ts`
- Reviewed commit: `56c3dfb15b91baa50d70dea12f7565cc69822494`
- Copyright: Copyright (c) 2025 OpenAI
- Licence: MIT

The V4A parser lives in `src/patch/apply-diff.ts` and the `src/patch/v4a-*.ts`
modules. Local adaptations are a file split for the source-size limit, strict
TypeScript guards for missing lines, and ESM named exports. The `applyDiff`
behavior matches the copied implementation.

```
MIT License

Copyright (c) 2025 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Tripwire

- Source: local design reference at development time
- Package observed during planning: `@seanmozeik/tripwire` `0.6.7`
- Licence: MIT

No Tripwire source was copied. The Bash command policy is new Deno-safe code
that reuses only the segment-then-independent-rule design. Effect, Bun.Glob,
and Tripwire's opinionated toolchain denies are not used.

Each third-party project remains under its own licence terms.
