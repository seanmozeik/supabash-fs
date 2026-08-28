import { Bash } from 'just-bash/browser';
import { describe, expect, test } from 'vitest';

import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

describe('adapter-owned runtime paths', () => {
  test('never stages runtime files installed or changed by Just Bash', async () => {
    const storage = new MemoryStorage();
    const workspace = await createStorageWorkspace(storage);
    const bash = new Bash({ cwd: '/', fs: workspace.fs });

    await expect(bash.exec("printf 'scratch' > /tmp/scratch.txt")).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(workspace.changes()).toStrictEqual([]);
    await expect(workspace.commit()).resolves.toMatchObject({ changes: [] });
    expect(storage.text('/tmp/scratch.txt')).toBeUndefined();
  });

  test('does not project persisted entries below runtime roots', async () => {
    const workspace = await createStorageWorkspace(
      new MemoryStorage([
        { body: 'hidden', path: '/usr/private.txt' },
        { body: 'visible', path: '/notes.txt' },
      ]),
    );

    await expect(workspace.fs.exists('/usr/private.txt')).resolves.toBe(false);
    await expect(workspace.fs.readFile('/notes.txt')).resolves.toBe('visible');
  });
});
