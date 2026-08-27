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
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'supabash-ai-sdk-consumer-'));
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
          '@types/node': '26.2.0',
          ai: '7.0.83',
          'bash-tool': '1.3.19',
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
      `import { createTools } from '@seanmozeik/supabash-fs/ai-sdk';
import { Supabash } from '@seanmozeik/supabash-fs';
if (typeof createTools !== 'function') throw new Error('Missing createTools.');
if (!Object.hasOwn(Supabash, 'open')) throw new Error('Missing Supabash.open.');
`,
    ),
    Bun.write(
      path.join(consumerDirectory, 'typecheck.ts'),
      `import { createTools, type CreateToolsOptions, type WorkspaceTools } from '@seanmozeik/supabash-fs/ai-sdk';
import type { Workspace } from '@seanmozeik/supabash-fs';
declare const workspace: Workspace;
const options: CreateToolsOptions = { workspace };
const tools: Promise<WorkspaceTools> = createTools(options);
void tools;
`,
    ),
    Bun.write(
      path.join(consumerDirectory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          lib: ['ESNext', 'DOM'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          skipLibCheck: true,
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
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
