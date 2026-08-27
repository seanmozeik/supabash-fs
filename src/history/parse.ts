import { SupabashError } from '../api/errors.js';
import { isJsonRecord, type JsonValue } from '../api/json.js';
import {
  parseHistoryObject,
  nullableString,
  optionalString,
  requiredNumber,
  requiredString,
} from './fields.js';
import { parseChanges, parseRevisionEntries } from './parse-entries.js';
import type {
  CheckpointRecord,
  CompleteRecord,
  HeadRecord,
  IntentRecord,
  RevisionRecord,
} from './records.js';

export const parseHead = (value: unknown): HeadRecord => {
  const record = parseHistoryObject(value);
  return {
    committedAt: requiredString(record, 'committedAt'),
    revision: requiredString(record, 'revision'),
    schemaVersion: requiredNumber(record, 'schemaVersion'),
    transactionId: requiredString(record, 'transactionId'),
  };
};

export const parseComplete = (value: unknown): CompleteRecord => {
  const intent = parseIntent(value);
  const record = parseHistoryObject(value);
  return { ...intent, committedAt: requiredString(record, 'committedAt'), status: 'complete' };
};

export const parseIntent = (value: unknown): IntentRecord => {
  const record = parseHistoryObject(value);
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
  const record = parseHistoryObject(value);
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
  const record = parseHistoryObject(value);
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
