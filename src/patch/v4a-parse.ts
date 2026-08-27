/**
 * Copied from OpenAI Agents SDK (`@openai/agents-core` 0.16.1).
 * Upstream file: packages/agents-core/src/utils/applyDiff.ts
 * Upstream commit: 56c3dfb15b91baa50d70dea12f7565cc69822494
 * License: MIT, Copyright (c) 2025 OpenAI
 */

import { advanceCursorToAnchor, findContext } from './v4a-context.js';
import { readSection } from './v4a-section.js';
import {
  END_PATCH,
  END_SECTION_MARKERS,
  isDone,
  readStr,
  SECTION_TERMINATORS,
  type Chunk,
  type ParserState,
} from './v4a-types.js';

export const parseCreateDiff = (lines: readonly string[]): string => {
  const parser: ParserState = { lines: [...lines, END_PATCH], index: 0, fuzz: 0 };
  const output: string[] = [];

  while (!isDone(parser, SECTION_TERMINATORS)) {
    const line = parser.lines[parser.index];
    parser.index += 1;
    if (line === undefined || !line.startsWith('+')) {
      throw new Error(`Invalid Add File Line: ${line ?? ''}`);
    }
    output.push(line.slice(1));
  }

  return output.join('\n');
};

export const parseUpdateDiff = (
  lines: readonly string[],
  input: string,
): { chunks: Chunk[]; fuzz: number } => {
  const parser: ParserState = { lines: [...lines, END_PATCH], index: 0, fuzz: 0 };
  const inputLines = input.split('\n');
  const chunks: Chunk[] = [];
  let cursor = 0;

  while (!isDone(parser, END_SECTION_MARKERS)) {
    const { anchors, anchorCount } = readAnchors(parser);

    if (!(anchorCount > 0 || cursor === 0)) {
      throw new Error(`Invalid Line:\n${parser.lines[parser.index] ?? ''}`);
    }

    const requireAnchorMatch = anchorCount > 1;
    for (const [index, anchor] of anchors.entries()) {
      cursor = advanceCursorToAnchor(
        anchor,
        inputLines,
        cursor,
        parser,
        requireAnchorMatch,
        index > 0,
      );
    }

    const { nextContext, sectionChunks, endIndex, eof } = readSection(parser.lines, parser.index);
    const nextContextText = nextContext.join('\n');
    const { newIndex, fuzz } = findContext(inputLines, nextContext, cursor, eof);

    if (newIndex === -1) {
      if (eof) {
        throw new Error(`Invalid EOF Context ${String(cursor)}:\n${nextContextText}`);
      }
      throw new Error(`Invalid Context ${String(cursor)}:\n${nextContextText}`);
    }

    parser.fuzz += fuzz;
    for (const chunk of sectionChunks) {
      chunks.push({ ...chunk, origIndex: chunk.origIndex + newIndex });
    }

    cursor = newIndex + nextContext.length;
    parser.index = endIndex;
  }

  return { chunks, fuzz: parser.fuzz };
};

const readAnchors = (parser: ParserState): { anchors: string[]; anchorCount: number } => {
  const anchors: string[] = [];
  let anchorCount = 0;
  let searching = true;

  while (searching) {
    const startIndex = parser.index;
    const anchor = readStr(parser, '@@ ');
    let consumed = parser.index !== startIndex;

    if (!consumed && parser.lines[parser.index] === '@@') {
      parser.index += 1;
      consumed = true;
    }

    if (consumed) {
      anchorCount += 1;
      if (anchor.trim() !== '') {
        anchors.push(anchor);
      }
    } else {
      searching = false;
    }
  }

  return { anchors, anchorCount };
};
