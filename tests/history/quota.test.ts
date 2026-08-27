import { describe, expect, test } from 'vitest';

import type { SupabashError } from '../../src/api/errors.ts';
import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

describe('workspace commit quotas', () => {
  test('rejects a file larger than the configured maximum before durable writes', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage, { limits: { maxFileSize: 4 } });
    await workspace.fs.writeFile('/notes.md', 'hello\n');
    await expect(workspace.commit()).rejects.toMatchObject(quotaError());
    expect(storage.text('/notes.md')).toBeUndefined();
  });

  test('rejects commit metadata that exceeds the configured byte budget', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage(), {
      limits: { maxTransactionMetadataBytes: 8 },
    });
    await workspace.fs.writeFile('/notes.md', 'ok\n');
    await expect(
      workspace.commit({
        context: { actor: 'test', correlationId: 'c1', metadata: { note: 'this-is-too-long' } },
      }),
    ).rejects.toMatchObject(quotaError());
  });

  test('rejects a history page larger than the configured limit', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage(), {
      limits: { maxHistoryPageSize: 1 },
    });
    await workspace.fs.writeFile('/notes.md', 'ok\n');
    await workspace.commit();
    await expect(workspace.history({ limit: 2 })).rejects.toMatchObject(quotaError());
  });

  test('accepts file and staged byte limits at the exact boundary', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage(), {
      limits: { maxFileSize: 4, maxStagedBytes: 4 },
    });
    await workspace.fs.writeFile('/a', 'four');
    await expect(workspace.commit()).resolves.toMatchObject({ status: 'complete' });
  });

  test('rejects a staged byte total above the boundary', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage, { limits: { maxStagedBytes: 4 } });
    await workspace.fs.writeFile('/a', '123');
    await workspace.fs.writeFile('/b', '45');
    await expect(workspace.commit()).rejects.toMatchObject(quotaError());
    expect({ a: storage.text('/a'), b: storage.text('/b') }).toStrictEqual({
      a: undefined,
      b: undefined,
    });
  });

  test('enforces visible file and path limits at their boundaries', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage, {
      limits: { maxPathLength: 2, maxVisibleFiles: 1 },
    });
    await workspace.fs.writeFile('/a', 'ok');
    await expect(workspace.commit()).resolves.toMatchObject({ status: 'complete' });
    await workspace.fs.writeFile('/b', 'extra');
    await expect(workspace.commit()).rejects.toMatchObject(quotaError());

    const longPath = await createStorageWorkspace(new MemoryStorage(), {
      limits: { maxPathLength: 2 },
    });
    await longPath.fs.writeFile('/ab', 'long');
    await expect(longPath.commit()).rejects.toMatchObject(quotaError());
  });

  test('accepts transaction metadata at the exact encoded byte boundary', async () => {
    const metadata = { note: 'ok' } as const;
    const bytes = new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
    const workspace = await createStorageWorkspace(new MemoryStorage(), {
      limits: { maxTransactionMetadataBytes: bytes },
    });
    await workspace.fs.writeFile('/notes.md', 'ok\n');
    await expect(
      workspace.commit({ context: { actor: 'test', correlationId: 'c1', metadata } }),
    ).resolves.toMatchObject({ metadata });
  });

  test('rejects invalid host limits with a typed quota error', async () => {
    await expect(
      createStorageWorkspace(new MemoryStorage(), { limits: { maxFileSize: Number.NaN } }),
    ).rejects.toMatchObject(quotaError());
    await expect(
      createStorageWorkspace(new MemoryStorage(), { maxFileSystemBytes: -1 }),
    ).rejects.toMatchObject(quotaError());
    await expect(
      createStorageWorkspace(new MemoryStorage(), { uploadConcurrency: 0 }),
    ).rejects.toMatchObject(quotaError());
  });

  test('rejects invalid purge limits with a typed quota error', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    await expect(workspace.purge({ maxAgeMs: -1 })).rejects.toMatchObject(quotaError());
    await expect(workspace.purge({ maxRevisions: 1.5 })).rejects.toMatchObject(quotaError());
  });
});

const quotaError = (): Partial<SupabashError> => ({ code: 'QUOTA_EXCEEDED' });
