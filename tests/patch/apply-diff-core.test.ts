import { describe, expect, it } from 'vitest';

import { applyDiff } from '../../src/patch/apply-diff.ts';

const lines = (...values: string[]): string => values.join('\n');

describe('v4A applyDiff', () => {
  it('applies added lines to empty input via V4A floating hunk', () => {
    expect(applyDiff('', lines('@@', '+hello', '+world'))).toBe('hello\nworld\n');
  });

  it('applies plus-prefixed content for create mode', () => {
    expect(applyDiff('', lines('+hello', '+world', '+'), 'create')).toBe('hello\nworld\n');
  });

  it('rejects create diff without + prefixes', () => {
    expect(() => applyDiff('', lines('line1', 'line2'), 'create')).toThrow('Invalid Add File Line');
  });

  it('applies floating hunk without marker or line numbers', () => {
    const input = lines('- Milk', '- Bread', '- Eggs', '- Apples', '- Coffee');
    const diff = lines(
      '@@',
      ' - Milk',
      ' - Bread',
      ' - Eggs',
      '-- Apples',
      '-- Coffee',
      '+- [x] Apples',
      '+- [x] Coffee',
    );
    expect(applyDiff(input, diff)).toBe(
      lines('- Milk', '- Bread', '- Eggs', '- [x] Apples', '- [x] Coffee'),
    );
  });

  it('applies V4A replacements with context', () => {
    const input = `${lines('line1', 'line2', 'line3')}\n`;
    const diff = lines('@@ line1', '-line2', '+updated', ' line3');
    expect(applyDiff(input, diff)).toBe(`${lines('line1', 'updated', 'line3')}\n`);
  });

  it('applies V4A deletions', () => {
    const input = `${lines('keep', 'remove me', 'stay')}\n`;
    expect(applyDiff(input, lines('@@ keep', '-remove me', ' stay'))).toBe(
      `${lines('keep', 'stay')}\n`,
    );
  });

  it('applies V4A context marker diffs (class method rename)', () => {
    const input = `${lines(
      'class Foo:',
      '    def baz(self):',
      '        return f"foo {randint()}"',
      '',
      'def main():',
      '    foo = Foo()',
      '    print(foo.baz())',
    )}\n`;
    const diff = lines(
      '@@ class Foo:',
      '-    def baz(self):',
      '+    def rand(self):',
      '         return f"foo {randint()}"',
      '@@ def main():',
      '     foo = Foo()',
      '-    print(foo.baz())',
      '+    print(foo.rand())',
    );
    expect(applyDiff(input, diff)).toBe(
      `${lines(
        'class Foo:',
        '    def rand(self):',
        '        return f"foo {randint()}"',
        '',
        'def main():',
        '    foo = Foo()',
        '    print(foo.rand())',
      )}\n`,
    );
  });

  it('applies stacked anchors in sequence', () => {
    const input = `${lines(
      'class BaseClass',
      '    def search():',
      '        pass',
      '',
      'class Subclass',
      '    def search():',
      '        pass',
    )}\n`;
    const diff = lines(
      '@@ class BaseClass',
      '@@ def search():',
      '-        pass',
      '+        raise NotImplementedError()',
      '@@ class Subclass',
      '@@ def search():',
      '-        pass',
      '+        raise NotImplementedError()',
    );
    expect(applyDiff(input, diff)).toBe(
      `${lines(
        'class BaseClass',
        '    def search():',
        '        raise NotImplementedError()',
        '',
        'class Subclass',
        '    def search():',
        '        raise NotImplementedError()',
      )}\n`,
    );
  });

  it('reuses a prior parent anchor across stacked hunks', () => {
    const input = `${lines(
      'class Target',
      '    def first():',
      '        pass',
      '',
      '    def second():',
      '        pass',
    )}\n`;
    const diff = lines(
      '@@ class Target',
      '@@ def first():',
      '-        pass',
      '+        return 1',
      '@@ class Target',
      '@@ def second():',
      '-        pass',
      '+        return 2',
    );
    expect(applyDiff(input, diff)).toBe(
      `${lines(
        'class Target',
        '    def first():',
        '        return 1',
        '',
        '    def second():',
        '        return 2',
      )}\n`,
    );
  });

  it('uses each stacked anchor to narrow the target', () => {
    const input = `${lines(
      'class First',
      '    def target():',
      '        return 0',
      '',
      'class Second',
      '    def helper():',
      '        pass',
      '',
      '    def target():',
      '        pass',
    )}\n`;
    const diff = lines('@@ class Second', '@@ def target():', '-        pass', '+        return 1');
    expect(applyDiff(input, diff)).toBe(
      `${lines(
        'class First',
        '    def target():',
        '        return 0',
        '',
        'class Second',
        '    def helper():',
        '        pass',
        '',
        '    def target():',
        '        return 1',
      )}\n`,
    );
  });

  it('rejects partially matched stacked anchors', () => {
    const input = `${lines(
      'class Target',
      '    def helper():',
      '        pass',
      '',
      '    def desired():',
      '        return 1',
    )}\n`;
    const diff = lines(
      '@@ class Target',
      '@@ def missing():',
      '-        pass',
      '+        return 99',
    );
    expect(() => applyDiff(input, diff)).toThrow('Invalid Anchor');
  });

  it('rejects a stacked diff when its first anchor is missing', () => {
    const input = `${lines('class Wrong', '    def desired():', '        pass')}\n`;
    const diff = lines(
      '@@ class Target',
      '@@ def desired():',
      '-        pass',
      '+        return 99',
    );
    expect(() => applyDiff(input, diff)).toThrow('Invalid Anchor');
  });

  it('rejects a missing anchor followed by a bare marker', () => {
    expect(() => applyDiff('a\nb\n', lines('@@ missing', '@@', '-b', '+B'))).toThrow(
      'Invalid Anchor',
    );
  });

  it('accepts a trailing bare anchor in a stack', () => {
    expect(
      applyDiff(
        'class Only\n    def run():\n        pass\n',
        lines('@@ class Only', '@@', '-        pass', '+        return 1'),
      ),
    ).toBe('class Only\n    def run():\n        return 1\n');
  });

  it('treats line-number markers as context anchors', () => {
    expect(applyDiff('one\ntwo\n', lines('@@ -1,2 +1,2 @@', ' one', '-two', '+2'))).toBe(
      'one\n2\n',
    );
  });

  it('throws on context mismatch', () => {
    expect(() => applyDiff('one\ntwo\n', lines('@@ -1,2 +1,2 @@', ' x', '-two', '+2'))).toThrow(
      'Invalid Context',
    );
  });
});
