import { describe, expect, test } from 'vitest';

import { gunzipSync, gzipSync } from '../../scripts/build/blocked-zlib.ts';
import { createCommandPolicy } from '../../src/policy/inspect.ts';

const policy = createCommandPolicy();

const blocked = [
  'gzip /data',
  'gzip -dc /data.gz',
  'gzip --uncompress /data.gz',
  'gzip -t /data.gz',
  'gzip --test /data.gz',
  'gzip --recursive /docs',
  'gunzip /data.gz',
  'gunzip -t /data.gz',
  'zcat /data.gz',
  '/bin/gzip /data',
  '/usr/bin/gunzip /data.gz',
  'rg -z needle /data.gz',
  'rg --search-zip needle /data.gz',
  'rg -inz needle /data.gz',
  'rg -zne needle /data.gz',
  'rg -nez needle /data.gz',
  'rg needle /data.gz -z',
  'rg --glob=*.gz -z needle /data.gz',
  'rg --pre=gzip needle /data',
  'rg --pre gunzip needle /data.gz',
  'rg --pre /bin/zcat needle /data.gz',
  'rg --pre /generated-script needle /data',
  'command gzip /data',
  'env MODE=test gunzip /data.gz',
  'timeout 2 rg -z needle /data.gz',
  "bash -c 'rg --search-zip needle /data.gz'",
  "sh -c 'zcat /data.gz'",
  String.raw`find /docs -exec gzip {} \;`,
  String.raw`find /docs -exec rg -nz needle {} \;`,
  String.raw`find /docs -exec rg --pre=zcat needle {} +`,
  'cat <(gunzip /data.gz)',
  'value=$(gzip -c /data); echo "$value"',
  'zip=-z; rg "$zip" needle /data.gz',
  'for zip in -z --search-zip; do rg "$zip" needle /data.gz; done',
  'search() { rg "$1" needle /data.gz; }; search -z',
];

describe('compression policy', () => {
  test.each(blocked)('denies %s with a typed reason', async (command) => {
    const decision = await policy.inspect(command);
    expect(decision).toMatchObject({ allow: false, code: 'compression-unsupported' });
    expect(decision.reason).toContain('Compression is not supported');
  });

  test.each([
    'rg needle /data.txt',
    'rg -n needle /data.txt',
    'rg -e -z /data.txt',
    'rg -ez /data.txt',
    'rg -ne -z /data.txt',
    'rg --regexp --search-zip /data.txt',
    'rg --regexp=--pre=gzip /data.txt',
    'rg -g*.gz needle /docs',
    'rg --glob *.gz needle /docs',
    'rg --pre-glob=*.gz needle /docs',
    'rg -f /z-patterns /data.txt',
    'rg -r gzip needle /data.txt',
    'grep -z needle /data.txt',
    'printf gzip',
    'file /data.gz',
    'cat /data.gz',
  ])('preserves non-compressing work: %s', async (command) => {
    await expect(policy.inspect(command)).resolves.toStrictEqual({ allow: true });
  });

  test('extraAllowCommands cannot re-enable compression', async () => {
    const extended = createCommandPolicy({ extraAllowCommands: ['gzip', 'gunzip', 'zcat'] });
    for (const command of ['gzip /data', 'gunzip /data.gz', 'zcat /data.gz']) {
      await expect(extended.inspect(command)).resolves.toMatchObject({
        allow: false,
        code: 'compression-unsupported',
      });
    }
  });

  test('both build stubs throw a clear error', () => {
    expect(gzipSync).toThrow('Compression is not supported in Supabash.');
    expect(gunzipSync).toThrow('Compression is not supported in Supabash.');
  });
});
