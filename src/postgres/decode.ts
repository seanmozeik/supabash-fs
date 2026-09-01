import type { CommitReceipt, WorkspaceChange, WorkspaceEntryKind } from '../api/contracts.js';
import type {
  DocumentMetadata,
  DocumentMetadataValue,
  TextDocumentCodec,
} from '../api/document-codec.js';
import { SupabashError } from '../api/errors.js';
import type {
  CheckpointReceipt,
  CheckpointRecord,
  HistoryPage,
  HistoryRecord,
  PurgeReceipt,
  RevisionDiff,
  RevisionDiffEntry,
  RevisionDiffKind,
} from '../api/history.js';
import type { JsonValue } from '../api/json.js';
import type { BackendDocument, PinnedSnapshot } from '../backend/contracts.js';
import { normalizeVirtualPath } from '../core/path.js';
import { isRuntimeOwnedPath } from '../core/runtime-paths.js';
import {
  arrayField as array,
  booleanField as boolean,
  corrupt,
  dateField as date,
  nullableString,
  numberField as number,
  decodeObject as object,
  decodeValueAt as valueAt,
  optionalBoolean,
  optionalJsonObject,
  optionalNumber,
  optionalString,
  primitiveString,
  stringField as string,
  textField as text,
} from './decode-fields.js';

const SHA256 = /^[0-9a-f]{64}$/u;

export const decodeSnapshot = (
  value: unknown,
  documentCodec: TextDocumentCodec,
): PinnedSnapshot => {
  const record = object(value, 'snapshot');
  const revision = nullableString(record, 'headRevision', 'head_revision', 'revision');
  const committedAt = optionalString(record, 'committedAt', 'committed_at');
  const transactionId = optionalString(record, 'transactionId', 'transaction_id');
  const documents = array(record, 'documents').map((entry) => decodeDocument(entry, documentCodec));
  if (new Set(documents.map(({ path }) => path)).size !== documents.length) {
    throw corrupt('Postgres snapshot contains duplicate document paths.');
  }
  return {
    documents,
    revision,
    ...(committedAt !== undefined && { committedAt: date(committedAt, 'snapshot committedAt') }),
    ...(transactionId !== undefined && { transactionId }),
  };
};

export const decodeCommitResult = (
  value: unknown,
): { readonly receipt: CommitReceipt; readonly replayed: boolean } => {
  const record = object(value, 'commit result');
  const receiptValue = valueAt(record, 'receipt') ?? value;
  return {
    receipt: decodeReceipt(receiptValue),
    replayed: optionalBoolean(record, 'replayed') ?? false,
  };
};

export const decodeHistoryPage = (value: unknown): HistoryPage => {
  if (Array.isArray(value)) {
    return { records: value.map((entry) => decodeHistoryRecord(entry)) };
  }
  const record = object(value, 'history page');
  const nextCursor = optionalString(record, 'nextCursor', 'next_cursor');
  return {
    records: array(record, 'records').map((entry) => decodeHistoryRecord(entry)),
    ...(nextCursor !== undefined && { nextCursor }),
  };
};

export const decodeDiff = (value: unknown): RevisionDiff => {
  const record = object(value, 'revision diff');
  return {
    entries: array(record, 'entries').map((entry) => decodeDiffEntry(entry)),
    fromRevision: string(record, 'fromRevision', 'from_revision'),
    toRevision: string(record, 'toRevision', 'to_revision'),
  };
};

export const decodeCheckpoint = (value: unknown): CheckpointReceipt => {
  const record = object(value, 'checkpoint');
  return {
    checkpointId: string(record, 'checkpointId', 'checkpoint_id'),
    createdAt: date(string(record, 'createdAt', 'created_at'), 'checkpoint createdAt'),
    revision: string(record, 'revision'),
  };
};

