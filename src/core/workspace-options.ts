import { SupabashError } from '../api/errors.js';
import type { WorkspaceLimits } from '../history/limits.js';
import { assertWorkspaceLimits } from '../history/quota.js';

interface WorkspaceConfiguration {
  readonly limits?: WorkspaceLimits;
  readonly maxFileSystemBytes?: number;
  readonly uploadConcurrency?: number;
}

export const validateWorkspaceConfiguration = (options: WorkspaceConfiguration): void => {
  assertWorkspaceLimits(options.limits ?? {});
  if (
    options.maxFileSystemBytes !== undefined &&
    (!Number.isSafeInteger(options.maxFileSystemBytes) || options.maxFileSystemBytes < 0)
  ) {
    throw quota('maxFileSystemBytes must be a non-negative safe integer.');
  }
  if (
    options.uploadConcurrency !== undefined &&
    (!Number.isSafeInteger(options.uploadConcurrency) || options.uploadConcurrency < 1)
  ) {
    throw quota('uploadConcurrency must be a positive safe integer.');
  }
};

const quota = (message: string): SupabashError => new SupabashError('QUOTA_EXCEEDED', message);
