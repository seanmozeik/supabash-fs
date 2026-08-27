import { SupabashError } from '../api/errors.js';
import type {
  RevisionDiff,
  RevisionDiffEntry,
  RevisionDiffInput,
  RevisionEntry,
} from '../api/history.js';
import { comparePaths } from '../core/entry-order.js';
import type { HistoryBlobStore } from './blob-store.js';
import { readJson } from './json-io.js';
import { historyKey } from './keys.js';
import type { WorkspaceLimits } from './limits.js';
import { parseCheckpoint, parseRevision } from './parse.js';
import { revisionDiffPreview } from './preview.js';
import { diffPreviewLimit } from './quota.js';

export interface StagedDiffState {
  readonly entries: readonly RevisionEntry[];
  readonly label: 'staged';
}

export const diffRevisions = async (
  history: HistoryBlobStore,
  input: RevisionDiffInput,
  staged?: StagedDiffState,
  limits: WorkspaceLimits = {},
): Promise<RevisionDiff> => {
  const fromState = await resolveRef(history, input.from, staged);
  const toState = await resolveRef(history, input.to, staged);
  const paths = input.paths === undefined ? undefined : new Set(input.paths);
  const previewBytes = diffPreviewLimit(input.previewBytes, limits);
  const fromMap = new Map(fromState.entries.map((entry) => [entry.path, entry]));
  const toMap = new Map(toState.entries.map((entry) => [entry.path, entry]));
  const allPaths = [...new Set([...fromMap.keys(), ...toMap.keys()])].toSorted();
  const rawEntries: RevisionDiffEntry[] = [];
  for (const path of allPaths) {
    const entry = await diffEntry(history, fromMap.get(path), toMap.get(path), previewBytes);
    if (entry !== undefined) {
      rawEntries.push(entry);
    }
  }
  const detected = detectMoves(rawEntries, fromMap, toMap);
  const entries = detected.filter(
    (entry) =>
      paths === undefined ||
      paths.has(entry.path) ||
      (entry.moveFrom !== undefined && paths.has(entry.moveFrom)),
  );
  return { entries, fromRevision: fromState.label, toRevision: toState.label };
};

const resolveRef = async (
  history: HistoryBlobStore,
  ref: RevisionDiffInput['from'],
  staged: StagedDiffState | undefined,
): Promise<{ entries: readonly RevisionEntry[]; label: string }> => {
  if ('staged' in ref) {
    if (staged === undefined) {
      throw new SupabashError('REVISION_NOT_FOUND', 'Staged diff state is not available.');
    }
    return staged;
  }
  if ('checkpoint' in ref) {
    const checkpoint = await readJson(
      history,
      historyKey.checkpoint(ref.checkpoint),
      parseCheckpoint,
    );
    if (checkpoint === undefined) {
      throw new SupabashError('REVISION_NOT_FOUND', 'Checkpoint does not exist.');
    }
    return resolveRevision(history, checkpoint.revision);
  }
  return resolveRevision(history, ref.revision);
};

const resolveRevision = async (
  history: HistoryBlobStore,
  revision: string,
): Promise<{ entries: readonly RevisionEntry[]; label: string }> => {
  const record = await readJson(history, historyKey.revision(revision), parseRevision);
  if (record === undefined) {
    throw new SupabashError('REVISION_NOT_FOUND', 'Revision does not exist.');
  }
  return { entries: record.entries, label: revision };
};

const diffEntry = async (
  history: HistoryBlobStore,
  before: RevisionEntry | undefined,
  after: RevisionEntry | undefined,
  previewBytes: number,
): Promise<RevisionDiffEntry | undefined> => {
  const entry = describeDiff(before, after);
  if (entry === undefined) {
    return undefined;
  }
  const preview = await revisionDiffPreview(history, entry.kind, before, after, previewBytes);
  return preview === undefined ? entry : { ...entry, preview };
};

const describeDiff = (
  before: RevisionEntry | undefined,
  after: RevisionEntry | undefined,
): RevisionDiffEntry | undefined => {
  if (before === undefined && after !== undefined) {
    return {
      kind: 'added',
      path: after.path,
      ...(after.contentHash !== undefined && { afterHash: after.contentHash }),
    };
  }
  if (before !== undefined && after === undefined) {
    return {
      kind: 'deleted',
      path: before.path,
      ...(before.contentHash !== undefined && { beforeHash: before.contentHash }),
    };
  }
  if (before === undefined || after === undefined) {
    return { kind: 'unavailable', path: '/' };
  }
  if (before.entryKind !== after.entryKind) {
    return {
      kind: 'type-change',
      path: after.path,
      ...(after.contentHash !== undefined && { afterHash: after.contentHash }),
      ...(before.contentHash !== undefined && { beforeHash: before.contentHash }),
    };
  }
  if (
    before.contentHash === after.contentHash &&
    before.mode === after.mode &&
    before.target === after.target
  ) {
    return undefined;
  }
  if (before.contentHash === after.contentHash) {
    return {
      kind: 'metadata',
      path: after.path,
      ...(after.contentHash !== undefined && { afterHash: after.contentHash }),
      ...(before.contentHash !== undefined && { beforeHash: before.contentHash }),
    };
  }
  return {
    kind: 'modified',
    path: after.path,
    ...(after.contentHash !== undefined && { afterHash: after.contentHash }),
    ...(before.contentHash !== undefined && { beforeHash: before.contentHash }),
  };
};

const detectMoves = (
  entries: readonly RevisionDiffEntry[],
  before: ReadonlyMap<string, RevisionEntry>,
  after: ReadonlyMap<string, RevisionEntry>,
): readonly RevisionDiffEntry[] => {
  const deleted = entries.filter((entry) => entry.kind === 'deleted');
  const additions = entries.filter((entry) => entry.kind === 'added');
  const consumed = new Set<RevisionDiffEntry>();
  const moves: RevisionDiffEntry[] = [];
  for (const removed of deleted) {
    const source = before.get(removed.path);
    const added = additions.find(
      (candidate) => !consumed.has(candidate) && sameContent(source, after.get(candidate.path)),
    );
    if (added !== undefined) {
      consumed.add(removed);
      consumed.add(added);
      moves.push({
        ...(added.afterHash !== undefined && { afterHash: added.afterHash }),
        ...(removed.beforeHash !== undefined && { beforeHash: removed.beforeHash }),
        kind: 'moved',
        moveFrom: removed.path,
        moveTo: added.path,
        path: added.path,
      });
    }
  }
  return [...entries.filter((entry) => !consumed.has(entry)), ...moves].toSorted((left, right) =>
    comparePaths(left.path, right.path),
  );
};

const sameContent = (left: RevisionEntry | undefined, right: RevisionEntry | undefined): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.entryKind === right.entryKind &&
  left.contentHash === right.contentHash &&
  left.target === right.target;
