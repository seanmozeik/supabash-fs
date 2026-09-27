import { readdir, readFile } from 'node:fs/promises';

import { Transpiler } from 'bun';

const peers = new Set(['ai', '@supabase/supabase-js', '@ai-sdk/openai']);
const files = await readdir(new URL('../dist/', import.meta.url), { recursive: true });
const scanner = new Transpiler({ loader: 'js' });

for (const file of files.filter((name) => name.endsWith('.js') || name.endsWith('.d.ts'))) {
  const source = await readFile(new URL(`../dist/${file}`, import.meta.url), 'utf8');
  // Bun scans static/dynamic imports, re-exports and require calls. Declarations
  // need a separate scan because a runtime parser intentionally erases type imports.
  const imports = file.endsWith('.d.ts')
    ? [
        ...source
          .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
          .replaceAll(/^\s*\/\/.*$/gmu, '')
          .matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)['"](?<specifier>[^'"]+)['"]/gu),
      ].map((match) => match.groups?.['specifier'] ?? '')
    : scanner.scanImports(source).map((entry) => entry.path);
  for (const specifier of imports) {
    if (!specifier.startsWith('./') && !specifier.startsWith('../') && !peers.has(specifier)) {
      throw new Error(`${file}: forbidden external import ${specifier}`);
    }
  }
}
process.stdout.write('Edge imports: only bundled files, declared peers; no node:* imports.\n');
