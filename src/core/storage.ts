import type { WorkspaceEntryKind } from '../api/contracts.js';
import type { HistoryBlobStore } from '../history/blob-store.js';

export interface RemoteEntry {
  readonly contentHash?: string;
  readonly contentType?: string;
  readonly etag?: string;
  readonly kind: WorkspaceEntryKind;
  readonly mode: number;
  readonly modifiedAt: Date;
  readonly path: string;
  readonly size: number;
  readonly target?: string;
  readonly versionHash?: string;
}

export interface UploadDraft {
  readonly body?: Uint8Array;
  readonly contentHash?: string;
  readonly contentType?: string;
  readonly kind: WorkspaceEntryKind;
  readonly mode: number;
  readonly modifiedAt: Date;
  readonly path: string;
  readonly target?: string;
}

export interface UploadEntry extends UploadDraft {
  readonly versionHash: string;
}

export interface PendingChanges {
  readonly deletions: readonly RemoteEntry[];
  readonly moves: readonly PendingMove[];
  readonly upserts: readonly string[];
}

export interface PendingMove {
  readonly from: string;
  readonly to: string;
}

export interface ScopedStorage {
  readonly delete: (entries: readonly RemoteEntry[]) => Promise<void>;
  readonly download: (entry: RemoteEntry) => Promise<Uint8Array>;
  readonly head: (path: string) => Promise<RemoteEntry | undefined>;
  readonly history: HistoryBlobStore;
  readonly list: () => Promise<readonly RemoteEntry[]>;
  readonly upload: (entry: UploadEntry) => Promise<RemoteEntry>;
}
