import type { WorkspaceEntryKind } from '../api/contracts.js';
import type { RemoteEntry } from './storage.js';

const PATH_COLLATOR = new Intl.Collator('en');
const ENTRY_ORDER: Readonly<Record<WorkspaceEntryKind, number>> = {
  directory: 0,
  file: 1,
  symlink: 2,
};

export const comparePaths = (left: string, right: string): number =>
  PATH_COLLATOR.compare(left, right);

export const compareRemoteEntryPaths = (left: RemoteEntry, right: RemoteEntry): number =>
  comparePaths(left.path, right.path);

export const orderRemoteEntries = (entries: readonly RemoteEntry[]): readonly RemoteEntry[] =>
  entries.toSorted((left, right) => {
    const kindDifference = entryOrder(left.kind) - entryOrder(right.kind);
    return kindDifference === 0 ? compareRemoteEntryPaths(left, right) : kindDifference;
  });

const entryOrder = (kind: WorkspaceEntryKind): number => {
  return ENTRY_ORDER[kind];
};