export const decodeCheckpoints = (value: unknown): readonly CheckpointRecord[] => {
  if (!Array.isArray(value)) {
    throw corrupt('Checkpoint list is not an array.');
  }
  return value.map((entry) => {
    const record = object(entry, 'checkpoint');
    const idempotencyKey = optionalString(record, 'idempotencyKey', 'idempotency_key');
    const label = optionalString(record, 'label');
    const retentionClass = optionalString(record, 'retentionClass', 'retention_class');
    return {
      ...decodeCheckpoint(entry),
      ...(idempotencyKey !== undefined && { idempotencyKey }),
      ...(label !== undefined && { label }),
      ...(retentionClass !== undefined && { retentionClass }),
    };
  });
};

export const decodePurge = (value: unknown): PurgeReceipt => {
  const record = object(value, 'purge receipt');
  return {
    bytes: number(record, 'bytes'),
    dryRun: boolean(record, 'dryRun', 'dry_run'),
    objects: array(record, 'objects').map((entry) => primitiveString(entry, 'purged object')),
  };
};

const decodeDocument = (value: unknown, documentCodec: TextDocumentCodec): BackendDocument => {
  const record = object(value, 'snapshot document');
  const body = text(record, 'body');
  const bodyHash = string(record, 'bodyHash', 'body_hash', 'contentHash', 'content_hash');
  const bodyByteSize =
    optionalNumber(record, 'bodyByteSize', 'body_byte_size') ??
    number(record, 'byteSize', 'byte_size', 'size');
  const metadata = documentMetadata(optionalJsonObject(record, 'metadata') ?? {}, record);
  const path = string(record, 'path');
  let canonical: string;
  try {
    canonical = normalizeVirtualPath(path);
  } catch (error) {
    throw new SupabashError('HISTORY_CORRUPTION', 'Snapshot document path is invalid.', {
      cause: error,
      path,
    });
  }
  if (canonical !== path || isRuntimeOwnedPath(path)) {
    throw corrupt('Snapshot document path is not one canonical user path.', path);
  }
  const content = documentCodec.render({ body, metadata, path });
  const contentHash = optionalString(record, 'contentHash', 'content_hash') ?? bodyHash;
  const byteSize =
    optionalNumber(record, 'contentByteSize', 'content_byte_size') ??
    number(record, 'byteSize', 'byte_size', 'size');
  if (!SHA256.test(bodyHash) || !SHA256.test(contentHash)) {
    throw corrupt('Snapshot document hash is invalid.', path);
  }
  if (new TextEncoder().encode(body).byteLength !== bodyByteSize) {
    throw corrupt('Snapshot stored byte size does not match its UTF-8 body.', path);
  }
  if (new TextEncoder().encode(content).byteLength !== byteSize) {
    throw corrupt('Snapshot visible byte size does not match its rendered document.', path);
  }
  if (body.includes('\0')) {
    throw new SupabashError('UNSUPPORTED_CONTENT', 'Postgres text contains NUL.', { path });
  }
  return { body, bodyByteSize, bodyHash, byteSize, content, contentHash, metadata, path };
};

const documentMetadata = (
  value: Readonly<Record<string, JsonValue>>,
  record: Readonly<Record<string, unknown>>,
): DocumentMetadata => {
  const metadata: Record<string, DocumentMetadataValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isDocumentMetadataValue(entry)) {
      throw corrupt(
        'Snapshot document metadata is not a flat scalar mapping.',
        String(record['path']),
      );
    }
    metadata[key] = entry;
  }
  return metadata;
};

const isDocumentMetadataValue = (value: unknown): value is DocumentMetadataValue =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

const decodeReceipt = (value: unknown): CommitReceipt => {
  const record = object(value, 'commit receipt');
  const cause = optionalString(record, 'cause');
  const idempotencyKey = optionalString(record, 'idempotencyKey', 'idempotency_key');
  const metadata = optionalJsonObject(record, 'metadata');
  const status = string(record, 'status');
  if (status !== 'complete') {
    throw corrupt('Postgres commit receipt is not complete.');
  }
  return {
    actor: string(record, 'actor'),
    changes: array(record, 'changes').map((entry) => decodeChange(entry)),
    committedAt: date(string(record, 'committedAt', 'committed_at'), 'receipt committedAt'),
    correlationId: string(record, 'correlationId', 'correlation_id'),
    cursor: string(record, 'cursor'),
    parentRevision: nullableString(record, 'parentRevision', 'parent_revision'),
    revision: string(record, 'revision'),
    schemaVersion: number(record, 'schemaVersion', 'schema_version'),
    scope: string(record, 'scope'),
    status,
    transactionId: string(record, 'transactionId', 'transaction_id'),
    ...(cause !== undefined && { cause }),
    ...(idempotencyKey !== undefined && { idempotencyKey }),
    ...(metadata !== undefined && { metadata }),
  };
};

