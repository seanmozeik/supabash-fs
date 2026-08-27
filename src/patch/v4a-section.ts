/**
 * Copied from OpenAI Agents SDK (`@openai/agents-core` 0.16.1).
 * Upstream file: packages/agents-core/src/utils/applyDiff.ts
 * Upstream commit: 56c3dfb15b91baa50d70dea12f7565cc69822494
 * License: MIT, Copyright (c) 2025 OpenAI
 */

import { END_FILE, END_PATCH, type Chunk } from './v4a-types.js';

type LineMode = 'add' | 'delete' | 'keep';

interface SectionState {
  context: string[];
  delLines: string[];
  insLines: string[];
  mode: LineMode;
  sectionChunks: Chunk[];
}

export const readSection = (
  lines: readonly string[],
  startIndex: number,
): { nextContext: string[]; sectionChunks: Chunk[]; endIndex: number; eof: boolean } => {
  const state: SectionState = {
    context: [],
    delLines: [],
    insLines: [],
    mode: 'keep',
    sectionChunks: [],
  };
  let index = startIndex;

  while (index < lines.length) {
    const raw = lines[index];
    if (raw === undefined || isSectionBoundary(raw) || raw === '***') {
      break;
    }
    if (raw.startsWith('***')) {
      throw new Error(`Invalid Line: ${raw}`);
    }
    index += 1;
    consumeSectionLine(state, raw === '' ? ' ' : raw);
  }

  flushChunk(state);

  if (index < lines.length && lines[index] === END_FILE) {
    return {
      nextContext: state.context,
      sectionChunks: state.sectionChunks,
      endIndex: index + 1,
      eof: true,
    };
  }

  if (index === startIndex) {
    throw new Error(`Nothing in this section - index=${String(index)} ${lines[index] ?? ''}`);
  }

  return {
    nextContext: state.context,
    sectionChunks: state.sectionChunks,
    endIndex: index,
    eof: false,
  };
};

const consumeSectionLine = (state: SectionState, raw: string): void => {
  const lastMode = state.mode;
  const mode = lineMode(raw);
  const line = raw.slice(1);
  state.mode = mode;
  if (mode === 'keep' && lastMode !== mode) {
    flushChunk(state);
  }
  if (mode === 'delete') {
    state.delLines.push(line);
    state.context.push(line);
    return;
  }
  if (mode === 'add') {
    state.insLines.push(line);
    return;
  }
  state.context.push(line);
};

const flushChunk = (state: SectionState): void => {
  if (state.insLines.length === 0 && state.delLines.length === 0) {
    return;
  }
  state.sectionChunks.push({
    origIndex: state.context.length - state.delLines.length,
    delLines: state.delLines,
    insLines: state.insLines,
  });
  state.delLines = [];
  state.insLines = [];
};

const lineMode = (line: string): LineMode => {
  if (line.startsWith('+')) {
    return 'add';
  }
  if (line.startsWith('-')) {
    return 'delete';
  }
  if (line.startsWith(' ')) {
    return 'keep';
  }
  throw new Error(`Invalid Line: ${line}`);
};

const isSectionBoundary = (raw: string): boolean =>
  raw.startsWith('@@') ||
  raw.startsWith(END_PATCH) ||
  raw.startsWith('*** Update File:') ||
  raw.startsWith('*** Delete File:') ||
  raw.startsWith('*** Add File:') ||
  raw.startsWith(END_FILE);
