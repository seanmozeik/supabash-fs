import { readdir, readFile } from 'node:fs/promises';

import { Transpiler } from 'bun';

import manifest from '../package.json';
import { checkDeclarationDependencies } from './build/declaration-dependencies.ts';

const peers = new Set(Object.keys(manifest.peerDependencies));
const files = await readdir(new URL('../dist/', import.meta.url), { recursive: true });
const scanner = new Transpiler({ loader: 'js' });

for (const file of files.filter((name) => name.endsWith('.js') || name.endsWith('.d.ts'))) {
  const source = await readFile(new URL(`../dist/${file}`, import.meta.url), 'utf8');
  if (file.endsWith('.d.ts')) {
    checkDeclarationDependencies(file, source, new Set(files), peers);
  } else {
    // Bun scans static/dynamic imports, re-exports and require calls.
    const imports = scanner.scanImports(source).map((entry) => entry.path);
    for (const specifier of imports) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../') && !peers.has(specifier)) {
        throw new Error(`${file}: forbidden external import ${specifier}`);
      }
    }
  }
}
process.stdout.write('Edge imports: only bundled files, declared peers; no node:* imports.\n');
