/**
 * Copied from OpenAI Agents SDK (`@openai/agents-core` 0.16.1).
 * Upstream file: packages/agents-core/src/utils/applyDiff.ts
 * Upstream commit: 56c3dfb15b91baa50d70dea12f7565cc69822494
 * License: MIT, Copyright (c) 2025 OpenAI
 *
 * Types and parser constants for the V4A applyDiff implementation. Split from
 * the upstream file so this package stays under the source-size limit.
 */

export type Chunk = { origIndex: number; delLines: string[]; insLines: string[] };

export type ParserState = { lines: string[]; index: number; fuzz: number };

export const END_PATCH = '*** End Patch';
export const END_FILE = '*** End of File';

export const END_SECTION_MARKERS = [
  END_PATCH,
  '*** Update File:',
  '*** Delete File:',
  '*** Add File:',
  END_FILE,
] as const;

export const SECTION_TERMINATORS = [
  END_PATCH,
  '*** Update File:',
  '*** Delete File:',
  '*** Add File:',
] as const;

export const normalizeDiffLines = (diff: string): string[] =>
  diff
    .split(/\r?\n/u)
    .map((line) => line.replace(/\r$/u, ''))
    .filter((line, index, lines) => !(index === lines.length - 1 && line === ''));

export const isDone = (state: ParserState, prefixes: readonly string[]): boolean => {
  if (state.index >= state.lines.length) {
    return true;
  }
  const current = state.lines[state.index];
  return current !== undefined && prefixes.some((prefix) => current.startsWith(prefix));
};

export const readStr = (state: ParserState, prefix: string): string => {
  const current = state.lines[state.index];
  if (typeof current === 'string' && current.startsWith(prefix)) {
    state.index += 1;
    return current.slice(prefix.length);
  }
  return '';
};
