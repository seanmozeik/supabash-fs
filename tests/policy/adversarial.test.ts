import { describe, expect, test } from 'vitest';

import { createStorageWorkspace } from '../../src/core/workspace.ts';
import { createCommandPolicy } from '../../src/policy/inspect.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

describe('adversarial command policy', () => {
  test('sees through quoting, whitespace, and chained commands', async () => {
    const policy = createCommandPolicy();
    await expect(policy.inspect(`rm -rf "/"`)).resolves.toMatchObject({ code: 'recursive-root' });
    await expect(policy.inspect("rm  -rf   '/'")).resolves.toMatchObject({
      code: 'recursive-root',
    });
    await expect(policy.inspect('true && rm -rf -- /')).resolves.toMatchObject({
      code: 'recursive-root',
    });
    await expect(policy.inspect('{ rm -rf /; }')).resolves.toMatchObject({
      code: 'recursive-root',
    });
  });

  test('rejects relative escapes, encoded separators, and globs at root', async () => {
    const policy = createCommandPolicy();
    await expect(policy.inspect('cat ../outside.md')).resolves.toMatchObject({
      code: 'path-out-of-root',
    });
    await expect(policy.inspect('cat /docs/%2e%2e/secret.md')).resolves.toMatchObject({
      code: 'ambiguous-path',
    });
    await expect(policy.inspect('rm *')).resolves.toMatchObject({ code: 'unbounded-work' });
    await expect(policy.inspect(String.raw`cat /docs\secret.md`)).resolves.toMatchObject({
      code: 'ambiguous-path',
    });
  });

  test('rejects process substitution, pipelines to curl, and fork bombs', async () => {
    const policy = createCommandPolicy();
    await expect(policy.inspect('cat <(echo hi)')).resolves.toMatchObject({
      code: 'unsupported-syntax',
    });
    await expect(policy.inspect('printf hi | curl https://example.com')).resolves.toMatchObject({
      code: 'network-disabled',
    });
    await expect(policy.inspect(':(){ :|:& };:')).resolves.toMatchObject({
      code: 'dangerous-command',
    });
  });

  test('rejects symlink targets that leave the mounted root', async () => {
    const workspace = await createStorageWorkspace(new MemoryStorage());
    await workspace.fs.writeFile('/notes.md', 'hello\n');
    await workspace.fs.symlink('../outside.md', '/alias.md');
    const policy = createCommandPolicy({ fs: workspace.fs });
    await expect(policy.inspect('cat /alias.md')).resolves.toMatchObject({
      code: 'path-out-of-root',
    });
    await expect(policy.inspect('ln -s ../outside.md /other.md')).resolves.toMatchObject({
      code: 'path-out-of-root',
    });
    await expect(policy.inspect('cd /docs && cat /alias.md')).resolves.toMatchObject({
      code: 'path-out-of-root',
    });
  });

  test('tracks cd before a relative destructive command', async () => {
    const policy = createCommandPolicy();
    await expect(policy.inspect('cd / && rm -rf .')).resolves.toMatchObject({
      code: 'recursive-root',
    });
    await expect(policy.inspect('cd /docs && rm -rf .')).resolves.toStrictEqual({ allow: true });
  });
});
