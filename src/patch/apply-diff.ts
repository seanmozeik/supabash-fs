/**
 * Copied from OpenAI Agents SDK (`@openai/agents-core` 0.16.1).
 * Upstream file: packages/agents-core/src/utils/applyDiff.ts
 * Upstream commit: 56c3dfb15b91baa50d70dea12f7565cc69822494
 * License: MIT, Copyright (c) 2025 OpenAI
 *
 * Applies a headerless V4A diff to the provided file content.
 * - mode "default": patch an existing file using V4A sections ("@@" + +/-/space lines).
 * - mode "create": create-file syntax that requires every line to start with "+".
 *
 * The function preserves trailing newlines from the original file and throws when
 * the diff cannot be applied cleanly.
 *
 * Intentional local differences from upstream:
 * - the implementation is split across v4a-* modules for the source-size limit;
 * - TypeScript is strict (`noUncheckedIndexedAccess`) so missing lines are guarded;
 * - named ESM exports replace the upstream default-style function module.
 * Behavior of applyDiff itself is preserved.
 */
import { applyChunks } from './v4a-context.js';
import { parseCreateDiff, parseUpdateDiff } from './v4a-parse.js';
import { normalizeDiffLines } from './v4a-types.js';

export type ApplyDiffMode = 'create' | 'default';

export const applyDiff = (input: string, diff: string, mode: ApplyDiffMode = 'default'): string => {
  const diffLines = normalizeDiffLines(diff);
  if (mode === 'create') {
    return parseCreateDiff(diffLines);
  }
  const { chunks } = parseUpdateDiff(diffLines, input);
  return applyChunks(input, chunks);
};
