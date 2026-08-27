import { spawn } from 'node:child_process';

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
};

const supabaseUrl = required('SUPABASH_TEST_SUPABASE_URL');
const publishableKey = required('SUPABASH_TEST_PUBLISHABLE_KEY');
const serviceRoleKey = required('SUPABASH_TEST_SERVICE_ROLE_KEY');
const bucket = process.env['SUPABASH_TEST_BUCKET'] ?? 'workspaces';
const timeout = (): AbortSignal => AbortSignal.timeout(30_000);

const jsonHeaders = {
  Authorization: `Bearer ${serviceRoleKey}`,
  apikey: serviceRoleKey,
  'content-type': 'application/json',
};

const createBucket = async (): Promise<void> => {
  const response = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
    body: JSON.stringify({ id: bucket, name: bucket, public: false }),
    headers: jsonHeaders,
    method: 'POST',
    signal: timeout(),
  });
  if (response.ok || response.status === 409) {
    return;
  }
  const body = await response.text();
  if (body.includes('already exists') || body.includes('Duplicate')) {
    return;
  }
  throw new Error(`Failed to create bucket ${bucket}: ${response.status} ${body}`);
};

const passwordFor = (email: string): string =>
  process.env['SUPABASH_TEST_USER_PASSWORD'] ?? `live-${email.replaceAll(/[^a-z0-9]/gu, '')}-1A`;

const ensureUser = async (email: string): Promise<string> => {
  const created = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    body: JSON.stringify({ email, email_confirm: true, password: passwordFor(email) }),
    headers: jsonHeaders,
    method: 'POST',
    signal: timeout(),
  });
  if (!created.ok) {
    const body = await created.text();
    if (!body.includes('already') && created.status !== 422) {
      throw new Error(`Failed to create ${email}: ${created.status} ${body}`);
    }
  }
  const session = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    body: JSON.stringify({ email, password: passwordFor(email) }),
    headers: { apikey: publishableKey, 'content-type': 'application/json' },
    method: 'POST',
    signal: timeout(),
  });
  if (!session.ok) {
    throw new Error(`Failed to sign in ${email}: ${session.status} ${await session.text()}`);
  }
  const payload: unknown = await session.json();
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('access_token' in payload) ||
    typeof payload.access_token !== 'string'
  ) {
    throw new Error(`Sign-in for ${email} did not return an access token.`);
  }
  return payload.access_token;
};

const runDeno = (env: Record<string, string>): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'deno',
      [
        'run',
        '--minimum-dependency-age=0',
        '--config',
        'deno.json',
        '--allow-env',
        '--allow-net',
        '--allow-read',
        '--allow-sys',
        'tests/deno/live-supabase.ts',
      ],
      { env: { ...process.env, ...env }, stdio: 'inherit' },
    );
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Deno live test exited with code ${code ?? 'null'}.`));
    });
  });

await createBucket();
const firstEmail = process.env['SUPABASH_TEST_USER_A_EMAIL'] ?? 'supabash-live-a@example.invalid';
const secondEmail = process.env['SUPABASH_TEST_USER_B_EMAIL'] ?? 'supabash-live-b@example.invalid';
const tokenA = process.env['SUPABASH_TEST_TOKEN_A'] ?? (await ensureUser(firstEmail));
const tokenB = process.env['SUPABASH_TEST_TOKEN_B'] ?? (await ensureUser(secondEmail));
await runDeno({
  SUPABASH_TEST_BUCKET: bucket,
  SUPABASH_TEST_PUBLISHABLE_KEY: publishableKey,
  SUPABASH_TEST_SERVICE_ROLE_KEY: serviceRoleKey,
  SUPABASH_TEST_SUPABASE_URL: supabaseUrl,
  SUPABASH_TEST_TOKEN_A: tokenA,
  SUPABASH_TEST_TOKEN_B: tokenB,
});
