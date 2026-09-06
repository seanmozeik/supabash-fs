import type { IFileSystem } from 'just-bash/browser';

import type { Workspace } from '../api/contracts.js';
import type { WorkspaceFileSystemViewOptions } from '../core/filesystem-view.js';
import type { FileSystemSnapshot } from './snapshot.js';

interface MountLocation {
  readonly mountPoint: string;
  readonly view?: WorkspaceFileSystemViewOptions;
}

export interface WritableWorkspaceMount extends MountLocation {
  readonly access: 'read-write';
  readonly sourceId: string;
  readonly workspace: Pick<Workspace, 'fs'>;
}

export interface ReadonlySnapshotMount extends MountLocation {
  readonly access: 'read-only';
  readonly snapshot: FileSystemSnapshot;
}

export type FileSystemMount = WritableWorkspaceMount | ReadonlySnapshotMount;

export type MountDescriptor = Readonly<{
  mountPoint: string;
  sourceId: string;
  root: string;
  hiddenRoots: readonly string[];
}> &
  (
    | Readonly<{ access: 'read-write' }>
    | Readonly<{ access: 'read-only'; revision: string; digest: string }>
  );

export interface MountedFileSystem {
  readonly fs: IFileSystem;
  /** Safe to record with a turn; contains identities and revisions, not file bodies. */
  readonly mounts: readonly MountDescriptor[];
  /** Translate a visible path to its backing-source identity and stored path. */
  readonly toSourcePath: (
    path: string,
  ) => Readonly<{ mountPoint: string; sourceId: string; path: string }>;
  /** Translate a stored path (for example a retrieval result) into the tool namespace. */
  readonly toVirtualPath: (mountPoint: string, sourcePath: string) => string;
}
