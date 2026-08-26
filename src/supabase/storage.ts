import type { SupabaseClient } from '@supabase/supabase-js';

import { SupabashError } from '../api/errors.js';
import { mapInBatches } from '../core/batches.js';
import { comparePaths } from '../core/entry-order.js';
import { normalizeVirtualPath, relativeObjectPath } from '../core/path.js';
import type { RemoteEntry, ScopedStorage, UploadEntry } from '../core/storage.js';
import {
  contentTypeFor,
  entryFromInfo,
  kindFromInfo,
  metadataFor,
  type StorageObjectInfo,
} from './object-metadata.js';

const LIST_PAGE_SIZE = 1000;
const METADATA_CONCURRENCY = 16;
const REMOVE_BATCH_SIZE = 1000;
const SAFE_BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const SAFE_ROOT_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/u;

type BucketApi = ReturnType<SupabaseClient['storage']['from']>;

interface ListedObject {
  readonly key?: string;
  readonly name: string;
}

export const createSupabaseStorage = (
  client: SupabaseClient,
  bucket: string,
  userId: string,
): ScopedStorage => {
  assertBucket(bucket);
  assertRootSegment(userId);
  return new SupabaseStorage(client.storage.from(bucket), `${userId}/`);
};

class SupabaseStorage implements ScopedStorage {
  private readonly bucket: BucketApi;
  private readonly root: string;

  constructor(bucket: BucketApi, root: string) {
    this.bucket = bucket;
    this.root = root;
  }

  async list(): Promise<readonly RemoteEntry[]> {
    const objects: ListedObject[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.bucket.listV2(
        { ...(cursor !== undefined && { cursor }), limit: LIST_PAGE_SIZE, prefix: this.root },
        { cache: 'no-store' },
      );
      if (response.error !== null) {
        throw storageFailure('list', response.error);
      }
      objects.push(...response.data.objects);
      cursor = response.data.hasNext ? response.data.nextCursor : undefined;
      if (response.data.hasNext && cursor === undefined) {
        throw storageFailure('list', new Error('Supabase omitted the next list cursor.'));
      }
    } while (cursor !== undefined);

    const hydrated = await mapInBatches(objects, METADATA_CONCURRENCY, (object) =>
      this.entryFromList(object),
    );
    const entries = new Map<string, RemoteEntry>();
    for (const entry of hydrated) {
      if (entry !== undefined) {
        if (entries.has(entry.path)) {
          throw storageFailure('list', new Error(`Duplicate stored path: ${entry.path}`));
        }
        entries.set(entry.path, entry);
      }
    }
    return [...entries.values()].toSorted((left, right) => comparePaths(left.path, right.path));
  }

  async download(entry: RemoteEntry): Promise<Uint8Array> {
    if (entry.kind !== 'file') {
      throw storageFailure('download', new Error('Only regular files have downloadable bodies.'), {
        path: entry.path,
      });
    }
    const response = await this.bucket.download(this.keyFor(entry));
    if (response.error !== null) {
      throw storageFailure('download', response.error, { path: entry.path });
    }
    return new Uint8Array(await response.data.arrayBuffer());
  }

  async head(path: string): Promise<RemoteEntry | undefined> {
    const normalized = normalizeVirtualPath(path);
    const info = await this.info(this.keyForPath(normalized));
    return info === undefined ? undefined : entryFromInfo(normalized, kindFromInfo(info), info);
  }

  async upload(entry: UploadEntry): Promise<RemoteEntry> {
    const body = entry.body ?? new TextEncoder().encode(entry.target ?? '');
    const key = this.keyFor(entry);
    const response = await this.bucket.upload(key, body, {
      cacheControl: '0',
      contentType: contentTypeFor(entry),
      metadata: metadataFor(entry),
      upsert: true,
    });
    if (response.error !== null) {
      throw storageFailure('upload', response.error, { path: entry.path });
    }
    const uploadedInfo = await this.info(key);
    if (uploadedInfo === undefined) {
      throw storageFailure('upload', new Error('Uploaded entry could not be read back.'), {
        path: entry.path,
      });
    }
    return entryFromInfo(entry.path, entry.kind, uploadedInfo);
  }

  async delete(entries: readonly RemoteEntry[]): Promise<void> {
    const keys = entries.map((entry) => this.keyFor(entry));
    for (let index = 0; index < keys.length; index += REMOVE_BATCH_SIZE) {
      const response = await this.bucket.remove(keys.slice(index, index + REMOVE_BATCH_SIZE));
      if (response.error !== null) {
        throw storageFailure('delete', response.error);
      }
    }
  }

  private async info(key: string): Promise<StorageObjectInfo | undefined> {
    const response = await this.bucket.info(key);
    if (response.error === null) {
      return response.data;
    }
    if (isNotFound(response.error)) {
      return undefined;
    }
    throw storageFailure('head', response.error);
  }

  private async entryFromList(object: ListedObject): Promise<RemoteEntry | undefined> {
    const key =
      object.key ??
      (object.name.startsWith(this.root)
        ? object.name
        : `${this.root}${object.name.replace(/^\/+/u, '')}`);
    const relative = this.relativeKey(key);
    const path = normalizeVirtualPath(`/${relative}`);
    const info = await this.info(key);
    return info === undefined ? undefined : entryFromInfo(path, kindFromInfo(info), info);
  }

  private keyFor(entry: Pick<RemoteEntry, 'path'>): string {
    return this.keyForPath(entry.path);
  }

  private keyForPath(path: string): string {
    const relative = relativeObjectPath(path);
    const key = `${this.root}${relative}`;
    if (!key.startsWith(this.root)) {
      throw new SupabashError('AUTHORIZATION', 'Stored key escaped the authenticated root.', {
        path,
      });
    }
    return key;
  }

  private relativeKey(key: string): string {
    if (!key.startsWith(this.root)) {
      throw new SupabashError('AUTHORIZATION', 'Supabase returned a key outside the user root.');
    }
    return key.slice(this.root.length);
  }
}

const isNotFound = (error: unknown): boolean => {
  if (!isRecord(error)) {
    return false;
  }
  const statuses = [error['status'], error['statusCode']];
  return (
    statuses.some((status) => status === 404 || status === '404') || error['code'] === 'not_found'
  );
};

const assertBucket = (bucket: string): void => {
  if (!SAFE_BUCKET.test(bucket)) {
    throw new SupabashError('AUTHORIZATION', 'Bucket must be one safe storage identifier.');
  }
};

const assertRootSegment: (userId: unknown) => asserts userId is string = (userId) => {
  if (!isSafeRootSegment(userId)) {
    throw new SupabashError('AUTHORIZATION', 'Verified user ID is not a safe storage segment.');
  }
};

const isSafeRootSegment = (value: unknown): value is string =>
  typeof value === 'string' && SAFE_ROOT_SEGMENT.test(value);

const storageFailure = (
  operation: string,
  cause: unknown,
  options: { readonly path?: string } = {},
): SupabashError =>
  new SupabashError('STORAGE', `Supabase Storage operation failed during ${operation}.`, {
    cause,
    ...(options.path !== undefined && { path: options.path }),
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
