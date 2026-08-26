import type { IFileSystem } from 'just-bash/browser';

export type WorkspaceChangeKind = 'delete' | 'upsert';
export type WorkspaceEntryKind = 'directory' | 'file' | 'symlink';

export interface WorkspaceChange {
  readonly contentHash?: string;
  readonly entryKind: WorkspaceEntryKind;
  readonly etag?: string;
  readonly kind: WorkspaceChangeKind;
  readonly path: string;
}

export interface CommitReceipt {
  readonly changes: readonly WorkspaceChange[];
  readonly committedAt: Date;
  readonly revision: string;
}

export interface Workspace {
  readonly fs: IFileSystem;
  readonly commit: () => Promise<CommitReceipt>;
  readonly discard: () => Promise<void>;
}
