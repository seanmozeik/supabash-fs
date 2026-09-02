import type { PostgresWorkspaceSnapshot } from '../api/postgres.js';
import type { PinnedSnapshot } from './contracts.js';

export const publicSnapshot = (snapshot: PinnedSnapshot): PostgresWorkspaceSnapshot =>
  Object.freeze({
    committedAt: snapshot.committedAt === undefined ? null : new Date(snapshot.committedAt),
    documents: Object.freeze(
      snapshot.documents.map((document) =>
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
