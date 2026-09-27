import path from 'node:path';

interface DeclarationDependency {
  readonly kind: 'import' | 'types' | 'path';
  readonly specifier: string;
}

export const declarationDependencies = (source: string): readonly DeclarationDependency[] => {
  const dependencies: DeclarationDependency[] = [];
  const withoutBlocks = source.replaceAll(/\/\*[\s\S]*?\*\//gu, '');
  for (const match of withoutBlocks.matchAll(
    /^[\t ]*\/\/\/\s*<reference\b[^>]*?\b(?<kind>types|path)\s*=\s*['"](?<specifier>[^'"]+)['"][^>]*>/gmu,
  )) {
    dependencies.push({
      kind: match.groups?.['kind'] === 'path' ? 'path' : 'types',
      specifier: match.groups?.['specifier'] ?? '',
    });
  }
  for (const match of withoutBlocks
    .replaceAll(/^\s*\/\/.*$/gmu, '')
    .matchAll(
      /\b(?:from\s*|import\s*\(\s*|import\s*|require\s*\(\s*|declare\s+module\s*)['"](?<specifier>[^'"]+)['"]/gu,
    )) {
    dependencies.push({ kind: 'import', specifier: match.groups?.['specifier'] ?? '' });
  }
  return dependencies;
};

export const checkDeclarationDependencies = (
  file: string,
  source: string,
  bundledFiles: ReadonlySet<string>,
  peers: ReadonlySet<string>,
): void => {
  for (const { kind, specifier } of declarationDependencies(source)) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (kind === 'path' || relative) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      const declaration = kind === 'path' ? target : target.replace(/\.js$/u, '.d.ts');
      if (path.posix.isAbsolute(specifier) || !bundledFiles.has(declaration)) {
        throw new Error(`${file}: unbundled declaration ${kind} ${specifier}`);
      }
    } else {
      const typePeer = `@types/${specifier.replace(/^@/u, '').replace('/', '__')}`;
      const declared =
        [...peers].some((peer) => specifier === peer || specifier.startsWith(`${peer}/`)) ||
        (kind === 'types' && peers.has(typePeer));
      if (specifier.startsWith('node:') || !declared) {
        throw new Error(`${file}: forbidden external declaration ${kind} ${specifier}`);
      }
    }
  }
};
