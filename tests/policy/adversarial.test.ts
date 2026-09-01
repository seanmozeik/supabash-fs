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
    await expect(policy.inspect(String.raw`cat /docs\secret.md`)).resolves.toStrictEqual({
      allow: true,
    });
  });

  test('inspects process substitution, pipelines, and fork bombs', async () => {
    const policy = createCommandPolicy();
    await expect(policy.inspect('cat <(echo hi)')).resolves.toMatchObject({
      code: 'unsupported-syntax',
    });
    await expect(policy.inspect('cat <(curl https://example.com)')).resolves.toMatchObject({
      code: 'network-disabled',
    });
    await expect(policy.inspect('printf hi | curl https://example.com')).resolves.toMatchObject({
      code: 'network-disabled',
    });
    await expect(policy.inspect(':(){ :|:& };:')).resolves.toMatchObject({
      code: 'dangerous-command',
    });
  });

  test('resolves literal variables and inspects compound Bash syntax', async () => {
    const policy = createCommandPolicy();
    await expect(policy.inspect('root=/; rm -rf "$root"')).resolves.toMatchObject({
      code: 'recursive-root',
    });
    await expect(
      policy.inspect('for file in /one.md /two.md; do grep -q needle "$file" || true; done'),
    ).resolves.toStrictEqual({ allow: true });
    await expect(
      policy.inspect('if test -f /one.md; then cat /one.md; else cat /two.md; fi'),
    ).resolves.toStrictEqual({ allow: true });
    await expect(
      policy.inspect('result=$(curl https://example.com); echo "$result"'),
    ).resolves.toMatchObject({ code: 'network-disabled' });
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

  test('fails closed on unresolved paths and inspects function calls', async () => {
    const policy = createCommandPolicy();
    await expect(policy.inspect('rm -rf "$UNSET"')).resolves.toMatchObject({
      code: 'unsupported-syntax',
    });
    await expect(policy.inspect('rm $(echo /)')).resolves.toMatchObject({
      code: 'unsupported-syntax',
    });
    await expect(policy.inspect('evil() { rm -rf "$1"; }; evil /')).resolves.toMatchObject({
      code: 'recursive-root',
    });
    await expect(policy.inspect('cat <<EOF > /notes.md\nhello\nEOF')).resolves.toStrictEqual({
      allow: true,
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
