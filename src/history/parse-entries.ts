import type { WorkspaceChange, WorkspaceChangeKind, WorkspaceEntryKind } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
import type { RevisionEntry } from '../api/history.js';
import {
  optionalNumber,
  optionalString,
  parseHistoryObject,
  requiredNumber,
  requiredString,
} from './fields.js';

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
  const record = parseHistoryObject(value);
  const contentHash = optionalString(record, 'contentHash');
  const etag = optionalString(record, 'etag');
  const target = optionalString(record, 'target');
  const entryKind = parseKind(record['entryKind']);
  if (entryKind === 'symlink' && target === undefined) {
    throw new SupabashError('HISTORY_CORRUPTION', 'Symlink revision is missing a target.', {
      path: requiredString(record, 'path'),
    });
  }
  return {
    entryKind,
    mode: requiredNumber(record, 'mode'),
    path: requiredString(record, 'path'),
    size: requiredNumber(record, 'size'),
    ...(contentHash !== undefined && { contentHash }),
    ...(etag !== undefined && { etag }),
    ...(target !== undefined && { target }),
  };
};

const parseChange = (value: unknown): WorkspaceChange => {
  const record = parseHistoryObject(value);
  const contentHash = optionalString(record, 'contentHash');
  const etag = optionalString(record, 'etag');
  const beforeHash = optionalString(record, 'beforeHash');
  const afterHash = optionalString(record, 'afterHash');
  const beforeEtag = optionalString(record, 'beforeEtag');
  const afterEtag = optionalString(record, 'afterEtag');
  const moveFrom = optionalString(record, 'moveFrom');
  const moveTo = optionalString(record, 'moveTo');
  const beforeSize = optionalNumber(record, 'beforeSize');
  const afterSize = optionalNumber(record, 'afterSize');
  return {
    entryKind: parseKind(record['entryKind']),
    kind: parseChangeKind(record['kind']),
    path: requiredString(record, 'path'),
    ...(afterHash !== undefined && { afterHash }),
    ...(afterEtag !== undefined && { afterEtag }),
    ...(afterSize !== undefined && { afterSize }),
    ...(beforeHash !== undefined && { beforeHash }),
    ...(beforeEtag !== undefined && { beforeEtag }),
    ...(beforeSize !== undefined && { beforeSize }),
    ...(contentHash !== undefined && { contentHash }),
    ...(etag !== undefined && { etag }),
    ...(moveFrom !== undefined && { moveFrom }),
    ...(moveTo !== undefined && { moveTo }),
  };
};

const parseKind = (value: unknown): WorkspaceEntryKind => {
  if (value === 'directory' || value === 'file' || value === 'symlink') {
    return value;
  }
  throw new SupabashError('HISTORY_CORRUPTION', 'History record has an invalid entry kind.');
};

const parseChangeKind = (value: unknown): WorkspaceChangeKind => {
  if (value === 'delete' || value === 'move' || value === 'upsert') {
    return value;
  }
  throw new SupabashError('HISTORY_CORRUPTION', 'History record has an invalid change kind.');
};
