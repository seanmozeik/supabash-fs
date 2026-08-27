import { SupabashError } from '../api/errors.js';
import { isJsonRecord, type JsonValue } from '../api/json.js';
import { parseChanges, parseRevisionEntries } from './parse-entries.js';
import type {
  CheckpointRecord,
  CompleteRecord,
  HeadRecord,
  IntentRecord,
  RevisionRecord,
} from './records.js';

export const parseHead = (value: unknown): HeadRecord => {
  const record = asObject(value);
  return {
    committedAt: requiredString(record, 'committedAt'),
    revision: requiredString(record, 'revision'),
    schemaVersion: requiredNumber(record, 'schemaVersion'),
    transactionId: requiredString(record, 'transactionId'),
  };
};

export const parseComplete = (value: unknown): CompleteRecord => {
  const intent = parseIntent(value);
  const record = asObject(value);
  return { ...intent, committedAt: requiredString(record, 'committedAt'), status: 'complete' };
};

export const parseIntent = (value: unknown): IntentRecord => {
  const record = asObject(value);
  const cause = optionalString(record, 'cause');
  const idempotencyKey = optionalString(record, 'idempotencyKey');
  const metadata = optionalMetadata(record);
  const parsed: IntentRecord = {
    actor: requiredString(record, 'actor'),
    changes: parseChanges(record['changes']),
    correlationId: requiredString(record, 'correlationId'),
    createdAt: requiredString(record, 'createdAt'),
    newRevision: requiredString(record, 'newRevision'),
    parentRevision: nullableString(record, 'parentRevision'),
    schemaVersion: requiredNumber(record, 'schemaVersion'),
    transactionId: requiredString(record, 'transactionId'),
  };
  return {
    ...parsed,
    ...(cause !== undefined && { cause }),
    ...(idempotencyKey !== undefined && { idempotencyKey }),
    ...(metadata !== undefined && { metadata }),
  };
};

export const parseRevision = (value: unknown): RevisionRecord => {
  const record = asObject(value);
  return {
    committedAt: requiredString(record, 'committedAt'),
    entries: parseRevisionEntries(record['entries']),
    parentRevision: nullableString(record, 'parentRevision'),
    revision: requiredString(record, 'revision'),
    schemaVersion: requiredNumber(record, 'schemaVersion'),
    transactionId: requiredString(record, 'transactionId'),
  };
};

export const parseCheckpoint = (value: unknown): CheckpointRecord => {
  const record = asObject(value);
  const label = optionalString(record, 'label');
  const retentionClass = optionalString(record, 'retentionClass');
  const idempotencyKey = optionalString(record, 'idempotencyKey');
  const parsed: CheckpointRecord = {
    checkpointId: requiredString(record, 'checkpointId'),
    createdAt: requiredString(record, 'createdAt'),
    revision: requiredString(record, 'revision'),
    schemaVersion: requiredNumber(record, 'schemaVersion'),
  };
  return {
    ...parsed,
    ...(idempotencyKey !== undefined && { idempotencyKey }),
    ...(label !== undefined && { label }),
    ...(retentionClass !== undefined && { retentionClass }),
  };
};

const asObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SupabashError('HISTORY_CORRUPTION', 'History record is not an object.');
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = entry;
  }
  return result;
};

const requiredString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new SupabashError('HISTORY_CORRUPTION', `History record is missing '${key}'.`);
  }
  return value;
};

const optionalString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new SupabashError(
      'HISTORY_CORRUPTION',
      `History record field '${key}' must be a string.`,
    );
  }
  return value;
};

const nullableString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new SupabashError(
      'HISTORY_CORRUPTION',
      `History record field '${key}' must be a string.`,
    );
  }
  return value;
};

const requiredNumber = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SupabashError('HISTORY_CORRUPTION', `History record is missing '${key}'.`);
  }
  return value;
};

const optionalMetadata = (
  record: Record<string, unknown>,
): Readonly<Record<string, JsonValue>> | undefined => {
  const value = record['metadata'];
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonRecord(value)) {
    throw new SupabashError('HISTORY_CORRUPTION', 'Transaction metadata is invalid.');
  }
  return value;
};
