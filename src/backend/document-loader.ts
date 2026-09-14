import { SupabashError } from '../api/errors.js';
import { sha256 } from '../core/hash.js';
import type { BackendDocument, DocumentEntry, PinnedSnapshot } from './contracts.js';

export const loadDocument = async (
  snapshot: PinnedSnapshot,
  entry: DocumentEntry | BackendDocument,
): Promise<BackendDocument> => {
  if ('body' in entry && 'content' in entry) {
    return verifyDocument(entry);
  }
  if (snapshot.revision === null || snapshot.loadDocument === undefined) {
    throw new SupabashError('HISTORY_CORRUPTION', 'Snapshot has no document loader.', {
      path: entry.path,
    });
  }
  const document = await snapshot.loadDocument(snapshot.revision, entry.path);
  if (
    document.path !== entry.path ||
    document.contentHash !== entry.contentHash ||
    document.bodyHash !== entry.bodyHash ||
    document.byteSize !== entry.byteSize ||
    document.bodyByteSize !== entry.bodyByteSize
  ) {
    throw new SupabashError(
      'HISTORY_CORRUPTION',
      'Loaded document does not match its pinned entry.',
      { path: entry.path },
    );
  }
  return verifyDocument(document);
};

const verifyDocument = async (document: BackendDocument): Promise<BackendDocument> => {
  const encoder = new TextEncoder();
  const body = encoder.encode(document.body);
  const content = encoder.encode(document.content);
  const [bodyHash, contentHash] = await Promise.all([sha256(body), sha256(content)]);
  if (
    bodyHash !== document.bodyHash ||
    contentHash !== document.contentHash ||
    body.byteLength !== document.bodyByteSize ||
    content.byteLength !== document.byteSize
  ) {
    throw new SupabashError(
      'HISTORY_CORRUPTION',
      'Document bytes do not match their stored hashes.',
      { path: document.path },
    );
  }
  return document;
};
