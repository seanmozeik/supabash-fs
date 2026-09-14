import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { Supabash, SupabashError, type PostgresWorkspace } from '../../dist/index.js';

if (process.env['MODAL_STRESS_REMOTE'] !== '1') {
  throw new Error('Run this harness only in the disposable Modal VM.');
}
const url = process.env['API_URL'];
if (url === undefined || url === '') {
  throw new Error('Disposable stack URL is missing.');
}
if (url !== 'http://127.0.0.1:54321') {
  const config: unknown = JSON.parse(readFileSync('/tmp/hill-config.json', 'utf8'));
  if (typeof config !== 'object' || config === null || !('api' in config) || config.api !== url) {
    throw new Error('Only the assigned disposable test stack is allowed.');
  }
}
const key = process.env['ANON_KEY'];
const secret = process.env['JWT_SECRET'];
if (key === undefined || key === '' || secret === undefined || secret === '') {
  throw new Error('Disposable stack credentials are missing.');
}
const mode = process.argv[2] ?? 'smoke';
const concurrency = Number(process.argv[3] ?? 1);
const seconds = Number(process.argv[4] ?? 30);
const offset = Number(process.argv[5] ?? 0);
const total = Number(process.argv[6] ?? 2048);
const arrivalRate = Number(process.argv[7] ?? 1000);
const run = `${mode}-${concurrency}-${offset}-${Date.now()}`;
if (
  !['seed', 'read', 'mixed', 'maintenance', 'arrival'].includes(mode) ||
  !Number.isInteger(arrivalRate) ||
  arrivalRate < 1 ||
  arrivalRate > 5000 ||
  !Number.isInteger(total) ||
  !Number.isInteger(offset) ||
  offset < 0 ||
  !Number.isFinite(seconds) ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > total ||
  total % concurrency !== 0 ||
  total + offset > 10_000 ||
  seconds < 1 ||
  seconds > 900
) {
  throw new Error('Invalid bounded load profile.');
}
const tokenCache = new Map<number, string>();
const acknowledgements = new Map<number, { content: string; revision: string }>();
const rpc: Record<string, { count: number; errors: number; totalMs: number }> = {};
const errors: Record<string, number> = {};
const transportFailures: Record<string, number> = {};
const httpFailures: Record<string, number> = {};
const latencies: number[] = [];
const byKind: Record<string, number[]> = {};
const operationKind = (ordinal: number): string => {
  if (mode === 'mixed') {
    if (ordinal % 10 === 9) {
      return 'history';
    }
    return ordinal % 10 < 7 ? 'read' : 'write';
  }
  return mode === 'arrival' ? 'read' : mode;
};
let peakLag = 0;
let active = 0;
let peakActive = 0;
let completed = 0;
let succeeded = 0;
const id = (prefix: string, n: number): string =>
  `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const token = (n: number): string => {
  const cached = tokenCache.get(n);
  if (cached !== undefined) {
    return cached;
  }
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: id('1', n),
      aud: 'authenticated',
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 7200,
    }),
  ).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const result = `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
  tokenCache.set(n, result);
  return result;
};
const measuredFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = new URL(input instanceof Request ? input.url : input).pathname;
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(input, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (cause) {
    const kind = cause instanceof Error ? cause.name : 'unknown';
    const label = `${path}:${kind}`;
    transportFailures[label] = (transportFailures[label] ?? 0) + 1;
    throw cause;
  }
  rpc[path] ??= { count: 0, errors: 0, totalMs: 0 };
  const record = rpc[path];
  record.count += 1;
  record.totalMs += performance.now() - started;
  if (!response.ok) {
    record.errors += 1;
    const label = `${path}:${response.status}`;
    httpFailures[label] = (httpFailures[label] ?? 0) + 1;
  }
  return response;
};
const open = (n: number): Promise<PostgresWorkspace> =>
  Supabash.openPostgres({
    workspace: id('2', n),
    supabaseUrl: url,
    publishableKey: key,
    request: new Request('https://stress.example.test', {
      headers: { authorization: `Bearer ${token(n)}` },
    }),
    fetch: Object.assign(measuredFetch, { preconnect: fetch.preconnect }),
  });
const commit = (workspace: PostgresWorkspace, cause: string) =>
  workspace.commit({
    context: { actor: 'synthetic-stress', correlationId: crypto.randomUUID(), cause },
  });
