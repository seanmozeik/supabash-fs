import { SupabashError } from '../api/errors.js';
import type { HistoryBlobStore } from '../history/blob-store.js';
import { HISTORY_ROOT, assertHistoryKey } from '../history/keys.js';
import { listedStorageKey } from './listed-key.js';

type BucketApi = {
  readonly download: (key: string) => Promise<{ data: Blob | null; error: unknown }>;
  readonly listV2: (
    options: { cursor?: string; limit: number; prefix: string },
    extra?: { cache?: RequestCache },
  ) => Promise<{
    data: {
      folders?: readonly { name: string }[];
      hasNext: boolean;
      nextCursor?: string;
      objects: readonly { key?: string; name: string }[];
    } | null;
    error: unknown;
  }>;
  readonly remove: (keys: string[]) => Promise<{ error: unknown }>;
  readonly upload: (
    key: string,
    body: Uint8Array,
    options: { cacheControl: string; contentType: string; upsert: boolean },
  ) => Promise<{ error: unknown }>;
};

const LIST_PAGE_SIZE = 1000;
const REMOVE_BATCH = 1000;

export class SupabaseHistoryStore implements HistoryBlobStore {
  private readonly bucket: BucketApi;
  private readonly root: string;

  constructor(bucket: BucketApi, root: string) {
    this.bucket = bucket;
    this.root = root;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const response = await this.bucket.download(this.storageKey(key));
    if (response.error !== null) {
      if (isNotFound(response.error)) {
        return undefined;
      }
      throw storageFailure('history-download', response.error);
    }
    if (response.data === null) {
      return undefined;
    }
    return new Uint8Array(await response.data.arrayBuffer());
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const response = await this.bucket.upload(this.storageKey(key), body, {
      cacheControl: '0',
      contentType: 'application/octet-stream',
      upsert: true,
    });
    if (response.error !== null) {
      throw storageFailure('history-upload', response.error);
    }
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += REMOVE_BATCH) {
      const batch = keys.slice(index, index + REMOVE_BATCH).map((key) => this.storageKey(key));
      const response = await this.bucket.remove(batch);
      if (response.error !== null) {
        throw storageFailure('history-remove', response.error);
      }
    }
  }

  async list(prefix: string): Promise<readonly string[]> {
    assertHistoryKey(prefix.endsWith('/') ? `${prefix}x` : prefix);
    const keys: string[] = [];
    const prefixes = [`${this.root}${prefix}`];
    const seen = new Set<string>();
    while (prefixes.length > 0) {
      const current = prefixes.pop() ?? '';
      if (current.length > 0 && !seen.has(current)) {
        seen.add(current);
        await this.collect(current, keys, prefixes);
      }
    }
    return keys;
  }

  private async collect(storagePrefix: string, keys: string[], prefixes: string[]): Promise<void> {
    let cursor: string | undefined;
    do {
      const response = await this.bucket.listV2(
        { ...(cursor !== undefined && { cursor }), limit: LIST_PAGE_SIZE, prefix: storagePrefix },
        { cache: 'no-store' },
      );
      if (response.error !== null || response.data === null) {
        throw storageFailure('history-list', response.error);
      }
      for (const folder of response.data.folders ?? []) {
        const name = folder.name.replace(/^\/+/u, '').replace(/\/+$/u, '');
        if (name.length > 0) {
          prefixes.push(folderPrefix(storagePrefix, name));
        }
      }
      for (const object of response.data.objects) {
        const key = listedStorageKey(storagePrefix, object);
        if (key.startsWith(this.root)) {
          keys.push(key.slice(this.root.length));
        }
      }
      cursor = response.data.hasNext ? response.data.nextCursor : undefined;
    } while (cursor !== undefined);
  }

  private storageKey(key: string): string {
    assertHistoryKey(key);
    const storageKey = `${this.root}${key}`;
    if (!storageKey.startsWith(`${this.root}${HISTORY_ROOT}/`)) {
      throw new SupabashError('AUTHORIZATION', 'History key escaped the private namespace.');
    }
    return storageKey;
  }
}

const folderPrefix = (parent: string, name: string): string => {
  if (name.startsWith(parent)) {
    return name.endsWith('/') ? name : `${name}/`;
  }
  const base = parent.endsWith('/') ? parent : `${parent}/`;
  return `${base}${name}/`;
};

const isNotFound = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if (!('status' in error) && !('statusCode' in error) && !('code' in error)) {
    return false;
  }
  const status = 'status' in error ? error.status : undefined;
  const statusCode = 'statusCode' in error ? error.statusCode : undefined;
  const code = 'code' in error ? error.code : undefined;
  return status === 404 || statusCode === '404' || statusCode === 404 || code === 'not_found';
};

const storageFailure = (operation: string, cause: unknown): SupabashError =>
  new SupabashError('STORAGE', `Supabase Storage operation failed during ${operation}.`, { cause });
