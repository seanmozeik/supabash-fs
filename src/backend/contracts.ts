import type { CommitContext } from '../api/commit.js';
import type { CommitReceipt, WorkspaceCapabilities, WorkspaceChange } from '../api/contracts.js';
import type { DocumentMetadata, TextDocumentCodec } from '../api/document-codec.js';
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

export interface BackendDocument {
  readonly body: string;
  readonly bodyByteSize: number;
  readonly bodyHash: string;
  readonly byteSize: number;
  readonly content: string;
  readonly contentHash: string;
  readonly metadata: DocumentMetadata;
  readonly path: string;
}

export interface PinnedSnapshot {
  readonly committedAt?: Date;
  readonly documents: readonly BackendDocument[];
  readonly revision: string | null;
  readonly transactionId?: string;
}

export type BackendMutation =
  | {
      readonly body: string;
      readonly bodyByteSize: number;
      readonly bodyHash: string;
      readonly byteSize: number;
      readonly contentHash: string;
      readonly kind: 'upsert';
      readonly metadata: DocumentMetadata;
      readonly path: string;
    }
  | { readonly kind: 'delete'; readonly path: string }
  | {
      readonly body?: string;
      readonly bodyByteSize?: number;
      readonly bodyHash?: string;
      readonly byteSize?: number;
      readonly contentHash?: string;
      readonly from: string;
      readonly kind: 'move';
      readonly metadata?: DocumentMetadata;
      readonly path: string;
    };

export interface BackendCommitInput {
  readonly changes: readonly WorkspaceChange[];
  readonly context: CommitContext;
  readonly expectedRevision: string | null;
  readonly fingerprint: string;
  readonly mutations: readonly BackendMutation[];
  readonly restoreSourceRevision?: string;
  readonly transactionId: string;
}

export interface BackendCommitResult {
  readonly receipt: CommitReceipt;
  readonly replayed: boolean;
}

export interface WorkspaceBackend {
  readonly capabilities: WorkspaceCapabilities;
  readonly documentCodec: TextDocumentCodec;
  readonly checkpoint: (options: CheckpointOptions) => Promise<CheckpointReceipt>;
  readonly checkpoints: () => Promise<readonly CheckpointRecord[]>;
  readonly commit: (input: BackendCommitInput) => Promise<BackendCommitResult>;
  readonly deleteCheckpoint: (checkpointId: string) => Promise<void>;
  readonly diff: (input: RevisionDiffInput, staged: PinnedSnapshot) => Promise<RevisionDiff>;
  readonly history: (query?: HistoryQuery) => Promise<HistoryPage>;
  readonly loadRevision: (revision: string) => Promise<PinnedSnapshot>;
  readonly loadSnapshot: () => Promise<PinnedSnapshot>;
  readonly purge: (options: PurgeOptions) => Promise<PurgeReceipt>;
}
