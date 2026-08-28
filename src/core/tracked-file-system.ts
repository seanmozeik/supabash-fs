import {
  InMemoryFs,
  type CpOptions,
  type FileContent,
  type FsStat,
  type IFileSystem,
  type MkdirOptions,
  type RmOptions,
} from 'just-bash/browser';

import type { WorkspaceEntryKind } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
import { comparePaths, compareRemoteEntryPaths } from './entry-order.js';
import { moveDescendant, normalizeVirtualPath, ROOT_PATH } from './path.js';
import { isRuntimeOwnedPath } from './runtime-paths.js';
import type { PendingChanges, PendingMove, RemoteEntry, UploadDraft } from './storage.js';
import {
  entriesWithin,
  entryForAudit,
  fileMatchesBaseline,
  pristineStatFor,
  recordDeletion,
  recordMove,
  recordUpsert,
  uploadDraftFor,
} from './tracked-inspection.js';
import { pendingAgainstBaseline, rebuildLiveTree } from './tracked-restore.js';

type ReadOptions = Parameters<IFileSystem['readFile']>[1];
type WriteOptions = Parameters<IFileSystem['writeFile']>[2];
export class TrackedFileSystem implements IFileSystem {
  private baseline = new Map<string, RemoteEntry>();
  private readonly baselineHashes = new Map<string, Promise<string>>();
  private commitInProgress = false;
  private deletions = new Map<string, RemoteEntry>();
  private readonly download: (entry: RemoteEntry) => Promise<Uint8Array>;
  private inner = new InMemoryFs();
  private kinds = new Map<string, WorkspaceEntryKind>([[ROOT_PATH, 'directory']]);
  private readonly maxTotalBytes: number | undefined;
  private readonly moves = new Map<string, string>();
  private upserts = new Set<string>();

  private constructor(
    download: (entry: RemoteEntry) => Promise<Uint8Array>,
    maxTotalBytes: number | undefined,
  ) {
    this.download = download;
    this.maxTotalBytes = maxTotalBytes;
  }

  static async create(
    entries: readonly RemoteEntry[],
    download: (entry: RemoteEntry) => Promise<Uint8Array>,
    maxTotalBytes?: number,
  ): Promise<TrackedFileSystem> {
    const filesystem = new TrackedFileSystem(download, maxTotalBytes);
    await filesystem.reset(entries);
    return filesystem;
  }

  private async reset(entries: readonly RemoteEntry[]): Promise<void> {
    const persistent = entries.filter((entry) => !isRuntimeOwnedPath(entry.path));
    const live = await rebuildLiveTree(persistent, this.download, false, this.maxTotalBytes);
    this.inner = live.inner;
    this.kinds = live.kinds;
    this.baseline = new Map(persistent.map((entry) => [entry.path, entry]));
    this.baselineHashes.clear();
    this.deletions.clear();
    this.moves.clear();
    this.upserts.clear();
    this.commitInProgress = false;
  }

  async stageRemoteTree(
    entries: readonly RemoteEntry[],
    download: (entry: RemoteEntry) => Promise<Uint8Array>,
  ): Promise<void> {
    this.assertMutable();
    const persistent = entries.filter((entry) => !isRuntimeOwnedPath(entry.path));
    const live = await rebuildLiveTree(persistent, download, true, this.maxTotalBytes);
    this.inner = live.inner;
    this.kinds = live.kinds;
    const pending = pendingAgainstBaseline(this.baseline, persistent);
    this.deletions = pending.deletions;
    this.moves.clear();
    this.upserts = pending.upserts;
  }

  beginCommit(): PendingChanges {
    if (this.commitInProgress) {
      throw new SupabashError('COMMIT_IN_PROGRESS', 'A workspace commit is already running.');
    }
    this.commitInProgress = true;
    return this.pendingPreview();
  }

  finishCommit(entries: readonly RemoteEntry[]): Promise<void> {
    return this.reset(entries);
  }

  failCommit(): void {
    this.commitInProgress = false;
  }

