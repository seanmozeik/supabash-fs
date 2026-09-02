import type { CommitContext } from '../api/commit.js';

export interface PendingCommitAttempt {
  readonly context: CommitContext;
  readonly fingerprint: string;
  readonly transactionId: string;
}

export const commitAttempt = (
  previous: PendingCommitAttempt | undefined,
  context: CommitContext,
  fingerprint: string,
): PendingCommitAttempt =>
  previous?.fingerprint === fingerprint
    ? previous
    : { context, fingerprint, transactionId: crypto.randomUUID() };
