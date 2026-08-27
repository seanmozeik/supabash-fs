import { describe, expect, it } from 'vitest';

import { applyDiff } from '../../src/patch/apply-diff.ts';

const lines = (...values: string[]): string => values.join('\n');

describe('applyDiff upstream examples 12-22', () => {
  it('example 12: LICENSE create file with blank line', () => {
    expect(applyDiff('', lines('+MIT License', '+', '+Copyright (c) 2025'), 'create')).toBe(
      lines('MIT License', '', 'Copyright (c) 2025'),
    );
  });

  it('example 13: temp/debug.log delete is orchestrated outside applyDiff', () => {
    const input = lines('DEBUG something...', 'more debug...');
    expect(applyDiff(input, '', 'default')).toBe(input);
  });

  it('example 14: old_name.txt moved to docs/new_name.txt (content unchanged)', () => {
    expect(applyDiff('Legacy content', ' Legacy content', 'default')).toBe('Legacy content');
  });

  it('example 15: api/client.py & api/version.py updates', () => {
    expect(
      applyDiff(
        'BASE_URL = "https://old.example.com"',
        lines('-BASE_URL = "https://old.example.com"', '+BASE_URL = "https://api.example.com"'),
        'default',
      ),
    ).toBe('BASE_URL = "https://api.example.com"');
    expect(
      applyDiff('VERSION = "1.0.0"', lines('-VERSION = "1.0.0"', '+VERSION = "1.1.0"'), 'default'),
    ).toBe('VERSION = "1.1.0"');
  });

  it('example 16: tests/test_math.py insert test_sub', () => {
    const input = lines(
      'def test_add():',
      '    assert add(1, 2) == 3',
      '',
      'def test_mul():',
      '    assert mul(2, 3) == 6',
    );
    const diff = lines(
      ' def test_add():',
      '     assert add(1, 2) == 3',
      '',
      '+def test_sub():',
      '+    assert sub(5, 2) == 3',
      '+',
      ' def test_mul():',
      '     assert mul(2, 3) == 6',
    );
    expect(applyDiff(input, diff, 'default')).toBe(
      lines(
        'def test_add():',
        '    assert add(1, 2) == 3',
        '',
        'def test_sub():',
        '    assert sub(5, 2) == 3',
        '',
        'def test_mul():',
        '    assert mul(2, 3) == 6',
      ),
    );
  });

  it('example 17: footer.txt update last two lines', () => {
    expect(
      applyDiff(
        lines('Line A', 'Line B', 'Line C'),
        lines(' Line A', '-Line B', '-Line C', '+Line B (updated)', '+Line C (updated)'),
        'default',
      ),
    ).toBe(lines('Line A', 'Line B (updated)', 'Line C (updated)'));
  });

  it('example 18: docs/guide.md update heading and intro', () => {
    const input = lines(
      '# Getting Started',
      '',
      'This is the old intro text.',
      '',
      '## Installation',
      '',
      'Steps go here.',
    );
    const diff = lines(
      '-# Getting Started',
      '-',
      '-This is the old intro text.',
      '+# Quick Start Guide',
      '+',
      '+This is the updated introduction, with clearer instructions.',
      '',
      ' ## Installation',
    );
    expect(applyDiff(input, diff, 'default')).toBe(
      lines(
        '# Quick Start Guide',
        '',
        'This is the updated introduction, with clearer instructions.',
        '',
        '## Installation',
        '',
        'Steps go here.',
      ),
    );
  });

  it('example 19: config.json enabled -> true', () => {
    const input = lines('{', '  "name": "demo",', '  "enabled": false,', '  "retries": 3', '}');
    const diff = lines(
      ' {',
      '   "name": "demo",',
      '-  "enabled": false,',
      '+  "enabled": true,',
      '   "retries": 3',
      ' }',
    );
    expect(applyDiff(input, diff, 'default')).toBe(
      lines('{', '  "name": "demo",', '  "enabled": true,', '  "retries": 3', '}'),
    );
  });

  it('example 20: web/app.js update add() and greet()', () => {
    const input = lines(
      'function add(a, b) {',
      '    return a + b;',
      '}',
      '',
      'function greet(name) {',
      '    return "Hello " + name;',
      '}',
    );
    const diff = lines(
      '@@',
      '-function add(a, b) {',
      '-    return a + b;',
      '-}',
      '+function add(a, b) {',
      '+    return a + b; // simple add',
      '+}',
      ' ',
      ' function greet(name) {',
      '-    return "Hello " + name;',
      '-}',
      `+    return \`Hello \${name}!\`;`,
      '+}',
    );
    expect(applyDiff(input, diff, 'default')).toBe(
      lines(
        'function add(a, b) {',
        '    return a + b; // simple add',
        '}',
        '',
        'function greet(name) {',
        `    return \`Hello \${name}!\`;`,
        '}',
      ),
    );
  });

  it('example 21: controller.py insert logging after validate', () => {
    const input = lines('def handle(req):', '    validate(req)', '    return process(req)');
    const diff = lines(
      '@@ def handle(req):',
      '     validate(req)',
      '+    log_request(req)',
      '     return process(req)',
    );
    expect(applyDiff(input, diff, 'default')).toBe(
      lines(
        'def handle(req):',
        '    validate(req)',
        '    log_request(req)',
        '    return process(req)',
      ),
    );
  });

  it('example 22: greeter.py update main print message', () => {
    const input = lines(
      'class Greeter:',
      '    def hello(self):',
      '        return "hi"',
      '',
      'def main():',
      '    g = Greeter()',
      '    print(g.hello())',
    );
    const diff = lines(
      '@@ def main():',
      '     g = Greeter()',
      '-    print(g.hello())',
      '+    print(f"Greeting: {g.hello()}")',
    );
    expect(applyDiff(input, diff, 'default')).toBe(
      lines(
        'class Greeter:',
        '    def hello(self):',
        '        return "hi"',
        '',
        'def main():',
        '    g = Greeter()',
        '    print(f"Greeting: {g.hello()}")',
      ),
    );
  });
});
