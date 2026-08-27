import type { IFileSystem } from 'just-bash/browser';

import type { Workspace } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
import { normalizeVirtualPath } from '../core/path.js';
import { applyDiff } from './apply-diff.js';
import {
  DEFAULT_MAX_PATCH_SIZE,
  type ApplyPatchOperation,
  type ApplyPatchOptions,
  type ApplyPatchResult,
} from './operations.js';
import {
  missingParents,
  runUndos,
  undoCreate,
  undoDelete,
  undoMove,
  undoWrite,
  type Undo,
} from './undo.js';
import { decodeUtf8 } from './utf8.js';

type PatchWorkspace = Pick<Workspace, 'fs'>;

export const applyPatch = (
  workspace: PatchWorkspace,
  operation: ApplyPatchOperation,
  options: ApplyPatchOptions = {},
): Promise<ApplyPatchResult> => applyPatchOperations(workspace, [operation], options);

export const applyPatchOperations = async (
  workspace: PatchWorkspace,
  operations: readonly ApplyPatchOperation[],
  options: ApplyPatchOptions = {},
): Promise<ApplyPatchResult> => {
  const maxPatchSize = options.maxPatchSize ?? DEFAULT_MAX_PATCH_SIZE;
  const mode = options.mode ?? 'all-or-nothing';
  const undos: Undo[] = [];

  try {
    for (const operation of operations) {
      const sizeError = patchSizeError(operation, maxPatchSize);
      if (sizeError !== undefined) {
        throw sizeError;
      }
      undos.push(await applyOne(workspace.fs, operation));
    }
    return { status: 'completed', output: completedOutput(operations) };
  } catch (error) {
    if (mode === 'all-or-nothing') {
      await runUndos(undos);
    }
    const cause = asPatchError(error);
    return { cause, output: cause.message, status: 'failed' };
  }
};

const applyOne = (fs: IFileSystem, operation: ApplyPatchOperation): Promise<Undo> => {
  if (operation.type === 'create_file') {
    return createFile(fs, operation.path, operation.diff);
  }
  if (operation.type === 'delete_file') {
    return deleteFile(fs, operation.path);
  }
  return updateFile(fs, operation.path, operation.diff, operation.moveTo);
};

const createFile = async (fs: IFileSystem, path: string, diff: string): Promise<Undo> => {
  const normalized = normalizeVirtualPath(path);
  if (await fs.exists(normalized)) {
    throw new SupabashError('INVALID_PATCH', 'Path already exists.', { path: normalized });
  }
  const created = await missingParents(fs, normalized);
  await fs.writeFile(normalized, applyCreate(diff, normalized));
  return undoCreate(fs, normalized, created);
};

const updateFile = async (
  fs: IFileSystem,
  path: string,
  diff: string,
  moveTo: string | undefined,
): Promise<Undo> => {
  const source = await existingFile(fs, path);
  const previous = await fs.readFileBuffer(source);
  const next = applyUpdate(decodeUtf8(previous, source), diff, source);
  if (moveTo === undefined) {
    await fs.writeFile(source, next);
    return undoWrite(fs, source, previous);
  }
  const destination = normalizeVirtualPath(moveTo);
  if (destination === source) {
    await fs.writeFile(source, next);
    return undoWrite(fs, source, previous);
  }
  if (await fs.exists(destination)) {
    throw new SupabashError('INVALID_PATCH', 'Destination path already exists.', {
      path: destination,
    });
  }
  await fs.writeFile(destination, next);
  await fs.rm(source);
  return undoMove(fs, source, destination, previous);
};

const deleteFile = async (fs: IFileSystem, path: string): Promise<Undo> => {
  const normalized = await existingFile(fs, path);
  const previous = await fs.readFileBuffer(normalized);
  await fs.rm(normalized);
  return undoDelete(fs, normalized, previous);
};

const existingFile = async (fs: IFileSystem, path: string): Promise<string> => {
  const normalized = normalizeVirtualPath(path);
  if (!(await fs.exists(normalized))) {
    throw new SupabashError('INVALID_PATCH', 'Path does not exist.', { path: normalized });
  }
  const stat = await fs.lstat(normalized);
  if (stat.isDirectory) {
    throw new SupabashError('INVALID_PATCH', 'Path is a directory.', { path: normalized });
  }
  if (stat.isSymbolicLink) {
    throw new SupabashError('UNSUPPORTED_CONTENT', 'Path is a symbolic link.', {
      path: normalized,
    });
  }
  return normalized;
};

const applyCreate = (diff: string, path: string): string => {
  try {
    return applyDiff('', diff, 'create');
  } catch (cause) {
    throw invalidPatch(path, cause);
  }
};

const applyUpdate = (input: string, diff: string, path: string): string => {
  try {
    return applyDiff(input, diff, 'default');
  } catch (cause) {
    throw invalidPatch(path, cause);
  }
};

const invalidPatch = (path: string, cause: unknown): SupabashError =>
  new SupabashError('INVALID_PATCH', 'Patch could not be applied.', { cause, path });

const patchSizeError = (
  operation: ApplyPatchOperation,
  maxPatchSize: number,
): SupabashError | undefined => {
  if (operation.type === 'delete_file' || operation.diff.length <= maxPatchSize) {
    return undefined;
  }
  return new SupabashError('QUOTA_EXCEEDED', 'Patch exceeds the size limit.', {
    path: operation.path,
  });
};

const completedOutput = (operations: readonly ApplyPatchOperation[]): string => {
  const [operation] = operations;
  if (operations.length === 1 && operation !== undefined) {
    return `OK ${operation.type} ${normalizeVirtualPath(operation.path)}`;
  }
  return `OK ${String(operations.length)} operations`;
};

const asPatchError = (error: unknown): SupabashError =>
  error instanceof SupabashError
    ? error
    : new SupabashError('INVALID_PATCH', 'Patch could not be applied.', { cause: error });
