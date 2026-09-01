import { describe, expect, test } from 'vitest';

import { commandProgram } from '../../src/policy/ast.ts';

describe('unbash command projection', () => {
  test('projects pipelines, chains, redirects, and quoted words', () => {
    const program = commandProgram(
      String.raw`printf 'alpha\n' > /notes.md && cat /notes.md | sed 's/a/b/'`,
    );
    expect(program.ok).toBe(true);
    if (!program.ok) {
      return;
    }
    expect(program.segments.map((segment) => segment.head)).toStrictEqual(['printf', 'cat', 'sed']);
    expect(program.segments.map((segment) => segment.joiner ?? null)).toStrictEqual([
      '&&',
      '|',
      null,
    ]);
    expect(program.segments[0]?.redirects).toStrictEqual([
      { op: '>', target: { kind: 'literal', value: '/notes.md' } },
    ]);
  });

  test('traverses substitutions and compound forms', () => {
    const program = commandProgram(
      'value=$(cat /one.md); if test -n "$value"; then cat <(printf ok); fi',
    );
    expect(program.ok).toBe(true);
    if (!program.ok) {
      return;
    }
    expect(program.segments.map((segment) => segment.head)).toStrictEqual([
      'cat',
      'test',
      'printf',
      'cat',
    ]);
  });

  test('reports parse errors instead of guessing', () => {
    expect(commandProgram("cat 'unterminated")).toMatchObject({
      decision: { code: 'unsupported-syntax' },
      ok: false,
    });
  });

  test('keeps unresolved words dynamic instead of inventing a path', () => {
    const program = commandProgram('rm -rf "$UNSET" && rm $(echo /)');
    expect(program.ok).toBe(true);
    if (!program.ok) {
      return;
    }
    expect(program.segments.map((segment) => segment.head)).toStrictEqual(['rm', 'echo', 'rm']);
    expect(program.segments[0]?.words[2]).toMatchObject({ kind: 'dynamic' });
    expect(program.segments[2]?.words[1]).toMatchObject({ kind: 'dynamic' });
  });

  test('binds function arguments at the call site', () => {
    const program = commandProgram('evil() { rm -rf "$1"; }; evil /');
    expect(program.ok).toBe(true);
    if (!program.ok) {
      return;
    }
    expect(program.segments).toMatchObject([{ args: ['/'], head: 'rm' }]);
  });

  test('projects heredoc bodies without treating the delimiter as a path', () => {
    const program = commandProgram('cat <<EOF > /notes.md\nhello\nEOF');
    expect(program.ok).toBe(true);
    if (!program.ok) {
      return;
    }
    expect(program.segments[0]?.redirects).toStrictEqual([
      { op: '<<', target: { kind: 'literal', value: 'EOF' } },
      { op: '>', target: { kind: 'literal', value: '/notes.md' } },
    ]);
  });
});