const decodeHistoryRecord = (value: unknown): HistoryRecord => decodeReceipt(value);

const decodeChange = (value: unknown): WorkspaceChange => {
  const record = object(value, 'workspace change');
  const kind = string(record, 'kind');
  const entryKind = optionalString(record, 'entryKind', 'entry_kind') ?? 'file';
  if (!isChangeKind(kind)) {
    throw corrupt('Workspace change has an unsupported kind.');
  }
  if (!isEntryKind(entryKind)) {
    throw corrupt('Workspace change has an unsupported entry kind.');
  }
  const afterEtag = optionalString(record, 'afterEtag', 'after_etag');
  const afterHash = optionalString(record, 'afterHash', 'after_hash');
  const afterSize = optionalNumber(record, 'afterSize', 'after_size');
  const beforeEtag = optionalString(record, 'beforeEtag', 'before_etag');
  const beforeHash = optionalString(record, 'beforeHash', 'before_hash');
  const beforeSize = optionalNumber(record, 'beforeSize', 'before_size');
  const contentHash = optionalString(record, 'contentHash', 'content_hash');
  const etag = optionalString(record, 'etag');
  const moveFrom = optionalString(record, 'moveFrom', 'move_from', 'from');
  const moveTo = optionalString(record, 'moveTo', 'move_to', 'to');
  return {
    entryKind,
    kind,
    path: string(record, 'path'),
    ...(afterEtag !== undefined && { afterEtag }),
    ...(afterHash !== undefined && { afterHash }),
    ...(afterSize !== undefined && { afterSize }),
    ...(beforeEtag !== undefined && { beforeEtag }),
    ...(beforeHash !== undefined && { beforeHash }),
    ...(beforeSize !== undefined && { beforeSize }),
    ...(contentHash !== undefined && { contentHash }),
    ...(etag !== undefined && { etag }),
    ...(moveFrom !== undefined && { moveFrom }),
    ...(moveTo !== undefined && { moveTo }),
  };
};

const decodeDiffEntry = (value: unknown): RevisionDiffEntry => {
  const record = object(value, 'revision diff entry');
  const kind = string(record, 'kind');
  if (!isDiffKind(kind)) {
    throw corrupt('Revision diff entry has an unsupported kind.');
  }
  const afterHash = optionalString(record, 'afterHash', 'after_hash');
  const beforeHash = optionalString(record, 'beforeHash', 'before_hash');
  const moveFrom = optionalString(record, 'moveFrom', 'move_from');
  const moveTo = optionalString(record, 'moveTo', 'move_to');
  const preview = optionalString(record, 'preview');
  return {
    kind,
    path: string(record, 'path'),
    ...(afterHash !== undefined && { afterHash }),
    ...(beforeHash !== undefined && { beforeHash }),
    ...(moveFrom !== undefined && { moveFrom }),
    ...(moveTo !== undefined && { moveTo }),
    ...(preview !== undefined && { preview }),
  };
};

const isEntryKind = (value: string): value is WorkspaceEntryKind =>
  value === 'directory' || value === 'file' || value === 'symlink';

const isChangeKind = (value: string): value is WorkspaceChange['kind'] =>
  value === 'delete' || value === 'move' || value === 'upsert';

const isDiffKind = (value: string): value is RevisionDiffKind =>
  ['added', 'deleted', 'metadata', 'modified', 'moved', 'type-change', 'unavailable'].includes(
    value,
  );
