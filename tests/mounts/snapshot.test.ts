import { describe, expect, test } from 'vitest';

import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { createFileSystemSnapshot, readWorkspaceSnapshot } from '../../src/mounts/snapshot.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

describe('shared text snapshots', () => {
  test('detaches table rows, fingerprints content, and rejects mutation', async () => {
    const file = { path: '/a.md', content: 'original' };
    const files = [file];
    const snapshot = await createFileSystemSnapshot({ sourceId: 'docs', revision: 'v1', files });
    file.content = 'changed';
    await expect(snapshot.fs.writeFile('/a.md', 'bad')).rejects.toMatchObject({
      code: 'AUTHORIZATION',
    });
    await expect(snapshot.fs.rm('/a.md')).rejects.toMatchObject({ code: 'AUTHORIZATION' });
    const buffer = await snapshot.fs.readFileBuffer('/a.md');
    buffer.fill(0);
    await expect(snapshot.fs.readFile('/a.md')).resolves.toBe('original');
    const same = await createFileSystemSnapshot({
      sourceId: 'another',
      revision: 'v2',
      files: [{ path: '/a.md', content: 'original' }],
    });
    expect({
      digest: same.digest,
      fileCount: snapshot.fileCount,
      byteCount: snapshot.byteCount,
    }).toStrictEqual({ digest: snapshot.digest, fileCount: 1, byteCount: 8 });
  });

  test('rejects ambiguous trees and enforces UTF-8 quotas', async () => {
    for (const files of [
      [{ path: 'relative', content: '' }],
      [{ path: '/', content: '' }],
      [
        { path: '/a', content: '' },
        { path: '/a/b', content: '' },
      ],
      [
        { path: '/a', content: '' },
        { path: '/./a', content: '' },
      ],
    ]) {
      await expect(
        createFileSystemSnapshot({ sourceId: 'docs', revision: 'v1', files }),
      ).rejects.toMatchObject({ code: 'INVALID_PATH' });
    }
    await expect(
      createFileSystemSnapshot({
        sourceId: 'docs',
        revision: 'v1',
        files: [{ path: '/a', content: 'é' }],
        limits: { maxBytes: 1 },
      }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  test('pins a committed revision across later edits, restore, and independent user work', async () => {
    const publisher = await createStorageWorkspace(new MemoryStorage());
    await publisher.fs.writeFile('/help.md', 'published v1');
    const receipt = await publisher.commit();
    const snapshot = await readWorkspaceSnapshot({
      workspace: publisher,
      sourceId: 'docs',
      revision: receipt.revision,
    });
    await publisher.fs.writeFile('/help.md', 'published v2');
    await publisher.commit();
    await expect(snapshot.fs.readFile('/help.md')).resolves.toBe('published v1');
    expect(snapshot.revision).toBe(receipt.revision);
  });

  test('rejects a binary revision instead of silently replacing invalid UTF-8 bytes', async () => {
    const publisher = await createStorageWorkspace(new MemoryStorage());
    await publisher.fs.writeFile('/binary', new Uint8Array([0xff, 0xfe]));
    const receipt = await publisher.commit();
    await expect(
      readWorkspaceSnapshot({ workspace: publisher, sourceId: 'docs', revision: receipt.revision }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' });
  });
});
