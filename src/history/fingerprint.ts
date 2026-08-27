import type { CommitContext } from '../api/commit.js';
import type { WorkspaceChange } from '../api/contracts.js';
import { isJsonRecord, type JsonValue } from '../api/json.js';
import { comparePaths } from '../core/entry-order.js';
import { sha256 } from '../core/hash.js';

export const commitFingerprint = (
  changes: readonly WorkspaceChange[],
  context: CommitContext,
): Promise<string> => {
  const input = {
    actor: context.actor,
    cause: context.cause ?? null,
    changes: changes.map((change) => changeValue(change)),
    correlationId: context.correlationId,
    metadata: context.metadata ?? null,
  } satisfies JsonValue;
  return sha256(new TextEncoder().encode(JSON.stringify(stable(input))));
};

const stable = (value: JsonValue): JsonValue => {
  if (isJsonArray(value)) {
    return value.map((entry) => stable(entry));
  }
  if (isJsonRecord(value)) {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).toSorted(comparePaths)) {
      const entry = value[key];
      if (entry !== undefined) {
        sorted[key] = stable(entry);
      }
    }
    return sorted;
  }
  return value;
};

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

const changeValue = (change: WorkspaceChange): Readonly<Record<string, JsonValue>> => ({
  entryKind: change.entryKind,
  kind: change.kind,
  path: change.path,
  ...(change.afterEtag !== undefined && { afterEtag: change.afterEtag }),
  ...(change.afterHash !== undefined && { afterHash: change.afterHash }),
  ...(change.afterSize !== undefined && { afterSize: change.afterSize }),
  ...(change.beforeEtag !== undefined && { beforeEtag: change.beforeEtag }),
  ...(change.beforeHash !== undefined && { beforeHash: change.beforeHash }),
  ...(change.beforeSize !== undefined && { beforeSize: change.beforeSize }),
  ...(change.contentHash !== undefined && { contentHash: change.contentHash }),
  ...(change.etag !== undefined && { etag: change.etag }),
  ...(change.moveFrom !== undefined && { moveFrom: change.moveFrom }),
  ...(change.moveTo !== undefined && { moveTo: change.moveTo }),
});