const operation = async (n: number, ordinal: number): Promise<void> => {
  const workspace = await open(n);
  if (mode === 'seed') {
    const content = randomBytes(1536).toString('base64');
    for (let file = 0; file < 20; file += 1) {
      await workspace.fs.writeFile(`/file-${file}.md`, `${n}:${file}\n${content}`);
    }
    await commit(workspace, 'seed');
    return;
  }
  const text = await workspace.fs.readFile('/file-0.md');
  if (!text.startsWith(`${n}:0\n`)) {
    throw new Error('OWNER_OR_CONTENT_MISMATCH');
  }
  if (mode === 'maintenance') {
    await workspace.purge({ maxRevisions: 50 });
    return;
  }
  if (operationKind(ordinal) === 'read') {
    return;
  }
  if (operationKind(ordinal) === 'history') {
    await workspace.history({ limit: 10 });
    return;
  }
  const content = `${run}:${n}:${ordinal}`;
  await workspace.fs.writeFile('/latest.md', content);
  const receipt = await commit(workspace, 'mixed-write');
  acknowledgements.set(n, { content, revision: receipt.revision });
};
// Fail before timing if the stack is unavailable or the fixture is invalid.
if (mode !== 'seed') {
  await operation(offset + 1, 0);
}
const began = performance.now();
let previousTick = began;
const timer = setInterval(() => {
  const now = performance.now();
  peakLag = Math.max(peakLag, now - previousTick - 100);
  previousTick = now;
}, 100);
const attempt = async (n: number, ordinal: number, started = performance.now()): Promise<void> => {
  active += 1;
  peakActive = Math.max(peakActive, active);
  try {
    await operation(n, ordinal);
    succeeded += 1;
  } catch (error) {
    let code = 'UNKNOWN_FAILURE';
    if (error instanceof Error) {
      code = error.message;
    }
    if (error instanceof SupabashError) {
      ({ code } = error);
    }
    errors[code] = (errors[code] ?? 0) + 1;
    if (completed < 3) {
      process.stderr.write(`${JSON.stringify({ code })}\n`);
    }
  } finally {
    active -= 1;
    completed += 1;
    const elapsed = performance.now() - started;
    latencies.push(elapsed);
    const kind = operationKind(ordinal);
    byKind[kind] ??= [];
    byKind[kind].push(elapsed);
  }
};
const worker = async (slot: number): Promise<void> => {
  let iteration = 0;
  do {
    const ordinal = slot + iteration * concurrency;
    if (mode === 'seed' && ordinal >= total) {
      break;
    }
    const n = offset + (ordinal % total) + 1;
    await attempt(n, ordinal);
    iteration += 1;
  } while (performance.now() - began < seconds * 1000);
};
let droppedArrivals = 0;
let maxSchedulingLagMs = 0;
if (mode === 'arrival') {
  const pending = new Map<number, Promise<void>>();
  const launch = async (ordinal: number, due: number): Promise<void> => {
    try {
      await attempt(offset + (ordinal % total) + 1, ordinal, due);
    } finally {
      pending.delete(ordinal);
    }
  };
  for (let ordinal = 0; ordinal < arrivalRate * seconds; ordinal += 1) {
    const due = began + (ordinal * 1000) / arrivalRate;
    const delay = due - performance.now();
    if (delay >= 1) {
      await Bun.sleep(delay);
    }
    maxSchedulingLagMs = Math.max(maxSchedulingLagMs, performance.now() - due);
    if (active >= concurrency) {
      droppedArrivals += 1;
    } else {
      // oxlint-disable-next-line unicorn/prefer-top-level-await -- Awaiting here would serialize the open-loop arrivals; the bounded pending set is awaited below.
      pending.set(ordinal, launch(ordinal, due));
    }
  }
  await Promise.all(pending.values());
} else {
  await Promise.all(Array.from({ length: concurrency }, (_, slot) => worker(slot)));
}
clearInterval(timer);
const elapsedMs = performance.now() - began;
let verifiedWrites = 0;
for (const [n, expected] of acknowledgements) {
  const workspace = await open(n);
  if ((await workspace.fs.readFile('/latest.md')) !== expected.content) {
    throw new Error('ACKNOWLEDGED_WRITE_LOST');
  }
  verifiedWrites += 1;
}
latencies.sort((a, b) => a - b);
const percentile = (p: number): number =>
  latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
const result = {
  run,
  version: '0.7.0-candidate',
  mode,
  concurrency,
  seconds,
  offeredPerSecond: mode === 'arrival' ? arrivalRate : null,
  droppedArrivals,
  maxSchedulingLagMs,
  offset,
  total,
  completed,
  succeeded,
  errors,
  transportFailures,
  httpFailures,
  elapsedMs,
  successfulOpsPerSecond: succeeded / (elapsedMs / 1000),
  p50Ms: percentile(0.5),
  p95Ms: percentile(0.95),
  p99Ms: percentile(0.99),
  peakActive,
  peakLagMs: peakLag,
  verifiedWrites,
  rpc,
  operationLatency: Object.fromEntries(
    Object.entries(byKind).map(([kind, values]) => {
      values.sort((a, b) => a - b);
      return [
        kind,
        {
          count: values.length,
          p95Ms: values[Math.floor(values.length * 0.95)] ?? 0,
          p99Ms: values[Math.floor(values.length * 0.99)] ?? 0,
        },
      ];
    }),
  ),
  rssBytes: process.memoryUsage().rss,
  scope:
    'Supabash SDK + Auth + PostgREST + Postgres; synthetic sessions; no application chat or model calls',
};
writeFileSync(`/results/${run}.json`, JSON.stringify(result, null, 2));
writeFileSync(`/results/${run}-latencies.json`, JSON.stringify(latencies));
writeFileSync(`/results/${run}-kind-latencies.json`, JSON.stringify(byKind));
if (acknowledgements.size > 0) {
  writeFileSync(`/results/${run}-writes.json`, JSON.stringify([...acknowledgements]));
}
process.stdout.write(`${JSON.stringify(result)}\n`);
if (Object.keys(errors).length > 0 || (mode === 'seed' && succeeded !== total)) {
  process.exitCode = 1;
}
