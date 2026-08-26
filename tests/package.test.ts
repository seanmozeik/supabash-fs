import { describe, expect, test } from 'vitest';

import packageJson from '../package.json';

describe('package metadata', () => {
  test('is configured for public distribution', () => {
    expect(packageJson.name).toBe('@seanmozeik/supabash-fs');
    expect(packageJson.publishConfig.access).toBe('public');
    expect('private' in packageJson).toBe(false);
  });

  test('uses Bun as its package manager', () => {
    expect(packageJson.packageManager).toBe('bun@1.4.0');
  });

  test('has no Effect dependency', () => {
    const dependencyNames = Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
      ...packageJson.peerDependencies,
    });
    expect(dependencyNames).not.toContain('effect');
  });
});
