import type { IFileSystem } from 'just-bash/browser';

import { SupabashError } from '../api/errors.js';
import type { RestorePlan, RevisionEntry } from '../api/history.js';
import { comparePaths } from '../core/entry-order.js';
import { ROOT_PATH } from '../core/path.js';
import type { HistoryBlobStore } from './blob-store.js';
import { diffRevisions } from './diff.js';
import { readBytes, readJson } from './json-io.js';
import { historyKey } from './keys.js';
import { parseRevision } from './parse.js';
import { requireHeadRevision } from './query.js';

export const planRestore = async (
  history: HistoryBlobStore,
  fs: IFileSystem,
  revision: string,
): Promise<RestorePlan> => {
  const current = await requireHeadRevision(history);
  const target = await readJson(history, historyKey.revision(revision), parseRevision);
  if (target === undefined) {
    throw new SupabashError('REVISION_NOT_FOUND', 'Restore revision does not exist.');
  }
  const currentRecord = await readJson(history, historyKey.revision(current), parseRevision);
  if (currentRecord === undefined) {
    throw new SupabashError('HISTORY_CORRUPTION', 'Current revision manifest is missing.');
  }
  const diff = await diffRevisions(history, { from: { revision: current }, to: { revision } });
  await applyEntries(fs, currentRecord.entries, target.entries, history);
  return { diff, sourceRevision: revision };
};

const applyEntries = async (
  fs: IFileSystem,
  current: readonly RevisionEntry[],
  target: readonly RevisionEntry[],
  history: HistoryBlobStore,
): Promise<void> => {
  const targetPaths = new Set(target.map((entry) => entry.path));
  const currentPaths = new Set(current.map((entry) => entry.path));
  for (const path of [...currentPaths].toSorted((left, right) => comparePaths(right, left))) {
    if (!targetPaths.has(path) && path !== ROOT_PATH) {
      await removePath(fs, path);
    }
  }
  for (const extra of extraPaths(fs, targetPaths)) {
    await removePath(fs, extra);
  }
  for (const entry of target) {
    await materialize(fs, entry, history);
  }
};

const extraPaths = (fs: IFileSystem, keep: ReadonlySet<string>): readonly string[] =>
  fs
    .getAllPaths()
    .filter((path) => path !== ROOT_PATH && !keep.has(path))
    .toSorted((left, right) => right.length - left.length || comparePaths(right, left));

const materialize = async (
  fs: IFileSystem,
  entry: RevisionEntry,
  history: HistoryBlobStore,
): Promise<void> => {
  if (entry.entryKind === 'directory') {
    const existing = await lstatOrMissing(fs, entry.path);
    if (existing !== undefined && !existing.isDirectory) {
      await fs.rm(entry.path, { force: true, recursive: true });
    }
    await fs.mkdir(entry.path, { recursive: true });
    return;
  }
  if (entry.entryKind === 'symlink') {
    if (entry.target === undefined) {
      throw new SupabashError('HISTORY_CORRUPTION', 'Symlink revision is missing a target.', {
        path: entry.path,
      });
    }
    if (await sameSymlink(fs, entry.path, entry.target)) {
      return;
    }
    await removePath(fs, entry.path);
    await fs.symlink(entry.target, entry.path);
    return;
  }
  if (entry.contentHash === undefined) {
    throw new SupabashError('HISTORY_CORRUPTION', 'File revision is missing a content hash.', {
      path: entry.path,
    });
  }
  const body = await readBytes(history, historyKey.object(entry.contentHash));
  if (body === undefined) {
    throw new SupabashError('REVISION_NOT_FOUND', 'Historical file body is no longer retained.', {
      path: entry.path,
    });
  }
  const existing = await lstatOrMissing(fs, entry.path);
  if (existing !== undefined && !existing.isFile) {
    await fs.rm(entry.path, { force: true, recursive: true });
  }
  await fs.writeFile(entry.path, body);
};

const sameSymlink = async (fs: IFileSystem, path: string, target: string): Promise<boolean> => {
  const stat = await lstatOrMissing(fs, path);
  return stat?.isSymbolicLink === true && (await fs.readlink(path)) === target;
};

const removePath = async (fs: IFileSystem, path: string): Promise<void> => {
  if ((await lstatOrMissing(fs, path)) !== undefined) {
    await fs.rm(path, { force: true, recursive: true });
  }
};

const lstatOrMissing = async (
  fs: IFileSystem,
  path: string,
): Promise<Awaited<ReturnType<IFileSystem['lstat']>> | undefined> => {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('ENOENT:')) {
      return undefined;
    }
    throw error;
  }
};
