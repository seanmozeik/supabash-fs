import type { CheckpointOptions, CheckpointReceipt } from '../api/history.js';
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
