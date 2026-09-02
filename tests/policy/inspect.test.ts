import { describe, expect, test } from 'vitest';

import { createCommandPolicy } from '../../src/policy/inspect.ts';

const policy = createCommandPolicy();

describe('default command policy', () => {
  test('allows ordinary in-root filesystem work', async () => {
    await expect(
      policy.inspect(
        String.raw`printf 'alpha\n' > /notes.md && mkdir /docs && sed 's/a/b/' /notes.md`,
      ),
    ).resolves.toStrictEqual({ allow: true });
    await expect(policy.inspect('rm /notes.md')).resolves.toStrictEqual({ allow: true });
    await expect(policy.inspect('find /docs -name "*.md" | head')).resolves.toStrictEqual({
      allow: true,
    });
    await expect(
      policy.inspect(
        String.raw`for f in $(find . -type f -name '*.md' | sort); do grep -n needle "$f"; done`,
      ),
    ).resolves.toStrictEqual({ allow: true });
    await expect(
      policy.inspect(String.raw`find . -type f -name '*.md' -exec sed -i 's/a/b/' {} \;`),
    ).resolves.toStrictEqual({ allow: true });
  });

  test('allows lexical searches over generated file lists', async () => {
    await expect(
      policy.inspect(String.raw`grep -n '^description:\|^# ' notes.md other.md || true`),
    ).resolves.toStrictEqual({ allow: true });
    await expect(policy.inspect(String.raw`cat '$memory.md'`)).resolves.toStrictEqual({
      allow: true,
    });
  });

  test('denies root deletion, network, and reserved paths', async () => {
    await expect(policy.inspect('rm -rf /')).resolves.toMatchObject({
      allow: false,
      code: 'recursive-root',
    });
    await expect(policy.inspect('curl https://example.com')).resolves.toMatchObject({
      allow: false,
      code: 'network-disabled',
    });
    await expect(policy.inspect('cat /.supabash/head.json')).resolves.toMatchObject({
      allow: false,
      code: 'reserved-path',
    });
  });

  test('inspects wrappers and nested bash -c scripts', async () => {
    await expect(policy.inspect('command rm -rf /')).resolves.toMatchObject({
      allow: false,
      code: 'recursive-root',
    });
    await expect(policy.inspect(`bash -c 'rm -rf /'`)).resolves.toMatchObject({
      allow: false,
      code: 'recursive-root',
    });
    await expect(
      policy.inspect(`bash -c 'cat /memory.md' > ../../outside.md`),
    ).resolves.toMatchObject({ allow: false, code: 'path-out-of-root' });
    await expect(policy.inspect(`cd /notes; bash -c 'rm -rf .'`)).resolves.toStrictEqual({
      allow: true,
    });
    await expect(policy.inspect('env FOO=bar sudo ls')).resolves.toMatchObject({
      allow: false,
      code: 'host-escape',
    });
  });

  test('inspects commands nested in find -exec', async () => {
    await expect(
      policy.inspect(String.raw`find . -type f -exec curl https://example.com \;`),
    ).resolves.toMatchObject({ allow: false, code: 'network-disabled' });
    await expect(
      policy.inspect(String.raw`find . -type f -exec sudo cat {} \;`),
    ).resolves.toMatchObject({ allow: false, code: 'host-escape' });
    await expect(
      policy.inspect(String.raw`find . -type f -exec cat ../outside.md \;`),
    ).resolves.toMatchObject({ allow: false, code: 'path-out-of-root' });
    await expect(policy.inspect('find . -type f -exec sed {}')).resolves.toMatchObject({
      allow: false,
      code: 'unsupported-syntax',
    });
  });

  test('keeps file operands after attached search option values', async () => {
    await expect(policy.inspect('grep -m3 memory ../../outside.md')).resolves.toMatchObject({
      allow: false,
      code: 'path-out-of-root',
    });
    await expect(policy.inspect('grep -eMemory ../../outside.md')).resolves.toMatchObject({
      allow: false,
      code: 'path-out-of-root',
    });
    await expect(policy.inspect('grep -f../../patterns.txt memory.md')).resolves.toMatchObject({
      allow: false,
      code: 'path-out-of-root',
    });
  });

  test('lets extra inspectors tighten the default policy', async () => {
    const tight = createCommandPolicy({
      inspectors: [
        {
          inspect: (command: string) =>
            command.includes('sed')
              ? { allow: false, code: 'custom', reason: 'sed is blocked.' }
              : { allow: true },
        },
      ],
    });
    await expect(tight.inspect('sed s/a/b/ /notes.md')).resolves.toMatchObject({
      allow: false,
      code: 'custom',
    });
    await expect(tight.inspect('cat /notes.md')).resolves.toStrictEqual({ allow: true });
  });
});
