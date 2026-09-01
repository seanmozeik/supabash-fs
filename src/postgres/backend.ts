import { plainTextDocumentCodec, type TextDocumentCodec } from '../api/document-codec.js';
import { SupabashError } from '../api/errors.js';
import type {
  CheckpointOptions,
  CheckpointReceipt,
  CheckpointRecord,
  HistoryPage,
  HistoryQuery,
  PurgeOptions,
  PurgeReceipt,
  RevisionDiff,
  RevisionDiffInput,
} from '../api/history.js';
import { asUnknownRecord, isJsonRecord, type JsonValue } from '../api/json.js';
import type { WorkspaceObservability, WorkspaceOperation } from '../api/observability.js';
import { POSTGRES_WORKSPACE_CAPABILITIES } from '../api/postgres.js';
import type {
  BackendCommitInput,
  BackendCommitResult,
  PinnedSnapshot,
  WorkspaceBackend,
} from '../backend/contracts.js';
import { startOperation } from '../core/observability.js';
import { assertPostgresWorkspaceIdentifier } from './access.js';
import {
  decodeCheckpoint,
  decodeCheckpoints,
  decodeCommitResult,
  decodeDiff,
  decodeHistoryPage,
  decodePurge,
  decodeSnapshot,
} from './decode.js';
import { callPostgresRpc, type PostgresRpcClient } from './rpc.js';

const RPC = Object.freeze({
  checkpoint: 'supabash_checkpoint',
  checkpoints: 'supabash_checkpoints',
  commit: 'supabash_commit',
  deleteCheckpoint: 'supabash_delete_checkpoint',
  diff: 'supabash_diff',
  history: 'supabash_history',
  loadRevision: 'supabash_load_revision',
  loadWorkspace: 'supabash_load_workspace',
  purge: 'supabash_purge',
});

export interface PostgresBackendOptions {
  readonly client: PostgresRpcClient;
  readonly delegatedGrant?: string;
  readonly documentCodec?: TextDocumentCodec;
  readonly observability?: WorkspaceObservability;
  readonly workspace: string;
}

export const createPostgresBackend = (options: PostgresBackendOptions): WorkspaceBackend => {
  assertPostgresWorkspaceIdentifier(options.workspace);
  return new PostgresBackend(options);
};

class PostgresBackend implements WorkspaceBackend {
  readonly capabilities = POSTGRES_WORKSPACE_CAPABILITIES;
  readonly documentCodec: TextDocumentCodec;
  private readonly client: PostgresRpcClient;
  private readonly delegatedGrant: string | undefined;
  private readonly observability: WorkspaceObservability | undefined;
  private readonly workspace: string;

  constructor(options: PostgresBackendOptions) {
    this.client = options.client;
    this.documentCodec = options.documentCodec ?? plainTextDocumentCodec;
    this.delegatedGrant = options.delegatedGrant;
    this.workspace = options.workspace;
    this.observability = options.observability;
  }

  checkpoint(options: CheckpointOptions): Promise<CheckpointReceipt> {
    return this.call(
      RPC.checkpoint,
      {
        p_idempotency_key: options.idempotencyKey ?? null,
        p_label: options.label ?? null,
        p_retention_class: options.retentionClass ?? null,
        p_workspace_id: this.workspace,
      },
      'checkpoint',
      decodeCheckpoint,
    );
  }

  checkpoints(): Promise<readonly CheckpointRecord[]> {
    return this.call(
      RPC.checkpoints,
      { p_workspace_id: this.workspace },
      'checkpoint-list',
      decodeCheckpoints,
    );
  }

  commit(input: BackendCommitInput): Promise<BackendCommitResult> {
    const args = {
      p_actor: input.context.actor,
      p_base_revision: input.expectedRevision,
      p_cause: input.context.cause ?? null,
      p_changes: input.mutations,
      p_correlation_id: input.context.correlationId,
      p_fingerprint: input.fingerprint,
      p_idempotency_key: input.context.idempotencyKey ?? null,
      p_metadata: input.context.metadata ?? {},
      p_receipt_changes: input.changes,
      p_source_revision: input.restoreSourceRevision ?? null,
      p_transaction_id: input.transactionId,
      p_workspace_id: this.workspace,
    };
    return this.call(RPC.commit, args, 'commit', decodeCommitResult, {
      changeCount: input.mutations.length,
      serializedPayloadBytes: serializedBytes(args),
      totalUtf8Bytes: input.mutations.reduce(
        (total, change) => total + (change.kind === 'upsert' ? change.byteSize : 0),
        0,
      ),
    });
  }

