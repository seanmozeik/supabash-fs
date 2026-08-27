import { describe, expect, test } from 'vitest';

import { listedStorageKey } from '../../src/supabase/listed-key.ts';

describe('listed storage keys', () => {
  test('uses the explicit key when present', () => {
    expect(listedStorageKey('user-a/', { key: 'user-a/notes.md', name: 'notes.md' })).toBe(
      'user-a/notes.md',
    );
  });

  test('keeps a live list-v2 name that is already the full object path', () => {
    expect(
      listedStorageKey('user-a/.supabash/transactions/', {
        name: 'user-a/.supabash/transactions/tx/complete.json',
      }),
    ).toBe('user-a/.supabash/transactions/tx/complete.json');
  });

  test('joins a name that is relative to the list prefix', () => {
    expect(listedStorageKey('user-a/.supabash/transactions/', { name: 'tx/complete.json' })).toBe(
      'user-a/.supabash/transactions/tx/complete.json',
    );
  });
});
