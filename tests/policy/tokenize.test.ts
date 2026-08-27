import { describe, expect, test } from 'vitest';

import { segmentsFromTokens } from '../../src/policy/segments.ts';
import { tokenizeCommand } from '../../src/policy/tokenize.ts';

describe('command tokenizer', () => {
  test('splits pipelines, chains, and quoted words', () => {
    const tokens = tokenizeCommand(
      String.raw`printf 'alpha\n' > /notes.md && cat /notes.md | sed 's/a/b/'`,
    );
    expect(tokens.ok).toBe(true);
    if (!tokens.ok) {
      return;
    }
    const segments = segmentsFromTokens(tokens.tokens);
    expect(segments.map((segment) => segment.head)).toStrictEqual(['printf', 'cat', 'sed']);
    expect(segments.map((segment) => segment.joiner ?? null)).toStrictEqual(['&&', '|', null]);
    expect(segments[0]?.redirects).toStrictEqual([{ op: '>', target: '/notes.md' }]);
  });

  test('keeps operators inside quotes and treats comments as trivia', () => {
    const tokens = tokenizeCommand(`echo 'a|b' "c&&d" # ignore | curl`);
    expect(tokens.ok).toBe(true);
    if (!tokens.ok) {
      return;
    }
    expect(
      tokens.tokens.filter((token) => token.kind === 'word').map((token) => token.value),
    ).toStrictEqual(['echo', 'a|b', 'c&&d']);
  });

  test('rejects command substitution and here-documents', () => {
    expect(tokenizeCommand('echo $(whoami)')).toMatchObject({
      ok: false,
      decision: { code: 'unsupported-syntax' },
    });
    expect(tokenizeCommand('cat <<EOF\nhi\nEOF')).toMatchObject({
      ok: false,
      decision: { code: 'unsupported-syntax' },
    });
  });
});
