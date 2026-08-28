import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = async (command: string[], cwd: string): Promise<string> => {
  const child = Bun.spawn(command, { cwd, stderr: 'pipe', stdout: 'pipe' });
  const [exitCode, standardError, standardOutput] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Command failed: ${command.join(' ')}\n${standardOutput.trim()}\n${standardError.trim()}`,
    );
  }
  return standardOutput;
};

const repository = path.dirname(import.meta.dirname);
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'supabash-deno-consumer-'));
const packageDirectory = path.join(temporaryRoot, 'package');
const consumerDirectory = path.join(temporaryRoot, 'consumer');

try {
  await mkdir(packageDirectory);
  await mkdir(consumerDirectory);
  const packOutput = await run(
    [
      process.execPath,
      'pm',
      'pack',
      '--destination',
      packageDirectory,
      '--ignore-scripts',
      '--quiet',
    ],
    repository,
  );
  const tarball = path.resolve(packageDirectory, packOutput.trim());
  await Promise.all([
    Bun.write(
      path.join(consumerDirectory, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@ai-sdk/openai': '4.0.50',
          '@seanmozeik/supabash-fs': `file:${tarball}`,
          ai: '7.0.83',
          'bash-tool': '1.3.19',
          'just-bash': '3.4.2',
        },
        private: true,
        type: 'module',
      }),
    ),
    Bun.write(
      path.join(consumerDirectory, 'deno.json'),
      JSON.stringify({
        compilerOptions: { lib: ['deno.ns', 'dom', 'dom.iterable', 'esnext'], strict: true },
        nodeModulesDir: 'manual',
      }),
    ),
    Bun.write(
      path.join(consumerDirectory, 'smoke.ts'),
      `import { POSTGRES_INSTALL_SQL_URL, Supabash, SupabashError } from '@seanmozeik/supabash-fs';
import { createTools, type WorkspaceTools } from '@seanmozeik/supabash-fs/ai-sdk';
import { InMemoryFs } from 'just-bash/browser';
if (!Object.hasOwn(Supabash, 'open')) throw new Error('Missing Supabash.open.');
if (!Object.hasOwn(Supabash, 'openPostgres')) throw new Error('Missing Supabash.openPostgres.');
if (typeof createTools !== 'function') throw new Error('Missing createTools.');
if (new SupabashError('STORAGE', 'test').code !== 'STORAGE') throw new Error('Bad error.');
const installSql = await Deno.readTextFile(POSTGRES_INSTALL_SQL_URL);
if (!installSql.includes('create schema supabash')) throw new Error('Missing Postgres install SQL.');
const result: Promise<WorkspaceTools> | undefined = undefined;
const workspace = { fs: new InMemoryFs() } as unknown as import('@seanmozeik/supabash-fs').Workspace;
const bound = await createTools({ viewImage: { enabled: true }, workspace });
if (!Object.hasOwn(bound.tools, 'view_image')) throw new Error('Missing view_image.');
void result;
`,
    ),
  ]);
  await run([process.execPath, 'install', '--no-progress'], consumerDirectory);
  await run(
    ['deno', 'check', '--minimum-dependency-age=0', '--config', 'deno.json', 'smoke.ts'],
    consumerDirectory,
  );
  await run(
    [
      'deno',
      'run',
      '--minimum-dependency-age=0',
      '--allow-env=__MINIMATCH_TESTING_PLATFORM__,OPENAI_API_KEY,OPENAI_BASE_URL',
      '--allow-read',
      '--allow-sys',
      '--config',
      'deno.json',
      'smoke.ts',
    ],
    consumerDirectory,
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
