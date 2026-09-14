import { isSameOrDescendant } from '../core/path.js';
import { isRuntimeOwnedPath } from '../core/runtime-paths.js';
import type { PendingChanges } from '../core/storage.js';
import type { TrackedFileSystem } from '../core/tracked-file-system.js';

export const persistentPending = (fs: TrackedFileSystem): PendingChanges => {
  const pending = fs.pendingPreview();
  const moves = pending.moves.filter(
    ({ from, to }) => !isRuntimeOwnedPath(from) && !isRuntimeOwnedPath(to),
  );
  return {
    deletions: pending.deletions.filter(({ path }) => !isRuntimeOwnedPath(path)),
    moves,
    upserts: pending.upserts.filter(
      (path) => !isRuntimeOwnedPath(path) && !derivedDirectory(fs, path),
    ),
  };
};

const derivedDirectory = (fs: TrackedFileSystem, path: string): boolean => {
  if (fs.kindOf(path) !== 'directory') {
    return false;
  }
  return fs
    .getAllPaths()
    .some(
      (candidate) =>
        candidate !== path &&
        !isRuntimeOwnedPath(candidate) &&
        isSameOrDescendant(candidate, path) &&
        fs.kindOf(candidate) !== 'directory',
    );
};
