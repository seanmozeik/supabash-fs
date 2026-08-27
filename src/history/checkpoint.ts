import { SupabashError } from '../api/errors.js';
import type {
  CheckpointOptions,
  CheckpointReceipt,
  CheckpointRecord as PublicCheckpointRecord,
} from '../api/history.js';
import { comparePaths } from '../core/entry-order.js';
import type { HistoryBlobStore } from './blob-store.js';
import { readJson, writeJson } from './json-io.js';
import { historyKey } from './keys.js';
import { parseCheckpoint } from './parse.js';
import { requireHeadRevision } from './query.js';
import { currentSchema } from './records.js';

export const createCheckpoint = async (
  history: HistoryBlobStore,
  options: CheckpointOptions = {},
): Promise<CheckpointReceipt> => {
  const revision = await requireHeadRevision(history);
  if (options.idempotencyKey !== undefined) {
    const existing = await readJson(
      history,
      historyKey.checkpoint(options.idempotencyKey),
      parseCheckpoint,
    );
    if (existing !== undefined) {
      return {
        checkpointId: existing.checkpointId,
        createdAt: new Date(existing.createdAt),
        revision: existing.revision,
      };
    }
  }
  const checkpointId = options.idempotencyKey ?? crypto.randomUUID();
  const createdAt = new Date();
  await writeJson(history, historyKey.checkpoint(checkpointId), {
    checkpointId,
    createdAt: createdAt.toISOString(),
    revision,
    schemaVersion: currentSchema(),
    ...(options.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
    ...(options.label !== undefined && { label: options.label }),
    ...(options.retentionClass !== undefined && { retentionClass: options.retentionClass }),
  });
  return { checkpointId, createdAt, revision };
};

export const listCheckpoints = async (
  history: HistoryBlobStore,
): Promise<readonly PublicCheckpointRecord[]> => {
  const keys = await history.list('.supabash/checkpoints/');
  const records: PublicCheckpointRecord[] = [];
  for (const key of keys.filter((entry) => entry.endsWith('.json'))) {
    const checkpoint = await readJson(history, key, parseCheckpoint);
    if (checkpoint !== undefined) {
      records.push({
        checkpointId: checkpoint.checkpointId,
        createdAt: new Date(checkpoint.createdAt),
        revision: checkpoint.revision,
        ...(checkpoint.idempotencyKey !== undefined && {
          idempotencyKey: checkpoint.idempotencyKey,
        }),
        ...(checkpoint.label !== undefined && { label: checkpoint.label }),
        ...(checkpoint.retentionClass !== undefined && {
          retentionClass: checkpoint.retentionClass,
        }),
      });
    }
  }
  return records.toSorted((left, right) => {
    const byTime = left.createdAt.getTime() - right.createdAt.getTime();
    return byTime === 0 ? comparePaths(left.checkpointId, right.checkpointId) : byTime;
  });
};

export const removeCheckpoint = async (
  history: HistoryBlobStore,
  checkpointId: string,
): Promise<void> => {
  if (checkpointId.length === 0) {
    throw new SupabashError('INVALID_PATH', 'Checkpoint ID must not be empty.');
  }
  await history.remove([historyKey.checkpoint(checkpointId)]);
};
