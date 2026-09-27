import type { CommitReceipt } from '../api/contracts.js';
import { comparePaths } from '../core/entry-order.js';
import type { PendingChanges } from '../core/storage.js';
import type { BackendDocument, PinnedSnapshot } from './contracts.js';

/** Build the new committed tree from accepted mutations, without reading unchanged files. */
export const committedTree = (
  previous: PinnedSnapshot,
  pending: PendingChanges,
  prepared: ReadonlyMap<string, BackendDocument>,
  receipt: CommitReceipt,
): PinnedSnapshot => {
  const documents = new Map(previous.documents.map((document) => [document.path, document]));
  for (const { path } of pending.deletions) {
    documents.delete(path);
  }
  for (const { from } of pending.moves) {
    documents.delete(from);
  }
  for (const [path, document] of prepared) {
    documents.set(path, document);
  }
  return {
    committedAt: receipt.committedAt,
    documents: [...documents.values()].toSorted((left, right) =>
      comparePaths(left.path, right.path),
    ),
    revision: receipt.revision,
    ...(previous.redactionEpoch !== undefined && { redactionEpoch: previous.redactionEpoch }),
    transactionId: receipt.transactionId,
    ...(previous.loadDocument !== undefined && { loadDocument: previous.loadDocument }),
    ...(previous.loadSnapshot !== undefined && { loadSnapshot: previous.loadSnapshot }),
  };
};
