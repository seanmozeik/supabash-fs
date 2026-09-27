import { readFile } from 'node:fs/promises';

import { expect, test } from 'vitest';

// This is an upstream audit tripwire, not a general JavaScript parser. If the
// pinned prebundle changes, re-trace its compression callers before updating it.
test('pins every zlib import and operation site in just-bash 3.4.2/browser', async () => {
  const source = await readFile(new URL(import.meta.resolve('just-bash/browser')), 'utf8');
  const imports = [...source.matchAll(/import\{(?<bindings>[^}]+)\}from"node:zlib"/gu)].map(
    (match) => match.groups?.['bindings'],
  );
  expect(imports).toStrictEqual([
    'gunzipSync as bx',
    'constants as Cf,gunzipSync as pv,gzipSync as hv',
  ]);
  for (const name of ['bx', 'pv', 'hv']) {
    expect([...source.matchAll(new RegExp(`\\b${name}\\(`, 'gu'))]).toHaveLength(1);
  }
  expect(source).toContain('if(r.searchZip&&n.endsWith(".gz"))');
  expect(source).toContain('["z",e=>{e.searchZip=!0}],["--search-zip",e=>{e.searchZip=!0}]');
  expect(source).toContain('await e.exec(vn([r.preprocessor])');
});
