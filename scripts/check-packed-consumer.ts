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
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'supabash-consumer-'));
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
  const packedName = packOutput.trim();
  const tarball = path.resolve(packageDirectory, packedName);
  await Promise.all([
    Bun.write(
      path.join(consumerDirectory, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@seanmozeik/supabash-fs': `file:${tarball}`,
          '@types/node': '26.2.0',
          'just-bash': '3.4.2',
          typescript: '7.0.2',
        },
        private: true,
        scripts: { smoke: 'bun smoke.mjs', typecheck: 'tsc --noEmit' },
        type: 'module',
      }),
    ),
    Bun.write(
      path.join(consumerDirectory, 'smoke.mjs'),
      `import { Supabash, SupabashError } from '@seanmozeik/supabash-fs';
if (!Object.hasOwn(Supabash, 'open')) throw new Error('Missing Supabash.open.');
if (new SupabashError('STORAGE', 'test').code !== 'STORAGE') throw new Error('Bad error.');
`,
    ),
    Bun.write(
      path.join(consumerDirectory, 'peer-error.mjs'),
      `try {
  await import('@seanmozeik/supabash-fs/ai-sdk');
  throw new Error('AI SDK import unexpectedly succeeded without its optional peers.');
} catch (error) {
  const message = String(error);
  if (message.includes('unexpectedly succeeded')) throw error;
  if (!['ai', '@ai-sdk/openai', 'bash-tool'].some((peer) => message.includes(peer))) {
    throw new Error('AI SDK import did not identify a missing optional peer.', { cause: error });
  }
}
`,
    ),
    Bun.write(
      path.join(consumerDirectory, 'typecheck.ts'),
      `import { Supabash, SupabashError, type SupabashOptions, type Workspace } from '@seanmozeik/supabash-fs';
declare const options: SupabashOptions;
const workspace: Promise<Workspace> = Supabash.open(options);
const error = new SupabashError('STORAGE', 'test');
void workspace;
void error;
`,
    ),
    Bun.write(
      path.join(consumerDirectory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          lib: ['ESNext', 'DOM'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          skipLibCheck: false,
          strict: true,
          target: 'ESNext',
          types: ['node'],
        },
        include: ['typecheck.ts'],
      }),
    ),
  ]);
  await run([process.execPath, 'install', '--no-progress'], consumerDirectory);
  await run([process.execPath, 'run', 'typecheck'], consumerDirectory);
  await run([process.execPath, 'run', 'smoke'], consumerDirectory);
  await run([process.execPath, 'peer-error.mjs'], consumerDirectory);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