  async discardChanges(): Promise<void> {
    this.assertMutable();
    await this.reset([...this.baseline.values()]);
  }

  pendingPreview(): PendingChanges {
    return {
      deletions: [...this.deletions.values()]
        .filter((entry) => !isRuntimeOwnedPath(entry.path))
        .toSorted(compareRemoteEntryPaths),
      moves: [...this.moves]
        .map(([from, to]): PendingMove => ({ from, to }))
        .filter((move) => !isRuntimeOwnedPath(move.from) && !isRuntimeOwnedPath(move.to))
        .toSorted((left, right) => comparePaths(left.from, right.from)),
      upserts: [...this.upserts].filter((path) => !isRuntimeOwnedPath(path)).toSorted(comparePaths),
    };
  }

  kindOf(path: string): WorkspaceEntryKind {
    const kind = this.kinds.get(normalizeVirtualPath(path));
    if (kind === undefined) {
      throw new SupabashError('INVALID_PATH', 'Path does not exist.', { path });
    }
    return kind;
  }

  baselineEntries(): readonly RemoteEntry[] {
    return [...this.baseline.values()];
  }

  baselineEntry(path: string): RemoteEntry | undefined {
    return this.baseline.get(normalizeVirtualPath(path));
  }

  baselineEntryForAudit(path: string): Promise<RemoteEntry | undefined> {
    return entryForAudit(this.baselineEntry(path), this.baselineHashes, this.download);
  }

  refreshBaseline(entries: readonly RemoteEntry[]): void {
    const next = new Map(entries.map((entry) => [entry.path, entry]));
    this.baseline = next;
    this.baselineHashes.clear();
    this.deletions = new Map(
      [...this.deletions.keys()].flatMap((path) => {
        const entry = next.get(path);
        return entry === undefined ? [] : [[path, entry] as const];
      }),
    );
  }

  uploadEntry(path: string): Promise<UploadDraft> {
    return uploadDraftFor(this.inner, this.kinds, path);
  }

  readFile(path: string, options?: ReadOptions): Promise<string> {
    return this.inner.readFile(path, options);
  }

  readFileBytes(path: string): ReturnType<InMemoryFs['readFileBytes']> {
    return this.inner.readFileBytes(path);
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.inner.readFileBuffer(path).then((body) => Uint8Array.from(body));
  }

