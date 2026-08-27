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
    if (!Number.isSafeInteger(maxPatchSize) || maxPatchSize < 0) {
      throw new SupabashError('QUOTA_EXCEEDED', 'Patch size limit must be a safe integer.');
    }
    for (const operation of operations) {
      const sizeError = patchSizeError(operation, maxPatchSize);
      if (sizeError !== undefined) {
        throw sizeError;
      }
      undos.push(await applyOne(workspace.fs, operation));
    }
    return { status: 'completed', output: completedOutput(operations) };
  } catch (error) {
    let rollbackError: unknown;
    if (mode === 'all-or-nothing') {
      try {
        await runUndos(undos);
      } catch (failure) {
        rollbackError = failure;
      }
    }
    const cause =
      rollbackError === undefined
        ? asPatchError(error)
        : new SupabashError('INVALID_PATCH', 'Patch failed and rollback did not finish.', {
            cause: new AggregateError(
              [error, rollbackError],
              'Patch execution and rollback both failed.',
            ),
          });
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
  const content = applyCreate(diff, normalized);
  const created = await missingParents(fs, normalized);
  const undo = undoCreate(fs, normalized, created);
  try {
    await fs.writeFile(normalized, content);
  } catch (error) {
    await rollbackMutation(undo, error);
  }
  return undo;
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
    const undo = undoWrite(fs, source, previous);
    try {
      await fs.writeFile(source, next);
    } catch (error) {
      await rollbackMutation(undo, error);
    }
    return undo;
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
  const created = await missingParents(fs, destination);
  const undo = undoMove(fs, source, destination, previous, created);
  try {
    await fs.writeFile(source, next);
    const deepestParent = created.at(-1);
    if (deepestParent !== undefined) {
      await fs.mkdir(deepestParent, { recursive: true });
    }
    await fs.mv(source, destination);
  } catch (error) {
    await rollbackMutation(undo, error);
  }
  return undo;
};

const deleteFile = async (fs: IFileSystem, path: string): Promise<Undo> => {
  const normalized = await existingFile(fs, path);
  const previous = await fs.readFileBuffer(normalized);
  const undo = undoDelete(fs, normalized, previous);
  try {
    await fs.rm(normalized);
  } catch (error) {
    await rollbackMutation(undo, error);
  }
  return undo;
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
  if (
    operation.type === 'delete_file' ||
    new TextEncoder().encode(operation.diff).byteLength <= maxPatchSize
  ) {
    return undefined;
  }
  return new SupabashError('QUOTA_EXCEEDED', 'Patch exceeds the size limit.', {
    path: operation.path,
  });
};

const rollbackMutation = async (undo: Undo, error: unknown): Promise<never> => {
  try {
    await undo();
  } catch (rollbackError) {
    throw new SupabashError('INVALID_PATCH', 'Patch mutation and rollback both failed.', {
      cause: new AggregateError(
        [error, rollbackError],
        'Patch mutation and local rollback both failed.',
      ),
    });
  }
  throw error;
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
