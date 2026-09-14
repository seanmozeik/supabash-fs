import { SupabashError } from '../api/errors.js';
import type { PostgresWorkspaceSnapshot } from '../api/postgres.js';
import type { PinnedSnapshot } from './contracts.js';
import { loadDocument } from './document-loader.js';

export const publicSnapshot = async (
  snapshot: PinnedSnapshot,
): Promise<PostgresWorkspaceSnapshot> => {
  let source = snapshot;
  if (
    snapshot.revision !== null &&
    snapshot.loadSnapshot !== undefined &&
    snapshot.documents.some((entry) => !('body' in entry))
  ) {
    const loaded = await snapshot.loadSnapshot(snapshot.revision);
    const entries = new Map(loaded.documents.map((entry) => [entry.path, entry]));
    if (
      loaded.revision !== snapshot.revision ||
      loaded.documents.length !== snapshot.documents.length ||
      entries.size !== snapshot.documents.length ||
      snapshot.documents.some((entry) => {
        const document = entries.get(entry.path);
        return (
          document === undefined ||
          document.bodyHash !== entry.bodyHash ||
          document.contentHash !== entry.contentHash ||
          document.bodyByteSize !== entry.bodyByteSize ||
          document.byteSize !== entry.byteSize
        );
      })
    ) {
      throw new SupabashError(
        'HISTORY_CORRUPTION',
        'Bulk snapshot does not match its pinned manifest.',
      );
    }
    source = loaded;
  }
  const documents = [];
  for (const entry of source.documents) {
    documents.push(await loadDocument(source, entry));
  }
  return Object.freeze({
    committedAt: snapshot.committedAt === undefined ? null : new Date(snapshot.committedAt),
    documents: Object.freeze(
      documents.map((document) =>
        Object.freeze({
          body: document.body,
          bodyByteSize: document.bodyByteSize,
          bodyHash: document.bodyHash,
          byteSize: document.byteSize,
          content: document.content,
          contentHash: document.contentHash,
          metadata: Object.freeze({ ...document.metadata }),
          path: document.path,
        }),
      ),
    ),
    revision: snapshot.revision,
    transactionId: snapshot.transactionId ?? null,
  });
};
