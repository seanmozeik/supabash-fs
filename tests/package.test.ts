import { describe, expect, test } from 'vitest';

import packageJson from '../package.json';

describe('package metadata', () => {
  test('is configured for public distribution', () => {
    expect(packageJson.name).toBe('@seanmozeik/supabash-fs');
    expect(packageJson.version).toBe('0.4.2');
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

  test('keeps AI SDK integration on an optional export subpath', () => {
    expect(packageJson.exports['./ai-sdk']).toStrictEqual({
      import: './dist/ai-sdk.js',
      types: './dist/ai-sdk/index.d.ts',
    });
    expect(packageJson.peerDependenciesMeta).toMatchObject({
      '@ai-sdk/openai': { optional: true },
      ai: { optional: true },
      'bash-tool': { optional: true },
    });
  });

  test('exports versioned Postgres installation and removal assets', () => {
    expect(packageJson.exports['./postgres/install.sql']).toBe('./sql/postgres/0001_install.sql');
    expect(packageJson.exports['./postgres/remove.sql']).toBe('./sql/postgres/0001_remove.sql');
    expect(packageJson.files).toContain('sql');
  });
});
