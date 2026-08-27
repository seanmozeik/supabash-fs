import type { CommitContext, CommitCoordinator } from '../api/commit.js';
import type { CommitReceipt, WorkspaceChange } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
import type { RemoteEntry, ScopedStorage } from '../core/storage.js';
import type { HistoryBlobStore } from './blob-store.js';
import { readJson, writeJson } from './json-io.js';
import { historyKey } from './keys.js';
import { parseComplete, parseHead, parseIdempotency } from './parse.js';
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
  readonly fingerprint: string;
  readonly history: HistoryBlobStore;
  readonly scope: string;
  readonly storage: ScopedStorage;
  readonly uploads: readonly RemoteEntry[];
}

export const existingIdempotentReceipt = async (
  history: HistoryBlobStore,
  context: CommitContext,
  scope: string,
  fingerprint: string,
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
  if (replay.fingerprint !== undefined && replay.fingerprint !== fingerprint) {
    throw new SupabashError(
      'IDEMPOTENCY_CONFLICT',
      'The idempotency key is already bound to a different commit.',
    );
  }
  const complete = await readJson(
    history,
    historyKey.complete(replay.transactionId),
    parseComplete,
  );
  if (complete === undefined) {
    return undefined;
  }
  if (!complete.fingerprint.startsWith('legacy:') && complete.fingerprint !== fingerprint) {
    throw new SupabashError(
      'IDEMPOTENCY_CONFLICT',
      'The idempotency key is already bound to a different commit.',
    );
  }
  return receiptFrom(complete, scope, complete.changes);
};

export const receiptForTransaction = async (
  history: HistoryBlobStore,
  transactionId: string,
  scope: string,
  fingerprint: string,
): Promise<CommitReceipt | undefined> => {
  const complete = await readJson(history, historyKey.complete(transactionId), parseComplete);
  if (complete === undefined) {
    return undefined;
  }
  if (!complete.fingerprint.startsWith('legacy:') && complete.fingerprint !== fingerprint) {
    throw new SupabashError(
      'IDEMPOTENCY_CONFLICT',
      'The prior partial commit is bound to a different staged change set.',
    );
  }
  return receiptFrom(complete, scope, complete.changes);
};

export const writeIntent = async (
  input: Omit<PublishInput, 'uploads'>,
  transactionId: string,
  revision: string,
): Promise<IntentRecord> => {
  const head = await readJson(input.history, historyKey.head, parseHead);
  const baselineEntries =
    head === undefined
      ? await revisionEntriesFrom(input.baseline, [], [], input.storage, input.history)
      : undefined;
  const intent = intentRecord(input, head, transactionId, revision, new Date(), baselineEntries);
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
    changes: input.changes,
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
  if (input.context.idempotencyKey !== undefined) {
    await writeJson(input.history, historyKey.idempotency(input.context.idempotencyKey), {
      fingerprint: input.fingerprint,
      revision: intent.newRevision,
      schemaVersion: currentSchema(),
      transactionId: intent.transactionId,
    } satisfies IdempotencyRecord);
  }
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
  const lost = (): Promise<boolean> => lease.lost();
  const outcome = await runWithLease(lost, run);
  try {
    await lease.release();
  } catch {
    // The coordinator must expire an unreleased lease. Release failure cannot undo the run.
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
};

type LeaseOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly error: unknown; readonly ok: false };

const runWithLease = async <T>(
  lost: () => Promise<boolean>,
  run: (lost: () => Promise<boolean>) => Promise<T>,
): Promise<LeaseOutcome<T>> => {
  try {
    if (await lost()) {
      throw new SupabashError('COMMIT_COORDINATION', 'Commit lease was lost before publish.');
    }
    return { ok: true, value: await run(lost) };
  } catch (error) {
    return { error, ok: false };
  }
};

const intentRecord = (
  input: Omit<PublishInput, 'uploads'>,
  head: HeadRecord | undefined,
  transactionId: string,
  revision: string,
  committedAt: Date,
  baselineEntries: IntentRecord['baselineEntries'],
): IntentRecord => ({
  actor: input.context.actor,
  ...(baselineEntries !== undefined && { baselineEntries }),
  changes: input.changes,
  correlationId: input.context.correlationId,
  createdAt: committedAt.toISOString(),
  fingerprint: input.fingerprint,
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
  ...(complete.idempotencyKey !== undefined && { idempotencyKey: complete.idempotencyKey }),
  ...(complete.metadata !== undefined && { metadata: complete.metadata }),
});
