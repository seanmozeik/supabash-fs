import { describe, expect, test } from 'vitest';

import type { RemoteEntry, ScopedStorage, UploadEntry } from '../../src/core/storage.ts';
import { createStorageWorkspace } from '../../src/core/workspace.ts';
import type { HistoryBlobStore } from '../../src/history/blob-store.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

describe('publish mutation fault matrix', () => {
  test('recovers a coherent old or new tree before and after every mutation', async () => {
    const probe = mutationStorage(seed());
    await stageAndCommit(probe.storage);
    expect(probe.operations.length).toBeGreaterThan(5);

    for (const timing of ['before', 'after'] as const) {
      for (let index = 1; index <= probe.operations.length; index += 1) {
        const inner = seed();
        const fault = mutationStorage(inner, { index, timing });
        await expect(stageAndCommit(fault.storage)).rejects.toBeDefined();
        const reopened = await createStorageWorkspace(inner);
        const state = {
          kept: await reopened.fs.readFile('/keep.md'),
          removed: await reopened.fs.exists('/remove.md'),
        };
        expect(
          (state.kept === 'old\n' && state.removed) || (state.kept === 'new\n' && !state.removed),
          `${timing} mutation ${String(index)} (${fault.operations[index - 1]})`,
        ).toBe(true);
        const history = await reopened.history();
        expect(history.records.length).toBeLessThanOrEqual(1);
      }
    }
  });
});

const stageAndCommit = async (storage: ScopedStorage): Promise<void> => {
  const workspace = await createStorageWorkspace(storage);
  await workspace.fs.writeFile('/keep.md', 'new\n');
  await workspace.fs.rm('/remove.md');
  await workspace.commit({
    context: { actor: 'fault-test', correlationId: 'fault-matrix', idempotencyKey: 'fault-matrix' },
  });
};

const seed = (): MemoryStorage =>
  new MemoryStorage([
    { body: 'old\n', path: '/keep.md' },
    { body: 'remove\n', path: '/remove.md' },
  ]);

interface FaultPlan {
  readonly index: number;
  readonly timing: 'after' | 'before';
}

const mutationStorage = (
  inner: MemoryStorage,
  plan?: FaultPlan,
): { readonly operations: string[]; readonly storage: ScopedStorage } => {
  const operations: string[] = [];
  const mutate = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    operations.push(label);
    const selected = plan?.index === operations.length;
    if (selected && plan.timing === 'before') {
      throw new Error(`fault before ${label}`);
    }
    const result = await work();
    if (selected && plan.timing === 'after') {
      throw new Error(`fault after ${label}`);
    }
    return result;
  };
  const history: HistoryBlobStore = {
    get: (key) => inner.history.get(key),
    list: (prefix) => inner.history.list(prefix),
    put: (key, body) => mutate(`history.put:${key}`, () => inner.history.put(key, body)),
    remove: (keys) => inner.history.remove(keys),
  };
  return {
    operations,
    storage: {
      delete: (entries: readonly RemoteEntry[]) =>
        mutate('storage.delete', () => inner.delete(entries)),
      download: (entry: RemoteEntry) => inner.download(entry),
      head: (path: string) => inner.head(path),
      history,
      list: () => inner.list(),
      upload: (entry: UploadEntry) =>
        mutate(`storage.upload:${entry.path}`, () => inner.upload(entry)),
    },
  };
};
