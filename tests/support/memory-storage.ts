import { comparePaths } from '../../src/core/entry-order.ts';
import type { RemoteEntry, ScopedStorage, UploadEntry } from '../../src/core/storage.ts';

export interface SeedFile {
  readonly body: string | Uint8Array;
  readonly contentType?: string;
  readonly path: string;
}

interface StoredEntry {
  readonly body: Uint8Array;
  readonly remote: RemoteEntry;
}

const DEFAULT_MODE = 0o644;

export class MemoryStorage implements ScopedStorage {
  readonly downloads: string[] = [];
  private etagSequence = 0;
  private readonly entries = new Map<string, StoredEntry>();

  constructor(seedFiles: readonly SeedFile[] = []) {
    for (const seed of seedFiles) {
      this.setFile(seed.path, toBytes(seed.body), seed.contentType);
    }
  }

  list(): Promise<readonly RemoteEntry[]> {
    const entries = [...this.entries.values()]
      .map(({ remote }) => remote)
      .toSorted((left, right) => comparePaths(left.path, right.path));
    return Promise.resolve(entries);
  }

  download(entry: RemoteEntry): Promise<Uint8Array> {
    const stored = this.entries.get(entry.path);
    if (stored === undefined) {
      throw new Error(`Missing test entry: ${entry.path}`);
    }
    this.downloads.push(entry.path);
    return Promise.resolve(Uint8Array.from(stored.body));
  }

  head(path: string): Promise<RemoteEntry | undefined> {
    return Promise.resolve(this.entries.get(path)?.remote);
  }

  upload(entry: UploadEntry): Promise<RemoteEntry> {
    const body = entry.body ?? new TextEncoder().encode(entry.target ?? '');
    const remote: RemoteEntry = {
      ...(entry.contentHash !== undefined && { contentHash: entry.contentHash }),
      ...(entry.contentType !== undefined && { contentType: entry.contentType }),
      etag: this.nextEtag(),
      kind: entry.kind,
      mode: entry.mode,
      modifiedAt: entry.modifiedAt,
      path: entry.path,
      size: body.byteLength,
      ...(entry.target !== undefined && { target: entry.target }),
      versionHash: entry.versionHash,
    };
    this.entries.set(entry.path, { body: Uint8Array.from(body), remote });
    return Promise.resolve(remote);
  }

  delete(entries: readonly RemoteEntry[]): Promise<void> {
    for (const entry of entries) {
      this.entries.delete(entry.path);
    }
    return Promise.resolve();
  }

  putExternal(path: string, body: string): void {
    this.setFile(path, new TextEncoder().encode(body));
  }

  text(path: string): string | undefined {
    const body = this.entries.get(path)?.body;
    return body === undefined ? undefined : new TextDecoder().decode(body);
  }

  private setFile(path: string, body: Uint8Array, contentType?: string): void {
    const modifiedAt = new Date();
    this.entries.set(path, {
      body: Uint8Array.from(body),
      remote: {
        ...(contentType !== undefined && { contentType }),
        etag: this.nextEtag(),
        kind: 'file',
        mode: DEFAULT_MODE,
        modifiedAt,
        path,
        size: body.byteLength,
      },
    });
  }

  private nextEtag(): string {
    this.etagSequence += 1;
    return `etag-${this.etagSequence}`;
  }
}

const toBytes = (body: string | Uint8Array): Uint8Array =>
  typeof body === 'string' ? new TextEncoder().encode(body) : Uint8Array.from(body);
