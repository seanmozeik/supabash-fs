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
    await expect(policy.inspect('env FOO=bar sudo ls')).resolves.toMatchObject({
      allow: false,
      code: 'host-escape',
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
