/**
 * Copied from OpenAI Agents SDK (`@openai/agents-core` 0.16.1).
 * Upstream file: packages/agents-core/src/utils/applyDiff.ts
 * Upstream commit: 56c3dfb15b91baa50d70dea12f7565cc69822494
 * License: MIT, Copyright (c) 2025 OpenAI
 */

import type { Chunk, ParserState } from './v4a-types.js';

export const advanceCursorToAnchor = (
  anchor: string,
  inputLines: readonly string[],
  cursor: number,
  parser: ParserState,
  requireMatch = false,
  forceForwardSearch = false,
): number => {
  let found = false;
  let nextCursor = cursor;
  const hasExactMatchBeforeCursor =
    !forceForwardSearch && inputLines.slice(0, cursor).some((line) => line === anchor);

  if (hasExactMatchBeforeCursor) {
    found = true;
  } else {
    for (let index = cursor; index < inputLines.length; index += 1) {
      if (inputLines[index] === anchor) {
        nextCursor = index + 1;
        found = true;
        break;
      }
    }
  }

  if (!found) {
    const trimmedAnchor = anchor.trim();
    const hasTrimmedMatchBeforeCursor =
      !forceForwardSearch &&
      inputLines.slice(0, cursor).some((line) => line.trim() === trimmedAnchor);

    if (hasTrimmedMatchBeforeCursor) {
      found = true;
    } else {
      for (let index = cursor; index < inputLines.length; index += 1) {
        if (inputLines[index]?.trim() === trimmedAnchor) {
          nextCursor = index + 1;
          parser.fuzz += 1;
          found = true;
          break;
        }
      }
    }
  }

  if (requireMatch && !found) {
    throw new Error(`Invalid Anchor ${cursor}:\n${anchor}`);
  }

  return nextCursor;
};

export const findContext = (
  lines: readonly string[],
  context: readonly string[],
  start: number,
  eof: boolean,
): { newIndex: number; fuzz: number } => {
  if (eof) {
    const endStart = Math.max(0, lines.length - context.length);
    const endMatch = findContextCore(lines, context, endStart);
    if (endMatch.newIndex !== -1) {
      return endMatch;
    }
    const fallback = findContextCore(lines, context, start);
    return { newIndex: fallback.newIndex, fuzz: fallback.fuzz + 10_000 };
  }
  return findContextCore(lines, context, start);
};

export const applyChunks = (input: string, chunks: readonly Chunk[]): string => {
  const origLines = input.split('\n');
  const destLines: string[] = [];
  let origIndex = 0;

  for (const chunk of chunks) {
    if (chunk.origIndex > origLines.length) {
      throw new Error(
        `applyDiff: chunk.origIndex ${String(chunk.origIndex)} > input length ${String(origLines.length)}`,
      );
    }
    if (origIndex > chunk.origIndex) {
      throw new Error(
        `applyDiff: overlapping chunk at ${String(chunk.origIndex)} (cursor ${String(origIndex)})`,
      );
    }

    destLines.push(...origLines.slice(origIndex, chunk.origIndex));
    const { delLines, insLines, origIndex: nextIndex } = chunk;
    origIndex = nextIndex;

    if (insLines.length > 0) {
      destLines.push(...insLines);
    }

    origIndex += delLines.length;
  }

  destLines.push(...origLines.slice(origIndex));
  return destLines.join('\n');
};

const findContextCore = (
  lines: readonly string[],
  context: readonly string[],
  start: number,
): { newIndex: number; fuzz: number } => {
  if (context.length === 0) {
    return { newIndex: start, fuzz: 0 };
  }

  for (let index = start; index < lines.length; index += 1) {
    if (equalsSlice(lines, context, index, (value) => value)) {
      return { newIndex: index, fuzz: 0 };
    }
  }
  for (let index = start; index < lines.length; index += 1) {
    if (equalsSlice(lines, context, index, (value) => value.trimEnd())) {
      return { newIndex: index, fuzz: 1 };
    }
  }
  for (let index = start; index < lines.length; index += 1) {
    if (equalsSlice(lines, context, index, (value) => value.trim())) {
      return { newIndex: index, fuzz: 100 };
    }
  }

  return { newIndex: -1, fuzz: 0 };
};

const equalsSlice = (
  source: readonly string[],
  target: readonly string[],
  start: number,
  mapFn: (value: string) => string,
): boolean => {
  if (start + target.length > source.length) {
    return false;
  }
  return target.every((line, index) => {
    const candidate = source[start + index];
    return candidate !== undefined && mapFn(candidate) === mapFn(line);
  });
};
