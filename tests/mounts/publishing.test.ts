import { expect, test } from 'vitest';

import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { createMountedFileSystem } from '../../src/mounts/compose.ts';
import { readWorkspaceSnapshot } from '../../src/mounts/snapshot.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

test('publisher upserts, deletes and restores shared files while agent turns retain their releases', async () => {
  const publisher = await createStorageWorkspace(new MemoryStorage());
  await publisher.fs.mkdir('/guides');
  await publisher.fs.writeFile('/guides/help.md', 'first release');
  await publisher.fs.writeFile('/old.md', 'retired later');
  const first = await publisher.commit();
  const snapshot = await readWorkspaceSnapshot({
    workspace: publisher,
    sourceId: 'app-docs',
    revision: first.revision,
  });
  const turn = createMountedFileSystem([{ access: 'read-only', mountPoint: '/docs', snapshot }]);

  await publisher.fs.writeFile('/guides/help.md', 'updated');
  await publisher.fs.writeFile('/new.md', 'new page');
  await publisher.fs.rm('/old.md');
  const second = await publisher.commit();
  const updated = await readWorkspaceSnapshot({
    workspace: publisher,
    sourceId: 'app-docs',
    revision: second.revision,
  });
  expect({
    old: await turn.fs.readFile('/docs/guides/help.md'),
    updated: await updated.fs.readFile('/guides/help.md'),
    oldRetained: await turn.fs.exists('/docs/old.md'),
    newRemoved: await updated.fs.exists('/old.md'),
  }).toStrictEqual({
    old: 'first release',
    updated: 'updated',
    oldRetained: true,
    newRemoved: false,
  });
  await expect(turn.fs.writeFile('/docs/guides/help.md', 'agent edit')).rejects.toMatchObject({
    code: 'POLICY_DENIED',
  });

  await publisher.restore(first.revision);
  const restored = await publisher.commit();
  expect(restored.revision).not.toBe(first.revision);
  expect({
    restored: await publisher.fs.readFile('/guides/help.md'),
    stillPublished: await updated.fs.readFile('/guides/help.md'),
    restoredRemoved: await publisher.fs.exists('/new.md'),
  }).toStrictEqual({
    restored: 'first release',
    stillPublished: 'updated',
    restoredRemoved: false,
  });
});
