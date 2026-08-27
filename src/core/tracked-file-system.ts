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
import {
  isSameOrDescendant,
  moveDescendant,
  normalizeVirtualPath,
  parentPaths,
  ROOT_PATH,
} from './path.js';
import type { PendingChanges, RemoteEntry, UploadDraft } from './storage.js';
import { pendingAgainstBaseline, pristineRemoteStat, rebuildLiveTree } from './tracked-restore.js';

type ReadOptions = Parameters<IFileSystem['readFile']>[1];
type WriteOptions = Parameters<IFileSystem['writeFile']>[2];

export class TrackedFileSystem implements IFileSystem {
  private baseline = new Map<string, RemoteEntry>();
  private commitInProgress = false;
  private deletions = new Map<string, RemoteEntry>();
  private readonly download: (entry: RemoteEntry) => Promise<Uint8Array>;
  private inner = new InMemoryFs();
  private kinds = new Map<string, WorkspaceEntryKind>([[ROOT_PATH, 'directory']]);
  private readonly maxTotalBytes: number | undefined;
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
    const live = await rebuildLiveTree(entries, this.download, false, this.maxTotalBytes);
    this.inner = live.inner;
    this.kinds = live.kinds;
    this.baseline = new Map(entries.map((entry) => [entry.path, entry]));
    this.deletions.clear();
    this.upserts.clear();
    this.commitInProgress = false;
  }

  async stageRemoteTree(
    entries: readonly RemoteEntry[],
    download: (entry: RemoteEntry) => Promise<Uint8Array>,
  ): Promise<void> {
    this.assertMutable();
    const live = await rebuildLiveTree(entries, download, true, this.maxTotalBytes);
    this.inner = live.inner;
    this.kinds = live.kinds;
    const pending = pendingAgainstBaseline(this.baseline, entries);
    this.deletions = pending.deletions;
    this.upserts = pending.upserts;
  }

  beginCommit(): PendingChanges {
    if (this.commitInProgress) {
      throw new SupabashError('COMMIT_IN_PROGRESS', 'A workspace commit is already running.');
    }
    this.commitInProgress = true;
    return this.pendingPreview();
  }

  finishCommit(entries: readonly RemoteEntry[]): void {
    for (const deleted of this.deletions.values()) {
      this.baseline.delete(deleted.path);
    }
    for (const entry of entries) {
      this.baseline.set(entry.path, entry);
    }
    this.deletions.clear();
    this.upserts.clear();
    this.commitInProgress = false;
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
      deletions: [...this.deletions.values()].toSorted(compareRemoteEntryPaths),
      upserts: [...this.upserts].toSorted(comparePaths),
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

  async uploadEntry(path: string): Promise<UploadDraft> {
    const normalized = normalizeVirtualPath(path);
    const kind = this.kinds.get(normalized);
    if (kind === undefined) {
      throw new SupabashError('INVALID_PATH', 'Changed path no longer exists.', { path });
    }
    const stat = await this.inner.lstat(normalized);
    if (kind === 'file') {
      return {
        body: await this.inner.readFileBuffer(normalized),
        kind,
        mode: stat.mode,
        modifiedAt: stat.mtime,
        path: normalized,
      };
    }
    if (kind === 'symlink') {
      return {
        kind,
        mode: stat.mode,
        modifiedAt: stat.mtime,
        path: normalized,
        target: await this.inner.readlink(normalized),
      };
    }
    return { kind, mode: stat.mode, modifiedAt: stat.mtime, path: normalized };
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
    await this.inner.writeFile(normalized, content, options);
    this.trackUpsert(normalized, 'file');
  }

  async appendFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
    this.assertMutable();
    const normalized = normalizeVirtualPath(path);
    await this.inner.appendFile(normalized, content, options);
    this.trackUpsert(normalized, 'file');
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
    return pristineRemoteStat(
      normalized,
      this.baseline,
      this.upserts.has(normalized) || this.deletions.has(normalized),
    );
  }

  private entriesWithin(path: string): (readonly [string, WorkspaceEntryKind])[] {
    return [...this.kinds].filter(
      ([candidate]) => candidate !== ROOT_PATH && isSameOrDescendant(candidate, path),
    );
  }

  private trackExistingUpsert(path: string): void {
    const kind = this.kinds.get(path);
    if (kind === undefined) {
      throw new SupabashError('INVALID_PATH', 'Path does not exist.', { path });
    }
    this.trackUpsert(path, kind);
  }

  private trackUpsert(path: string, kind: WorkspaceEntryKind): void {
    this.rememberParents(path);
    this.kinds.set(path, kind);
    this.deletions.delete(path);
    this.upserts.add(path);
  }

  private trackDeletion(path: string): void {
    const normalized = normalizeVirtualPath(path);
    const baseline = this.baseline.get(normalized);
    if (baseline !== undefined) {
      this.deletions.set(normalized, baseline);
    }
    this.upserts.delete(normalized);
    this.kinds.delete(normalized);
  }

  private rememberParents(path: string): void {
    for (const parent of parentPaths(path)) {
      this.kinds.set(parent, 'directory');
    }
  }

  private assertMutable(): void {
    if (this.commitInProgress) {
      throw new SupabashError('COMMIT_IN_PROGRESS', 'The filesystem is read-only during commit.');
    }
  }
}
