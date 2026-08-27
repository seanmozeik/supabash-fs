import type { CommitContext, CommitCoordinator } from '../api/commit.js';
import type { CommitReceipt, WorkspaceChange } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
import type { RemoteEntry, ScopedStorage } from '../core/storage.js';
import type { HistoryBlobStore } from './blob-store.js';
import { parseHistoryObject, requiredString } from './fields.js';
import { readJson, writeJson } from './json-io.js';
import { historyKey } from './keys.js';
import { parseComplete, parseHead } from './parse.js';
import {
  currentSchema,
  type CompleteRecord,
  type HeadRecord,
  type IdempotencyRecord,
  type IntentRecord,
} from './records.js';
import { revisionEntriesFrom } from './snapshot.js';

export interface PublishInput {
  readonly baseline: readonly RemoteEntry[];
  readonly changes: readonly WorkspaceChange[];
  readonly context: CommitContext;
  readonly coordinator?: CommitCoordinator;
  readonly deletions: readonly RemoteEntry[];
  readonly history: HistoryBlobStore;
  readonly scope: string;
  readonly storage: ScopedStorage;
  readonly uploads: readonly RemoteEntry[];
}

export const existingIdempotentReceipt = async (
  history: HistoryBlobStore,
  context: CommitContext,
  scope: string,
): Promise<CommitReceipt | undefined> => {
  if (context.idempotencyKey === undefined) {
    return undefined;
  }
  const replay = await readJson(
    history,
    historyKey.idempotency(context.idempotencyKey),
    parseIdempotency,
  );
  if (replay === undefined) {
    return undefined;
  }
  const complete = await readJson(
    history,
    historyKey.complete(replay.transactionId),
    parseComplete,
  );
  return complete === undefined ? undefined : receiptFrom(complete, scope, complete.changes);
};

export const writeIntent = async (
  input: Omit<PublishInput, 'uploads'>,
  transactionId: string,
  revision: string,
): Promise<IntentRecord> => {
  const head = await readJson(input.history, historyKey.head, parseHead);
  const intent = intentRecord(input, head, transactionId, revision, new Date());
  await writeJson(input.history, historyKey.intent(transactionId), intent);
  return intent;
};

export const finalizePublish = async (
  input: PublishInput,
  intent: IntentRecord,
  leaseLost: () => Promise<boolean>,
): Promise<CommitReceipt> => {
  if (await leaseLost()) {
    throw new SupabashError('COMMIT_COORDINATION', 'Commit lease was lost before head publish.');
  }
  const committedAt = new Date();
  const entries = await revisionEntriesFrom(
    input.baseline,
    input.deletions,
    input.uploads,
    input.storage,
    input.history,
  );
  const complete: CompleteRecord = {
    ...intent,
    committedAt: committedAt.toISOString(),
    status: 'complete',
  };
  await writeJson(input.history, historyKey.revision(intent.newRevision), {
    committedAt: complete.committedAt,
    entries,
    parentRevision: intent.parentRevision,
    revision: intent.newRevision,
    schemaVersion: currentSchema(),
    transactionId: intent.transactionId,
  });
  await writeJson(input.history, historyKey.complete(intent.transactionId), complete);
  if (await leaseLost()) {
    throw new SupabashError('COMMIT_COORDINATION', 'Commit lease was lost before head publish.');
  }
  const nextHead: HeadRecord = {
    committedAt: complete.committedAt,
    revision: intent.newRevision,
    schemaVersion: currentSchema(),
    transactionId: intent.transactionId,
  };
  await writeJson(input.history, historyKey.head, nextHead);
  if (input.context.idempotencyKey !== undefined) {
    await writeJson(input.history, historyKey.idempotency(input.context.idempotencyKey), {
      revision: intent.newRevision,
      schemaVersion: currentSchema(),
      transactionId: intent.transactionId,
    } satisfies IdempotencyRecord);
  }
  return receiptFrom(complete, input.scope, input.changes);
};

export const withLease = async <T>(
  coordinator: CommitCoordinator | undefined,
  scope: string,
  transactionId: string,
  run: (lost: () => Promise<boolean>) => Promise<T>,
): Promise<T> => {
  if (coordinator === undefined) {
    return run(() => Promise.resolve(false));
  }
  const lease = await coordinator.acquire({ scope, transactionId });
  try {
    if (await lease.lost()) {
      throw new SupabashError('COMMIT_COORDINATION', 'Commit lease was lost before publish.');
    }
    return await run(() => lease.lost());
  } finally {
    await lease.release();
  }
};

const parseIdempotency = (value: unknown): IdempotencyRecord => {
  const record = parseHistoryObject(value);
  return {
    revision: requiredString(record, 'revision'),
    schemaVersion: currentSchema(),
    transactionId: requiredString(record, 'transactionId'),
  };
};

const intentRecord = (
  input: Omit<PublishInput, 'uploads'>,
  head: HeadRecord | undefined,
  transactionId: string,
  revision: string,
  committedAt: Date,
): IntentRecord => ({
  actor: input.context.actor,
  changes: input.changes,
  correlationId: input.context.correlationId,
  createdAt: committedAt.toISOString(),
  newRevision: revision,
  parentRevision: head?.revision ?? null,
  schemaVersion: currentSchema(),
  transactionId,
  ...(input.context.cause !== undefined && { cause: input.context.cause }),
  ...(input.context.idempotencyKey !== undefined && {
    idempotencyKey: input.context.idempotencyKey,
  }),
  ...(input.context.metadata !== undefined && { metadata: input.context.metadata }),
});

const receiptFrom = (
  complete: CompleteRecord,
  scope: string,
  changes: readonly WorkspaceChange[],
): CommitReceipt => ({
  actor: complete.actor,
  changes,
  committedAt: new Date(complete.committedAt),
  correlationId: complete.correlationId,
  cursor: complete.transactionId,
  parentRevision: complete.parentRevision,
  revision: complete.newRevision,
  schemaVersion: complete.schemaVersion,
  scope,
  status: 'complete',
  transactionId: complete.transactionId,
  ...(complete.cause !== undefined && { cause: complete.cause }),
});
