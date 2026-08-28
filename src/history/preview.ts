import type { RevisionDiffKind, RevisionEntry } from '../api/history.js';
import type { HistoryBlobStore } from './blob-store.js';
import { readBytes } from './json-io.js';
import { historyKey } from './keys.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const revisionDiffPreview = async (
  history: HistoryBlobStore,
  kind: RevisionDiffKind,
  before: RevisionEntry | undefined,
  after: RevisionEntry | undefined,
  limit: number,
): Promise<string | undefined> => {
  if (limit === 0 || (kind !== 'added' && kind !== 'deleted' && kind !== 'modified')) {
    return undefined;
  }
  const rendered = renderPreview(await textOf(history, before), await textOf(history, after));
  if (rendered === undefined) {
    return undefined;
  }
  const encoded = new TextEncoder().encode(rendered);
  if (encoded.byteLength <= limit) {
    return rendered;
  }
  return `${utf8Prefix(encoded, limit)}\n[truncated]\n`;
};

const utf8Prefix = (encoded: Uint8Array, limit: number): string => {
  const prefixDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let end = Math.min(limit, encoded.byteLength);
  while (end > 0) {
    try {
      return prefixDecoder.decode(encoded.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return '';
};

const textOf = async (
  history: HistoryBlobStore,
  entry: RevisionEntry | undefined,
): Promise<string | undefined> => {
  if (entry?.entryKind !== 'file' || entry.contentHash === undefined) {
    return undefined;
  }
  const body = await readBytes(history, historyKey.object(entry.contentHash));
  if (body === undefined) {
    return undefined;
  }
  try {
    return decoder.decode(body);
  } catch {
    return undefined;
  }
};

const renderPreview = (
  before: string | undefined,
  after: string | undefined,
): string | undefined => {
  if (before === undefined && after === undefined) {
    return undefined;
  }
  if (before === undefined) {
    return after;
  }
  if (after === undefined) {
    return before;
  }
  if (before === after) {
    return undefined;
  }
  return `--- before\n${withTrailingNewline(before)}+++ after\n${after}`;
};

const withTrailingNewline = (value: string): string =>
  value.endsWith('\n') ? value : `${value}\n`;