  deleteCheckpoint(checkpointId: string): Promise<void> {
    return this.call(
      RPC.deleteCheckpoint,
      { p_checkpoint_id: checkpointId, p_workspace_id: this.workspace },
      'checkpoint-delete',
      decodeVoid,
    );
  }

  diff(input: RevisionDiffInput, staged: PinnedSnapshot): Promise<RevisionDiff> {
    const args = {
      p_from: input.from,
      p_paths: input.paths ?? null,
      p_preview_bytes: input.previewBytes ?? null,
      p_staged_documents: staged.documents,
      p_to: input.to,
      p_workspace_id: this.workspace,
    };
    return this.call(RPC.diff, args, 'diff', decodeDiff, {
      documentCount: staged.documents.length,
      serializedPayloadBytes: serializedBytes(args),
      totalUtf8Bytes: totalBytes(staged),
    });
  }

  history(query?: HistoryQuery): Promise<HistoryPage> {
    return this.call(
      RPC.history,
      {
        p_cursor: query?.cursor ?? null,
        p_limit: query?.limit ?? null,
        p_workspace_id: this.workspace,
      },
      'history',
      decodeHistoryPage,
    );
  }

  loadRevision(revision: string): Promise<PinnedSnapshot> {
    return this.call(
      RPC.loadRevision,
      { p_revision_id: revision, p_workspace_id: this.workspace },
      'revision-load',
      decodeSnapshot,
    );
  }

  loadSnapshot(): Promise<PinnedSnapshot> {
    return this.call(
      RPC.loadWorkspace,
      { p_workspace_id: this.workspace },
      'snapshot-load',
      decodeSnapshot,
    );
  }

  purge(options: PurgeOptions): Promise<PurgeReceipt> {
    return this.call(
      RPC.purge,
      {
        p_dry_run: options.dryRun ?? false,
        p_max_age_ms: options.maxAgeMs ?? null,
        p_max_revisions: options.maxRevisions ?? null,
        p_workspace_id: this.workspace,
      },
      'purge',
      decodePurge,
    );
  }

  private async call<T>(
    name: string,
    args: unknown,
    operation: WorkspaceOperation,
    decode: (value: unknown) => T,
    details: {
      readonly changeCount?: number;
      readonly documentCount?: number;
      readonly serializedPayloadBytes?: number;
      readonly totalUtf8Bytes?: number;
    } = {},
  ): Promise<T> {
    const timer = startOperation(this.observability, 'postgres', operation);
    const parsedArguments = rpcArguments(args);
    const requestArguments =
      this.delegatedGrant === undefined
        ? parsedArguments
        : { ...parsedArguments, p_delegated_grant: this.delegatedGrant };
    try {
      const result = await callPostgresRpc(this.client, name, decode, requestArguments);
      const replayed = isReplayed(result);
      timer.success({
        serializedPayloadBytes: serializedBytes(requestArguments),
        ...details,
        ...resultDetails(result),
        ...(replayed !== undefined && { replayed }),
      });
      return result;
    } catch (error) {
      timer.failure(error, details);
      throw error;
    }
  }
}

const serializedBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const totalBytes = (snapshot: PinnedSnapshot): number =>
  snapshot.documents.reduce((total, document) => total + document.byteSize, 0);

const isReplayed = (value: unknown): boolean | undefined => {
  if (typeof value !== 'object' || value === null || !('replayed' in value)) {
    return undefined;
  }
  return typeof value.replayed === 'boolean' ? value.replayed : undefined;
};

const resultDetails = (
  value: unknown,
): { readonly documentCount?: number; readonly totalUtf8Bytes?: number } => {
  const record = asUnknownRecord(value);
  const documents = record?.['documents'];
  if (!Array.isArray(documents)) {
    return {};
  }
  const sizes = documents.map((entry) => asUnknownRecord(entry)?.['byteSize']);
  if (!sizes.every((size) => typeof size === 'number' && Number.isSafeInteger(size) && size >= 0)) {
    return { documentCount: documents.length };
  }
  return {
    documentCount: documents.length,
    totalUtf8Bytes: sizes.reduce<number>((total, size) => total + Number(size), 0),
  };
};

const decodeVoid = (value: unknown): void => {
  if (value !== undefined && value !== null) {
    throw new SupabashError('HISTORY_CORRUPTION', 'Postgres delete returned an invalid response.');
  }
};

const rpcArguments = (value: unknown): Readonly<Record<string, JsonValue>> => {
  if (!isJsonRecord(value)) {
    throw new SupabashError('STORAGE', 'Postgres RPC arguments are not valid JSON.');
  }
  return value;
};