  async writeFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
    this.assertMutable();
    const normalized = normalizeVirtualPath(path);
    const wasChanged = this.upserts.has(normalized) || this.deletions.has(normalized);
    await this.inner.writeFile(normalized, content, options);
    this.trackUpsert(normalized, 'file');
    if (wasChanged) {
      await this.reconcileFile(normalized);
    }
  }

  async appendFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
    this.assertMutable();
    const normalized = normalizeVirtualPath(path);
    const wasChanged = this.upserts.has(normalized) || this.deletions.has(normalized);
    await this.inner.appendFile(normalized, content, options);
    this.trackUpsert(normalized, 'file');
    if (wasChanged) {
      await this.reconcileFile(normalized);
    }
  }

  exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }

  stat(path: string): Promise<FsStat> {
    return this.pristineStat(path) ?? this.inner.stat(path);
  }

  lstat(path: string): Promise<FsStat> {
    return this.pristineStat(path) ?? this.inner.lstat(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.assertMutable();
    const before = new Set(this.inner.getAllPaths());
    await this.inner.mkdir(normalizeVirtualPath(path), options);
    for (const created of this.inner.getAllPaths().filter((entry) => !before.has(entry))) {
      this.trackUpsert(created, 'directory');
    }
  }

  readdir(path: string): Promise<string[]> {
    return this.inner.readdir(path);
  }

  readdirWithFileTypes(path: string): ReturnType<InMemoryFs['readdirWithFileTypes']> {
    return this.inner.readdirWithFileTypes(path);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    this.assertMutable();
    const normalized = normalizeVirtualPath(path);
    const removed = this.entriesWithin(normalized);
    await this.inner.rm(normalized, options);
    for (const [removedPath] of removed) {
      this.trackDeletion(removedPath);
    }
  }

  async cp(source: string, destination: string, options?: CpOptions): Promise<void> {
    this.assertMutable();
    const normalizedSource = normalizeVirtualPath(source);
    const normalizedDestination = normalizeVirtualPath(destination);
    const copied = this.entriesWithin(normalizedSource);
    await this.inner.cp(normalizedSource, normalizedDestination, options);
    for (const [path, kind] of copied) {
      this.trackUpsert(moveDescendant(path, normalizedSource, normalizedDestination), kind);
    }
  }

  async mv(source: string, destination: string): Promise<void> {
    this.assertMutable();
    const normalizedSource = normalizeVirtualPath(source);
    const normalizedDestination = normalizeVirtualPath(destination);
    const moved = this.entriesWithin(normalizedSource);
    await this.inner.mv(normalizedSource, normalizedDestination);
    for (const [path] of moved) {
      this.trackMove(path, moveDescendant(path, normalizedSource, normalizedDestination));
      this.trackDeletion(path);
    }
    for (const [path, kind] of moved) {
      this.trackUpsert(moveDescendant(path, normalizedSource, normalizedDestination), kind);
    }
  }

  resolvePath(base: string, path: string): string {
    return normalizeVirtualPath(this.inner.resolvePath(base, path));
  }

  getAllPaths(): string[] {
    return this.inner.getAllPaths();
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.assertMutable();
    const normalized = normalizeVirtualPath(path);
    await this.inner.chmod(normalized, mode);
    this.trackExistingUpsert(normalized);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    this.assertMutable();
    const normalized = normalizeVirtualPath(linkPath);
    await this.inner.symlink(target, normalized);
    this.trackUpsert(normalized, 'symlink');
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    this.assertMutable();
    const normalized = normalizeVirtualPath(newPath);
    await this.inner.link(normalizeVirtualPath(existingPath), normalized);
    this.trackUpsert(normalized, 'file');
  }

  readlink(path: string): Promise<string> {
    return this.inner.readlink(path);
  }

  realpath(path: string): Promise<string> {
    return this.inner.realpath(path);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    this.assertMutable();
    const normalized = normalizeVirtualPath(path);
    const changedPath = normalizeVirtualPath(await this.inner.realpath(normalized));
    await this.inner.utimes(normalized, atime, mtime);
    this.trackExistingUpsert(changedPath);
  }

  private pristineStat(path: string): Promise<FsStat> | undefined {
    const normalized = normalizeVirtualPath(path);
    return pristineStatFor(
      normalized,
      this.baseline,
      this.upserts.has(normalized) || this.deletions.has(normalized),
    );
  }

  private entriesWithin(path: string): (readonly [string, WorkspaceEntryKind])[] {
    return entriesWithin(this.kinds, path);
  }

  private trackExistingUpsert(path: string): void {
    const kind = this.kinds.get(path);
    if (kind === undefined) {
      throw new SupabashError('INVALID_PATH', 'Path does not exist.', { path });
    }
    this.trackUpsert(path, kind);
  }

  private trackUpsert(path: string, kind: WorkspaceEntryKind): void {
    recordUpsert(path, kind, this.kinds, this.deletions, this.upserts);
  }

  private trackDeletion(path: string): void {
    recordDeletion(path, this.baseline, this.deletions, this.kinds, this.moves, this.upserts);
  }

  private trackMove(from: string, to: string): void {
    recordMove(from, to, this.baseline, this.moves);
  }

  private async reconcileFile(path: string): Promise<void> {
    const baseline = this.baseline.get(path);
    if (await fileMatchesBaseline(this.inner, baseline, this.baselineHashes, this.download)) {
      this.deletions.delete(path);
      this.upserts.delete(path);
    }
  }

  private assertMutable(): void {
    if (this.commitInProgress) {
      throw new SupabashError('COMMIT_IN_PROGRESS', 'The filesystem is read-only during commit.');
    }
  }
}
