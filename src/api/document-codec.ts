import { parseDocument } from 'yaml';

import { SupabashError } from './errors.js';

export type DocumentMetadataValue = boolean | number | string | null;
export type DocumentMetadata = Readonly<Record<string, DocumentMetadataValue>>;

export interface StoredTextDocument {
  readonly body: string;
  readonly metadata: DocumentMetadata;
  readonly path: string;
}

export interface TextDocumentCodec {
  readonly parse: (path: string, content: string) => StoredTextDocument;
}

export interface YamlFrontmatterCodecOptions {
  readonly validate?: (metadata: DocumentMetadata, path: string) => void;
}

export const plainTextDocumentCodec: TextDocumentCodec = Object.freeze({
  parse: (path: string, content: string) => ({ body: content, metadata: {}, path }),
});

export const createYamlFrontmatterCodec = (
  options: YamlFrontmatterCodecOptions = {},
): TextDocumentCodec => ({
  parse(path, content) {
    const parsed = parseFrontmatter(path, content);
    options.validate?.(parsed.metadata, path);
    return { ...parsed, path };
  },
});

export const isDocumentMetadataValue = (value: unknown): value is DocumentMetadataValue =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

export const renderStoredDocument = ({
  body,
  metadata,
}: Pick<StoredTextDocument, 'body' | 'metadata'>): string => {
  const entries = Object.entries(metadata).toSorted(([left], [right]) => compareKeys(left, right));
  if (entries.length === 0) {
    return body;
  }
  const fields = entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  return `---\n${fields}\n---\n${body}`;
};

const parseFrontmatter = (
  path: string,
  content: string,
): { readonly body: string; readonly metadata: DocumentMetadata } => {
  const lines = content.split('\n');
  if (lines[0]?.replace(/\r$/u, '') !== '---') {
    return { body: content, metadata: {} };
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.replace(/\r$/u, '') === '---');
  if (closing === -1) {
    throw unsupported(path, 'YAML frontmatter has no closing delimiter.');
  }
  const source = lines.slice(1, closing).join('\n');
  const document = parseDocument(source, { prettyErrors: false, schema: 'core', uniqueKeys: true });
  if (document.errors.length > 0) {
    throw unsupported(path, 'YAML frontmatter is invalid.');
  }
  const metadata = metadataRecord(document.toJS({ maxAliasCount: 0 }), path);
  return { body: lines.slice(closing + 1).join('\n'), metadata };
};

const metadataRecord = (value: unknown, path: string): DocumentMetadata => {
  if (value === null) {
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw unsupported(path, 'YAML frontmatter must be one flat mapping.');
  }
  const metadata: Record<string, DocumentMetadataValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key) || !isDocumentMetadataValue(entry)) {
      throw unsupported(path, 'YAML frontmatter keys and values are not supported.');
    }
    metadata[key] = entry;
  }
  return metadata;
};

const compareKeys = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

const unsupported = (path: string, message: string): SupabashError =>
  new SupabashError('UNSUPPORTED_CONTENT', message, { path });
