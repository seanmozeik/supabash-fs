import { readdir, readFile } from 'node:fs/promises';

import { createTools } from '../dist/ai-sdk.js';
import { createFileSystemSnapshot, createMountedFileSystem, Supabash } from '../dist/index.js';

if (typeof createTools !== 'function') {
  throw new TypeError('The built AI SDK export does not provide createTools.');
}
if (!Object.hasOwn(Supabash, 'open')) {
  throw new TypeError('The root export is missing from the AI SDK smoke check.');
}

const source = await readFile(new URL('../dist/ai-sdk.js', import.meta.url), 'utf8');
const chunks = await readdir(new URL('../dist/ai-sdk-chunks/', import.meta.url));
if (source.includes('File is not a supported image type.') || chunks.length === 0) {
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
const denied = await tools.bash.execute({ command: 'echo forbidden > /docs/help.md' }, invocation);
if (denied.exitCode !== 126 || (await mounted.fs.readFile('/docs/help.md')) !== 'published') {
  throw new TypeError('A root-package mount denial did not become a normal AI SDK tool result.');
}
const patch = await tools.apply_patch.execute(
  { callId: 'built-mount-patch', operation: { type: 'delete_file', path: '/docs/help.md' } },
  invocation,
);
if (patch.status !== 'failed' || (await mounted.fs.readFile('/docs/help.md')) !== 'published') {
  throw new TypeError('Apply Patch failed to preserve a read-only root-package mount.');
}
