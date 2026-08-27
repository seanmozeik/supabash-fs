import { describe, expect, test } from 'vitest';

import { SupabashError } from '../../src/api/errors.ts';
import { moveDescendant, normalizeVirtualPath, relativeObjectPath } from '../../src/core/path.ts';

describe('virtual paths', () => {
  test('normalizes paths without allowing a root escape', () => {
    expect(normalizeVirtualPath('docs/./guides/../readme.md')).toBe('/docs/readme.md');
    expect(() => normalizeVirtualPath('/../../another-user/file.md')).toThrow(
      expect.objectContaining({ code: 'INVALID_PATH' }),
    );
  });

  test.each([
    String.raw`/docs\secret.md`,
    '/docs/%2Fsecret.md',
    '/docs/%2e%2e/secret.md',
    '/.supabash/config.json',
    '/.supabash-directory',
    '/docs/secret\u0000.md',
  ])('rejects ambiguous or reserved path %s', (path) => {
    expect(() => normalizeVirtualPath(path)).toThrow(SupabashError);
  });

  test('maps descendant paths without string-prefix collisions', () => {
    expect(moveDescendant('/docs/a/readme.md', '/docs', '/archive')).toBe('/archive/a/readme.md');
    expect(() => moveDescendant('/docs-old/readme.md', '/docs', '/archive')).toThrow(SupabashError);
  });

  test('does not map the virtual root to an object', () => {
    expect(() => relativeObjectPath('/')).toThrow(SupabashError);
  });
});
