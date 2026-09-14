import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import {
  Supabash,
  isUnknownOutcomeSupabashError,
  isRetryableSupabashError,
} from '../../../dist/index.js';

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
const user = '10000000-0000-4000-8000-000000009005';
const workspace = '20000000-0000-4000-8000-000000009005';
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
const bearer = `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
let drop = true;
let rejectSession = true;
let commits = 0;
const observedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = new URL(input instanceof Request ? input.url : input).pathname;
  if (path.endsWith('/auth/v1/user') && rejectSession) {
    rejectSession = false;
    return new Response('Synthetic Auth service outage.', { status: 503 });
  }
  const response = await fetch(input, { ...init, signal: AbortSignal.timeout(15_000) });
  if (path.endsWith('/supabash_commit')) {
    commits += 1;
    if (drop && response.ok) {
      await response.arrayBuffer();
      drop = false;
      throw new TypeError('Synthetic lost response after the database accepted the commit.');
    }
  }
  return response;
};
const options = {
  workspace,
  supabaseUrl: url,
  publishableKey: key,
  request: new Request('https://stress.example.test', {
    headers: { authorization: `Bearer ${bearer}` },
  }),
  fetch: Object.assign(observedFetch, { preconnect: fetch.preconnect }),
};
await assert.rejects(
  Supabash.openPostgres(options),
  (error: unknown) =>
    isRetryableSupabashError(error) && error.code === 'STORAGE' && !error.outcomeUnknown,
);
const opened = await Supabash.openPostgres(options);
const before = await opened.history({ limit: 100 });
const content = crypto.randomUUID();
await opened.fs.writeFile('/recovery.md', content);
const failure: unknown = await opened.commit().catch((error: unknown) => error);
assert.ok(
  isUnknownOutcomeSupabashError(failure),
  'A lost response must preserve an unknown outcome.',
);
assert.ok(isRetryableSupabashError(failure));
const receipt = await opened.commit();
const restored = await Supabash.openPostgres(options);
assert.equal(await restored.fs.readFile('/recovery.md'), content);
assert.equal(restored.committedRevision(), receipt.revision);
const after = await restored.history({ limit: 100 });
assert.equal(
  after.records.length,
  before.records.length + 1,
  'Retry must not create another revision.',
);
assert.equal(commits, 2);
const result = {
  sessionVerificationRecovered: true,
  acceptedThenResponseLost: true,
  retryReplayedOneRevision: true,
  contentVerified: true,
  commits,
};
writeFileSync('/results/recovery.json', JSON.stringify(result, null, 2));
process.stdout.write(`${JSON.stringify(result)}\n`);
