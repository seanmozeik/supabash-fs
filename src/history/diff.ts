import type { WorkspaceChange } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
import type {
  RevisionDiff,
  RevisionDiffEntry,
  RevisionDiffInput,
  RevisionEntry,
} from '../api/history.js';
import type { HistoryBlobStore } from './blob-store.js';
import { readJson } from './json-io.js';
import { historyKey } from './keys.js';
import { DEFAULT_MAX_DIFF_PREVIEW_BYTES } from './limits.js';
import { parseCheckpoint, parseRevision } from './parse.js';

export interface StagedDiffState {
  readonly entries: readonly RevisionEntry[];
  readonly label: 'staged';
}

export const diffRevisions = async (
  history: HistoryBlobStore,
  input: RevisionDiffInput,
  staged?: StagedDiffState,
): Promise<RevisionDiff> => {
  const fromState = await resolveRef(history, input.from, staged);
  const toState = await resolveRef(history, input.to, staged);
  const paths = input.paths === undefined ? undefined : new Set(input.paths);
  const previewBytes = input.previewBytes ?? DEFAULT_MAX_DIFF_PREVIEW_BYTES;
  if (previewBytes > DEFAULT_MAX_DIFF_PREVIEW_BYTES) {
    throw new SupabashError('QUOTA_EXCEEDED', 'Diff preview size is outside the allowed range.');
  }
  const fromMap = new Map(fromState.entries.map((entry) => [entry.path, entry]));
  const toMap = new Map(toState.entries.map((entry) => [entry.path, entry]));
  const allPaths = [...new Set([...fromMap.keys(), ...toMap.keys()])].toSorted();
  const entries: RevisionDiffEntry[] = [];
  for (const path of allPaths) {
    if (paths === undefined || paths.has(path)) {
      entries.push(diffEntry(fromMap.get(path), toMap.get(path)));
    }
  }
  return { entries, fromRevision: fromState.label, toRevision: toState.label };
};

export const changesAsEntries = (changes: readonly WorkspaceChange[]): readonly RevisionEntry[] =>
  changes.filter((change) => change.kind === 'upsert').map((change) => revisionFromChange(change));

const revisionFromChange = (change: WorkspaceChange): RevisionEntry => {
  const contentHash = change.afterHash;
  if (contentHash === undefined) {
    return {
      entryKind: change.entryKind,
      mode: 0o644,
      path: change.path,
      size: change.afterSize ?? 0,
    };
  }
  return {
    entryKind: change.entryKind,
    mode: 0o644,
    path: change.path,
    size: change.afterSize ?? 0,
    contentHash,
  };
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

const diffEntry = (
  before: RevisionEntry | undefined,
  after: RevisionEntry | undefined,
): RevisionDiffEntry => {
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
