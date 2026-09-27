import { defineConfig } from 'tsdown';

import { edgeDnsPinTypes } from './scripts/build/edge-dns-pin-plugin.ts';

const peers = ['ai', '@supabase/supabase-js', '@ai-sdk/openai'];

export default defineConfig({
  entry: { index: 'src/index.ts', 'ai-sdk/index': 'src/ai-sdk/index.ts' },
  platform: 'browser',
  format: 'esm',
  minify: true,
  treeshake: true,
  dts: true,
  sourcemap: false,
  plugins: [edgeDnsPinTypes],
  deps: {
    neverBundle: peers,
    alwaysBundle: (id) => !peers.some((peer) => id === peer || id.startsWith(`${peer}/`)),
    onlyImport: peers,
  },
  alias: {
    turndown: new URL('scripts/build/blocked-turndown.ts', import.meta.url).pathname,
    'node:zlib': new URL('scripts/build/blocked-zlib.ts', import.meta.url).pathname,
  },
});
