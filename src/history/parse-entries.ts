import type { WorkspaceChange, WorkspaceEntryKind } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
import type { RevisionEntry } from '../api/history.js';

export const parseRevisionEntries = (value: unknown): readonly RevisionEntry[] => {
  if (!Array.isArray(value)) {
    throw new SupabashError('HISTORY_CORRUPTION', 'Revision entries must be an array.');
  }
  return value.map((entry) => parseRevisionEntry(entry));
};

export const parseChanges = (value: unknown): readonly WorkspaceChange[] => {
  if (!Array.isArray(value)) {
    throw new SupabashError('HISTORY_CORRUPTION', 'Transaction changes must be an array.');
  }
  return value.map((entry) => parseChange(entry));
};

const parseRevisionEntry = (value: unknown): RevisionEntry => {
  const record = asObject(value);
  const contentHash = optionalString(record, 'contentHash');
  const etag = optionalString(record, 'etag');
  const target = optionalString(record, 'target');
  return {
    entryKind: parseKind(record['entryKind']),
    mode: requiredNumber(record, 'mode'),
    path: requiredString(record, 'path'),
    size: requiredNumber(record, 'size'),
    ...(contentHash !== undefined && { contentHash }),
    ...(etag !== undefined && { etag }),
    ...(target !== undefined && { target }),
  };
};

const parseChange = (value: unknown): WorkspaceChange => {
  const record = asObject(value);
  const contentHash = optionalString(record, 'contentHash');
  const etag = optionalString(record, 'etag');
  const beforeHash = optionalString(record, 'beforeHash');
  const afterHash = optionalString(record, 'afterHash');
  return {
    entryKind: parseKind(record['entryKind']),
    kind: record['kind'] === 'delete' ? 'delete' : 'upsert',
    path: requiredString(record, 'path'),
    ...(afterHash !== undefined && { afterHash }),
    ...(beforeHash !== undefined && { beforeHash }),
    ...(contentHash !== undefined && { contentHash }),
    ...(etag !== undefined && { etag }),
  };
};

const parseKind = (value: unknown): WorkspaceEntryKind => {
  if (value === 'directory' || value === 'file' || value === 'symlink') {
    return value;
  }
  throw new SupabashError('HISTORY_CORRUPTION', 'History record has an invalid entry kind.');
};

const asObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SupabashError('HISTORY_CORRUPTION', 'History record is not an object.');
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = entry;
  }
  return result;
};

const requiredString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new SupabashError('HISTORY_CORRUPTION', `History record is missing '${key}'.`);
  }
  return value;
};

const optionalString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const requiredNumber = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SupabashError('HISTORY_CORRUPTION', `History record is missing '${key}'.`);
  }
  return value;
};
