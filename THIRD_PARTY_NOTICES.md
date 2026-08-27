# Third-party notices

This project was developed with reference to and adapted source from the
following open-source projects.

## Files SDK

- Source: <https://github.com/haydenbleasel/files-sdk>
- Reviewed commit: `cd1095b8124385f09e57f2d2b713a39bbe602c24`
- Copyright: Copyright (c) 2026 Hayden Bleasel
- Licence: MIT

## filesystem-sdk

- Source: <https://github.com/uriafranko/filesystem-sdk>
- Reviewed commit: `1664aa8b63c78bb096fa1851ccbe76ffbb50235c`
- Copyright: Copyright (c) 2026 filesystem-sdk contributors
- Licence: MIT

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

Each third-party project remains under its own licence terms.
