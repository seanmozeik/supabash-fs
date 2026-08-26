import { Supabash } from '@seanmozeik/supabash-fs';
import { createClient } from '@supabase/supabase-js';
import { Bash } from 'just-bash/browser';

interface DenoRuntime {
  readonly env: { readonly get: (name: string) => string | undefined };
  readonly stdout: { readonly write: (body: Uint8Array) => Promise<number> };
  readonly version: { readonly deno: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isDenoRuntime = (value: unknown): value is DenoRuntime =>
  isRecord(value) &&
  isRecord(value['env']) &&
  typeof value['env']['get'] === 'function' &&
  isRecord(value['stdout']) &&
  typeof value['stdout']['write'] === 'function' &&
  isRecord(value['version']) &&
  typeof value['version']['deno'] === 'string';

const runtimeRoot: unknown = globalThis;
if (!isRecord(runtimeRoot)) {
  throw new Error('The global runtime object is unavailable.');
}
const runtime = runtimeRoot['Deno'];
if (!isDenoRuntime(runtime)) {
  throw new Error('This integration test requires Deno.');
}
const deno = runtime;

const assert: (condition: boolean, message: string) => asserts condition = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const requiredEnvironment = (name: string): string => {
  const value = deno.env.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
};

const subjectFrom = (token: string): string => {
  const [, payload] = token.split('.');
  if (payload === undefined) {
    throw new Error('Expected a JWT access token.');
  }
  const base64 = payload.replaceAll('-', '+').replaceAll('_', '/');
  const decoded: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
  if (!isRecord(decoded) || typeof decoded['sub'] !== 'string') {
    throw new Error('The access token has no subject.');
  }
  return decoded['sub'];
};

const supabaseUrl = requiredEnvironment('SUPABASH_TEST_SUPABASE_URL');
const publishableKey = requiredEnvironment('SUPABASH_TEST_PUBLISHABLE_KEY');
const bucket = requiredEnvironment('SUPABASH_TEST_BUCKET');
const firstToken = requiredEnvironment('SUPABASH_TEST_TOKEN_A');
const secondToken = requiredEnvironment('SUPABASH_TEST_TOKEN_B');

const open = (accessToken: string) =>
  Supabash.open({
    bucket,
    publishableKey,
    request: new Request('https://supabash.test', {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
    supabaseUrl,
  });

const first = await open(firstToken);
await first.fs.mkdir('/notes', { recursive: true });
await first.fs.writeFile('/notes/alpha.md', 'durable memory\n');
await first.fs.symlink('/notes/alpha.md', '/current');
const firstCommit = await first.commit();

const search = await new Bash({ cwd: '/', fs: first.fs }).exec('grep -R "durable" /notes');
assert(search.exitCode === 0 && search.stdout.includes('durable memory'), 'Bash search failed.');

const reopened = await open(firstToken);
assert(
  (await reopened.fs.readFile('/notes/alpha.md')) === 'durable memory\n',
  'The stored file did not reopen.',
);
assert(
  (await reopened.fs.readlink('/current')) === '/notes/alpha.md',
  'The symbolic link did not reopen.',
);

await reopened.fs.writeFile('/entry', 'temporary file\n');
await reopened.commit();
await reopened.fs.rm('/entry');
await reopened.fs.mkdir('/entry');
await reopened.commit();

const replaced = await open(firstToken);
const replacedEntry = await replaced.fs.lstat('/entry');
assert(replacedEntry.isDirectory, 'The entry type was not replaced.');

const second = await open(secondToken);
assert(!(await second.fs.exists('/notes')), 'The second user saw the first user workspace.');
await second.fs.writeFile('/mine.md', 'second user\n');
await second.commit();

const firstUserId = subjectFrom(firstToken);
const secondClient = createClient(supabaseUrl, publishableKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  global: { headers: { Authorization: `Bearer ${secondToken}` } },
});
const escapedDownload = await secondClient.storage
  .from(bucket)
  .download(`${firstUserId}/notes/alpha.md`);
assert(escapedDownload.error !== null, 'Storage RLS allowed a cross-user download.');

await replaced.fs.rm('/notes', { recursive: true });
await replaced.fs.rm('/current');
await replaced.fs.rm('/entry', { recursive: true });
await replaced.commit();
await second.fs.rm('/mine.md');
await second.commit();

await deno.stdout.write(
  new TextEncoder().encode(
    `${JSON.stringify({
      deno: deno.version.deno,
      firstCommitChanges: firstCommit.changes.length,
      result: 'ok',
    })}\n`,
  ),
);
