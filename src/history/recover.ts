import { SupabashError } from '../api/errors.js';
import type { RevisionEntry } from '../api/history.js';
import { comparePaths } from '../core/entry-order.js';
import { sha256 } from '../core/hash.js';
import type { RemoteEntry, ScopedStorage, UploadEntry } from '../core/storage.js';
import type { HistoryBlobStore } from './blob-store.js';
import { readBytes, readJson, writeJson } from './json-io.js';
import { HISTORY_ROOT, historyKey } from './keys.js';
import { parseHead, parseIdempotency, parseIntent, parseRevision } from './parse.js';
import { listCompleteRecords } from './query.js';
import {
  currentSchema,
  type CompleteRecord,
  type HeadRecord,
  type IntentRecord,
} from './records.js';

export const recoverWorkspace = async (storage: ScopedStorage): Promise<boolean> => {
  try {
    await recoverPublishedHead(storage.history);
    const unresolved = await unresolvedIntents(storage.history);
    if (unresolved.length === 0) {
      return false;
    }
    const target = await recoveryTarget(storage.history, unresolved);
    await restoreVisibleTree(storage, target);
    const abortedAt = new Date().toISOString();
    for (const intent of unresolved) {
      await writeJson(storage.history, historyKey.abort(intent.transactionId), {
        abortedAt,
        reason: 'recovered',
        schemaVersion: currentSchema(),
        transactionId: intent.transactionId,
      });
    }
    return true;
  } catch (error) {
    if (error instanceof SupabashError && error.code === 'PARTIAL_COMMIT') {
      throw error;
    }
    throw new SupabashError('PARTIAL_COMMIT', 'Workspace recovery did not finish.', {
      cause: error,
    });
  }
};

export const recoverPublishedHead = async (history: HistoryBlobStore): Promise<void> => {
  const completes = await listCompleteRecords(history);
  if (completes.length === 0) {
    return;
  }
  const head = await readJson(history, historyKey.head, parseHead);
  const adopted =
    head === undefined
      ? newestDescendant(completes, null)
      : (newestDescendant(completes, head.revision) ??
        completes.find((record) => record.newRevision === head.revision));
  if (adopted === undefined) {
    return;
  }
  await recoverIdempotency(history, adopted);
  if (head?.revision === adopted.newRevision) {
    return;
  }
  const nextHead: HeadRecord = {
    committedAt: adopted.committedAt,
    revision: adopted.newRevision,
    schemaVersion: adopted.schemaVersion,
    transactionId: adopted.transactionId,
  };
  await writeJson(history, historyKey.head, nextHead);
};

const unresolvedIntents = async (history: HistoryBlobStore): Promise<readonly IntentRecord[]> => {
  const listed = await history.list(`${HISTORY_ROOT}/transactions/`);
  const terminal = new Set(
    listed
      .filter((key) => key.endsWith('/complete.json') || key.endsWith('/abort.json'))
      .map((key) => key.slice(0, key.lastIndexOf('/'))),
  );
  const intents: IntentRecord[] = [];
  for (const key of listed.filter((entry) => entry.endsWith('/intent.json'))) {
    if (!terminal.has(key.slice(0, key.lastIndexOf('/')))) {
      const intent = await readJson(history, key, parseIntent);
      if (intent !== undefined) {
        intents.push(intent);
      }
    }
  }
  return intents.toSorted((left, right) => {
    const byTime = comparePaths(left.createdAt, right.createdAt);
    return byTime === 0 ? comparePaths(left.transactionId, right.transactionId) : byTime;
  });
};

const recoveryTarget = async (
  history: HistoryBlobStore,
  intents: readonly IntentRecord[],
): Promise<readonly RevisionEntry[]> => {
  const head = await readJson(history, historyKey.head, parseHead);
  if (head !== undefined) {
    const revision = await readJson(history, historyKey.revision(head.revision), parseRevision);
    if (revision === undefined) {
      throw new SupabashError('HISTORY_CORRUPTION', 'Head revision manifest is missing.');
    }
    return revision.entries;
  }
  const baseline = intents[0]?.baselineEntries;
  if (baseline === undefined) {
    throw new SupabashError(
      'HISTORY_CORRUPTION',
      'An initial partial commit has no recovery snapshot.',
    );
  }
  return baseline;
};

const restoreVisibleTree = async (
  storage: ScopedStorage,
  target: readonly RevisionEntry[],
): Promise<void> => {
  const current = await storage.list();
  const currentByPath = new Map(current.map((entry) => [entry.path, entry]));
  const targetPaths = new Set(target.map((entry) => entry.path));
  for (const entry of target) {
    if (!sameEntry(currentByPath.get(entry.path), entry)) {
      await storage.upload(await recoveryUpload(storage.history, entry));
    }
  }
  await storage.delete(current.filter((entry) => !targetPaths.has(entry.path)));
};

const recoveryUpload = async (
  history: HistoryBlobStore,
  entry: RevisionEntry,
): Promise<UploadEntry> => {
  const body =
    entry.entryKind === 'file' && entry.contentHash !== undefined
      ? await readBytes(history, historyKey.object(entry.contentHash))
      : undefined;
  if (entry.entryKind === 'file' && body === undefined) {
    throw new SupabashError('HISTORY_CORRUPTION', 'Recovery file body is missing.', {
      path: entry.path,
    });
  }
  const modifiedAt = new Date();
  const versionHash = await sha256(
    new TextEncoder().encode(
      JSON.stringify({
        contentHash: entry.contentHash,
        kind: entry.entryKind,
        mode: entry.mode,
        modifiedAt: modifiedAt.toISOString(),
        target: entry.target,
      }),
    ),
  );
  return {
    ...(body !== undefined && { body }),
    ...(entry.contentHash !== undefined && { contentHash: entry.contentHash }),
    kind: entry.entryKind,
    mode: entry.mode,
    modifiedAt,
    path: entry.path,
    ...(entry.target !== undefined && { target: entry.target }),
    versionHash,
  };
};

const sameEntry = (current: RemoteEntry | undefined, target: RevisionEntry): boolean =>
  current !== undefined &&
  current.kind === target.entryKind &&
  current.mode === target.mode &&
  current.contentHash === target.contentHash &&
  current.target === target.target;

const recoverIdempotency = async (
  history: HistoryBlobStore,
  complete: CompleteRecord,
): Promise<void> => {
  if (complete.idempotencyKey === undefined) {
    return;
  }
  const key = historyKey.idempotency(complete.idempotencyKey);
  const existing = await readJson(history, key, parseIdempotency);
  if (existing !== undefined) {
    return;
  }
  await writeJson(history, key, {
    fingerprint: complete.fingerprint,
    revision: complete.newRevision,
    schemaVersion: currentSchema(),
    transactionId: complete.transactionId,
  });
};

const compareCompletes = (left: CompleteRecord, right: CompleteRecord): number => {
  const byTime = comparePaths(left.committedAt, right.committedAt);
  return byTime === 0 ? comparePaths(left.transactionId, right.transactionId) : byTime;
};

const newestDescendant = (
  completes: readonly CompleteRecord[],
  start: string | null,
): CompleteRecord | undefined => {
  let revision = start;
  let current: CompleteRecord | undefined;
  for (;;) {
    const parentRevision = revision;
    const child = completes
      .filter((record) => record.parentRevision === parentRevision)
      .toSorted(compareCompletes)
      .at(-1);
    if (child === undefined) {
      return current;
    }
    current = child;
    revision = child.newRevision;
  }
};
