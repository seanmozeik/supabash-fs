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
});

const quotaError = (): Partial<SupabashError> => ({ code: 'QUOTA_EXCEEDED' });
