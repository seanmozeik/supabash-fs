import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { SQL } from 'bun';

import { Supabash } from '../../../dist/index.js';

if (process.env['MODAL_STRESS_REMOTE'] !== '1') {
  throw new Error('Modal only.');
}
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected record.');
  }
  return { ...value };
};
const raw = record(JSON.parse(readFileSync('/tmp/hill-config.json', 'utf8')));
const field = (name: string): string => {
  const value = raw[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Missing disposable configuration.');
  }
  return value;
};
const config = {
  api: field('api'),
  password: field('password'),
  key: field('key'),
  jwtSecret: field('jwtSecret'),
};
const [lane = 'sql', count = '8', duration = '20', label = 'baseline'] = process.argv.slice(2);
const concurrency = Number(count);
const seconds = Number(duration);
if (
  !['sql', 'rest', 'kong', 'sdk'].includes(lane) ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 512 ||
  seconds < 1 ||
  seconds > 600 ||
  !/^[a-z0-9-]+$/u.test(label) ||
  (lane === 'sql' && concurrency > 64)
) {
  throw new Error('Invalid bounded profile.');
}
const id = (prefix: string, n: number): string =>
  `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const claims = (n: number) => ({
  sub: id('1', n),
  aud: 'authenticated',
  role: 'authenticated',
  exp: Math.floor(Date.now() / 1000) + 14_400,
});
const token = (n: number): string => {
  const unsigned = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims(n))).toString('base64url')}`;
  return `${unsigned}.${createHmac('sha256', config.jwtSecret).update(unsigned).digest('base64url')}`;
};
const clients: SQL[] = [];
const samples: number[] = [];
const errors: Record<string, number> = {};
const rpc: Record<string, { count: number; ms: number; errors: number }> = {};
let successes = 0;
let peakLag = 0;
const measuredFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const start = performance.now();
  const response = await fetch(input, { ...init, signal: AbortSignal.timeout(15_000) });
  const path = new URL(input instanceof Request ? input.url : input).pathname;
  rpc[path] ??= { count: 0, ms: 0, errors: 0 };
  rpc[path].count += 1;
  rpc[path].ms += performance.now() - start;
  if (!response.ok) {
    rpc[path].errors += 1;
  }
  return response;
};
const create = async (n: number): Promise<() => Promise<void>> => {
  const workspace = id('2', n);
  const bearer = token(n);
  let sql: SQL | undefined;
  if (lane === 'sql') {
    sql = new SQL({
      hostname: '127.0.0.1',
      port: 15_432,
      username: 'supabash_bench',
      password: config.password,
      database: 'postgres',
      max: 1,
      idleTimeout: 0,
      maxLifetime: 0,
    });
    clients.push(sql);
    await sql.unsafe('set role authenticated');
    await sql`select set_config('request.jwt.claims', ${JSON.stringify(claims(n))}, false)`;
    await sql.unsafe("set statement_timeout = '15s'");
  }
  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const base = lane === 'rest' ? 'http://127.0.0.1:15433' : `${config.api}/rest/v1`;
    const response = await measuredFetch(`${base}/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: config.key,
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!response.ok) {
      throw new Error(`HTTP_${response.status}`);
    }
    return record(await response.json());
  };
  return async () => {
    let text;
    if (lane === 'sdk') {
      const fs = await Supabash.openPostgres({
        workspace,
        supabaseUrl: config.api,
        publishableKey: config.key,
        request: new Request('https://stress.example.test', {
          headers: { authorization: `Bearer ${bearer}` },
        }),
        fetch: Object.assign(measuredFetch, { preconnect: fetch.preconnect }),
      });
      text = await fs.fs.readFile('/file-0.md');
    } else {
      const manifestRows: unknown[] =
        sql === undefined
          ? []
          : await sql`select public.supabash_load_manifest(${workspace}::uuid) as value`;
      const manifest =
        sql === undefined
          ? await call('supabash_load_manifest', { p_workspace_id: workspace })
          : record(record(manifestRows[0])['value']);
      const { documents } = manifest;
      const revision = manifest['headRevision'];
      if (
        manifest['workspaceId'] !== workspace ||
        !Array.isArray(documents) ||
        documents.length < 20 ||
        typeof revision !== 'string'
      ) {
        throw new Error('MANIFEST_MISMATCH');
      }
      const documentRows: unknown[] =
        sql === undefined
          ? []
          : await sql`select public.supabash_load_document(${workspace}::uuid, ${revision}::uuid, '/file-0.md') as value`;
      const document =
        sql === undefined
          ? await call('supabash_load_document', {
              p_workspace_id: workspace,
              p_revision_id: revision,
              p_path: '/file-0.md',
            })
          : record(record(documentRows[0])['value']);
      text = document['body'];
    }
    if (typeof text !== 'string' || !text.startsWith(`${n}:0\n`)) {
      throw new Error('OWNER_OR_CONTENT_MISMATCH');
    }
  };
};
try {
  const operations = await Promise.all(
    Array.from({ length: concurrency }, (_, n) => create(n + 1)),
  );
  await Promise.all(operations.map((operation) => operation()));
  const started = performance.now();
  let tick = started;
  const timer = setInterval(() => {
    const now = performance.now();
    peakLag = Math.max(peakLag, now - tick - 100);
    tick = now;
  }, 100);
  await Promise.all(
    operations.map(async (operation) => {
      do {
        const began = performance.now();
        try {
          await operation();
          successes += 1;
        } catch (error) {
          const code = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
          errors[code] = (errors[code] ?? 0) + 1;
        }
        samples.push(performance.now() - began);
      } while (performance.now() - started < seconds * 1000);
    }),
  );
  clearInterval(timer);
  const elapsedMs = performance.now() - started;
  samples.sort((a, b) => a - b);
  const percentile = (p: number): number =>
    samples[Math.min(samples.length - 1, Math.floor(samples.length * p))] ?? 0;
  const result = {
    label,
    lane,
    concurrency,
    seconds,
    successes,
    errors,
    elapsedMs,
    opsPerSecond: (successes * 1000) / elapsedMs,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    peakLagMs: peakLag,
    rssBytes: process.memoryUsage().rss,
    rpc,
    scope:
      'Separate Modal VMs; fixed owner per worker; manifest plus one pinned file; SQL and REST omit Auth getUser',
  };
  writeFileSync(
    `/results/${label}-${lane}-${concurrency}-${Date.now()}.json`,
    JSON.stringify(result, null, 2),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (Object.keys(errors).length > 0) {
    process.exitCode = 1;
  }
} finally {
  await Promise.all(clients.map((client) => client.close()));
}
