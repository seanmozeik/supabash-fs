import { describe, expect, it } from 'vitest';

import { applyDiff } from '../../src/patch/apply-diff.ts';
import { applyChunks } from '../../src/patch/v4a-context.ts';

const lines = (...values: string[]): string => values.join('\n');

describe('applyDiff local edge cases', () => {
  it('creates an empty file from a single plus line', () => {
    expect(applyDiff('', '+', 'create')).toBe('');
  });

  it('preserves a file that already has no final newline', () => {
    expect(applyDiff('alpha', lines('-alpha', '+beta'))).toBe('beta');
  });

  it('preserves a trailing newline from the original file', () => {
    expect(applyDiff('alpha\n', lines('-alpha', '+beta'))).toBe('beta\n');
  });

  it('accepts CRLF diff lines', () => {
    expect(applyDiff('one\ntwo\n', ' one\r\n-two\r\n+2\r\n')).toBe('one\n2\n');
  });

  it('matches repeated context at the first remaining occurrence', () => {
    const input = lines('repeat', 'first', 'repeat', 'second');
    const diff = lines(' repeat', '-second', '+changed');
    expect(applyDiff(input, diff)).toBe(lines('repeat', 'first', 'repeat', 'changed'));
  });

  it('matches unicode context after trimming surrounding space', () => {
    const input = 'café\nvalue\n';
    const diff = lines('@@ café', '-value', '+next');
    expect(applyDiff(input, diff)).toBe('café\nnext\n');
  });

  it('uses end-of-file markers to search from the tail', () => {
    const input = lines('keep', 'old', 'tail');
    const diff = lines(' old', '-tail', '+end', '*** End of File');
    expect(applyDiff(input, diff)).toBe(lines('keep', 'old', 'end'));
  });

  it('rejects overlapping hunks', () => {
    expect(() =>
      applyChunks('a\nb\n', [
        { delLines: ['a'], insLines: ['A'], origIndex: 0 },
        { delLines: ['a'], insLines: ['B'], origIndex: 0 },
      ]),
    ).toThrow('overlapping chunk');
  });

  it('rejects stale context', () => {
    expect(() => applyDiff('current\n', lines(' missing', '-current', '+next'))).toThrow(
      'Invalid Context',
    );
  });
});
