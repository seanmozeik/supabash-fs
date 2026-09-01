import { describe, expect, test } from 'vitest';

import {
  createYamlFrontmatterCodec,
  plainTextDocumentCodec,
  renderStoredDocument,
} from '../src/api/document-codec.ts';

describe('text document codecs', () => {
  test('leaves plain text byte-for-byte unchanged', () => {
    const content = '---\nthis is ordinary text\n';
    const parsed = plainTextDocumentCodec.parse('/notes.md', content);
    expect(parsed).toStrictEqual({ body: content, metadata: {}, path: '/notes.md' });
    expect(renderStoredDocument(parsed)).toBe(content);
  });

  test('separates YAML metadata and renders one canonical document', () => {
    const codec = createYamlFrontmatterCodec();
    const parsed = codec.parse(
      '/notes.md',
      '---\ndescription: A concise route to relevant context\npriority: 2\n---\n# Notes\n\nBody.\n',
    );
    expect(parsed).toStrictEqual({
      body: '# Notes\n\nBody.\n',
      metadata: { description: 'A concise route to relevant context', priority: 2 },
      path: '/notes.md',
    });
    expect(renderStoredDocument(parsed)).toBe(
      '---\ndescription: "A concise route to relevant context"\npriority: 2\n---\n# Notes\n\nBody.\n',
    );
  });

  test('supports typed application validation', () => {
    const codec = createYamlFrontmatterCodec({
      validate(metadata, path) {
        if (typeof metadata['description'] !== 'string') {
          throw new TypeError(`${path} needs a description`);
        }
      },
    });
    expect(() => codec.parse('/notes.md', '# Notes\n')).toThrow('/notes.md needs a description');
  });

  test('rejects nested metadata and malformed frontmatter', () => {
    const codec = createYamlFrontmatterCodec();
    expect(() => codec.parse('/notes.md', '---\ntags: [one, two]\n---\nBody\n')).toThrow(
      'keys and values are not supported',
    );
    expect(() => codec.parse('/notes.md', '---\ndescription: missing close\n')).toThrow(
      'no closing delimiter',
    );
  });
});
