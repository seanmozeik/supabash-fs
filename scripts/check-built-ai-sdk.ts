import { readdir, readFile } from 'node:fs/promises';

import { createTools } from '../dist/ai-sdk/index.js';
import {
  Bash,
  createFileSystemSnapshot,
  createMountedFileSystem,
  InMemoryFs,
  defineCommand,
  Supabash,
} from '../dist/index.js';
import type { WorkspaceTools } from '../src/ai-sdk/index.ts';
import { gunzipSync, gzipSync } from './build/blocked-zlib.ts';

// Check the published tool set against the source contract, then validate the
// SDK's intentionally untyped tool outputs at the runtime boundary.
const executeTool = async (
  tools: WorkspaceTools['tools'],
  name: string,
  input: unknown,
): Promise<unknown> => {
  const execute = tools[name]?.execute;
  if (execute === undefined) {
    throw new Error(`Missing executable tool: ${name}`);
  }
  const result: unknown = await execute(input, invocation);
  return result;
};

interface BashResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const isBashResult = (result: unknown): result is BashResult =>
  typeof result === 'object' &&
  result !== null &&
  'stdout' in result &&
  typeof result.stdout === 'string' &&
  'stderr' in result &&
  typeof result.stderr === 'string' &&
  'exitCode' in result &&
  typeof result.exitCode === 'number';

const executeBash = async (
  tools: WorkspaceTools['tools'],
  command: string,
): Promise<BashResult> => {
  const result = await executeTool(tools, 'bash', { command });
  if (!isBashResult(result)) {
    throw new Error('Invalid Bash result.');
  }
  return result;
};

for (const compress of [gzipSync, gunzipSync]) {
  let message: string | undefined;
  try {
    compress();
  } catch (error) {
    if (error instanceof Error) {
      ({ message } = error);
    }
  }
  if (message !== 'Compression is not supported in Supabash.') {
    throw new Error('Invalid compression build stub.');
  }
}

if (typeof createTools !== 'function') {
  throw new TypeError('The built AI SDK export does not provide createTools.');
}
if (!Object.hasOwn(Supabash, 'open')) {
  throw new TypeError('The root export is missing from the AI SDK smoke check.');
}

const source = await readFile(new URL('../dist/ai-sdk/index.js', import.meta.url), 'utf8');
const chunks = await readdir(new URL('../dist/', import.meta.url));
if (
  source.includes('File is not a supported image type.') ||
  !chunks.some((name) => name.startsWith('view-image-') && name.endsWith('.js'))
) {
  throw new TypeError('Optional image support was folded into the main AI SDK bundle.');
}

const snapshot = await createFileSystemSnapshot({
  sourceId: 'docs',
  revision: 'v1',
  files: [{ path: '/help.md', content: 'published' }],
});
const mounted = createMountedFileSystem([{ access: 'read-only', mountPoint: '/docs', snapshot }]);
const { tools } = await createTools({ filesystem: mounted.fs });
const invocation = { context: {}, messages: [], toolCallId: 'built-mount-policy' };
const denied = await executeBash(tools, 'echo forbidden > /docs/help.md');
if (denied.exitCode !== 126 || (await mounted.fs.readFile('/docs/help.md')) !== 'published') {
  throw new TypeError('A root-package mount denial did not become a normal AI SDK tool result.');
}
const patch = await executeTool(tools, 'apply_patch', {
  callId: 'built-mount-patch',
  operation: { type: 'delete_file', path: '/docs/help.md' },
});
if (
  typeof patch !== 'object' ||
  patch === null ||
  !('status' in patch) ||
  patch.status !== 'failed' ||
  (await mounted.fs.readFile('/docs/help.md')) !== 'published'
) {
  throw new TypeError('Apply Patch failed to preserve a read-only root-package mount.');
}

const { tools: shellTools } = await createTools({
  filesystem: new InMemoryFs(),
  bash: {
    customCommands: [
      defineCommand('hello-edge', () =>
        Promise.resolve({ stdout: 'custom\n', stderr: '', exitCode: 7 }),
      ),
    ],
    policyOptions: { extraAllowCommands: ['hello-edge'] },
  },
});
for (const command of [
  'html-to-markdown',
  'command html-to-markdown',
  "bash -c 'html-to-markdown'",
  String.raw`find . -exec html-to-markdown {} \;`,
]) {
  const result = await executeBash(shellTools, command);
  if (result.exitCode !== 126) {
    throw new Error(`Blocked command reached the bundle: ${command}`);
  }
}
for (const [command, stdout, exitCode] of [
  ['pwd', '/\n', 0],
  ['hello-edge', 'custom\n', 7],
] as const) {
  const result = await executeBash(shellTools, command);
  if (result.stdout !== stdout || result.exitCode !== exitCode || result.stderr !== '') {
    throw new Error(`Built shell failed ${command}: ${JSON.stringify(result)}`);
  }
  if (Object.keys(result).join(',') !== 'stdout,stderr,exitCode') {
    throw new Error('Bash result shape changed.');
  }
}

for (const command of [
  'gzip /data',
  'gzip -d /data.gz',
  'gzip -t /data.gz',
  'gunzip /data.gz',
  'zcat /data.gz',
  'rg -z needle /data.gz',
  'rg --search-zip needle /data.gz',
  'rg -inz needle /data.gz',
  'rg --pre=gzip needle /data',
  'command gzip /data',
  "bash -c 'gunzip /data.gz'",
  String.raw`find . -exec rg -z needle {} \;`,
]) {
  const result = await executeBash(shellTools, command);
  if (result.exitCode !== 126 || !result.stderr.includes('compression-unsupported')) {
    throw new Error(
      `Compression was not denied by the built policy: ${command}: ${JSON.stringify(result)}`,
    );
  }
}
const plainSearch = await executeBash(
  shellTools,
  String.raw`printf 'edge\n' > /plain.txt; rg --no-line-number edge /plain.txt`,
);
if (plainSearch.stdout !== 'edge\n' || plainSearch.exitCode !== 0) {
  throw new Error(`Plain rg failed: ${JSON.stringify(plainSearch)}`);
}

// Bypass preflight to verify the bundled alias itself, including the existing
// policy behavior that defers unresolved runtime command names to the sandbox.
const rawShell = new Bash({ cwd: '/' });
const unsupported = await rawShell.exec('printf edge | gzip');
if (unsupported.exitCode === 0 || !unsupported.stderr.includes('Compression is not supported')) {
  throw new Error(`The bundled compression stub was not used: ${JSON.stringify(unsupported)}`);
}
const dynamicCompression = await executeBash(
  shellTools,
  'compressor=$(printf gzip); printf edge | $compressor',
);
if (
  dynamicCompression.exitCode === 0 ||
  !dynamicCompression.stderr.includes('Compression is not supported')
) {
  throw new Error(
    `Dynamic compression bypassed the build stub: ${JSON.stringify(dynamicCompression)}`,
  );
}
