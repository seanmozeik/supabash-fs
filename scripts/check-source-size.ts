import { Glob } from 'bun';

const SOURCE_LINE_LIMIT = 350;
const SOURCE_DIRECTORIES = ['scripts', 'src', 'tests'] as const;

const sourceGlob = new Glob('**/*.ts');
const violations: string[] = [];

for (const directory of SOURCE_DIRECTORIES) {
  for await (const path of sourceGlob.scan({ cwd: directory, onlyFiles: true })) {
    const source = await Bun.file(`${directory}/${path}`).text();
    const lineCount = source.split('\n').length;
    if (lineCount > SOURCE_LINE_LIMIT) {
      violations.push(`${directory}/${path}: ${lineCount} lines`);
    }
  }
}

if (violations.length > 0) {
  throw new Error(
    `TypeScript files must not exceed ${SOURCE_LINE_LIMIT} lines:\n${violations.join('\n')}`,
  );
}
