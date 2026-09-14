import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

import { Supabash } from '../../../dist/index.js';

assert.equal(process.env['MODAL_STRESS_REMOTE'], '1');
const url = process.env['API_URL'];
const key = process.env['ANON_KEY'];
const secret = process.env['JWT_SECRET'];
if (
  url === undefined ||
  key === undefined ||
  secret === undefined ||
  !url.endsWith('.modal.host')
) {
  throw new Error('Disposable Modal configuration required.');
}
const parseWrites = (parsed: unknown): ReadonlyMap<number, string> => {
  const writes = new Map<number, string>();
  assert.ok(Array.isArray(parsed));
  const pairs: readonly unknown[] = parsed;
  for (const pair of pairs) {
    assert.ok(Array.isArray(pair));
    const n: unknown = pair[0];
    const value: unknown = pair[1];
    assert.ok(typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 8192);
    assert.ok(typeof value === 'object' && value !== null && 'content' in value);
    const content: unknown = value.content;
    assert.ok(typeof content === 'string');
    writes.set(n, content);
  }
  return writes;
};
const expected = new Map<number, string>();
for (const filename of readdirSync('/results')
  .filter((name) => name.endsWith('-writes.json'))
  .toSorted()) {
  for (const [owner, content] of parseWrites(
    JSON.parse(readFileSync(`/results/${filename}`, 'utf8')),
  )) {
    expected.set(owner, content);
  }
}
assert.ok(expected.size > 0, 'No acknowledged writes were recorded.');
const id = (prefix: string, n: number): string =>
  `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const rows = [...expected];
let cursor = 0;
let verified = 0;
const started = performance.now();
await Promise.all(
  Array.from({ length: 32 }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor];
      cursor += 1;
      assert.ok(row !== undefined);
      const [n, content] = row;
      const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: id('1', n), role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
      const bearer = `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
      const workspace = await Supabash.openPostgres({
        workspace: id('2', n),
        supabaseUrl: url,
        publishableKey: key,
        request: new Request('https://stress.example.test', {
          headers: { authorization: `Bearer ${bearer}` },
        }),
      });
      assert.equal(
        await workspace.fs.readFile('/latest.md'),
        content,
        `Lost acknowledged value for owner ${n}.`,
      );
      verified += 1;
    }
  }),
);
const result = { verifiedOwners: verified, elapsedMs: performance.now() - started };
writeFileSync('/results/verified-after-crash.json', JSON.stringify(result, null, 2));
process.stdout.write(`${JSON.stringify(result)}\n`);
