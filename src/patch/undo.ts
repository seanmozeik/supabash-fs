import type { IFileSystem } from 'just-bash/browser';

import { parentPaths } from '../core/path.js';

export type Undo = () => Promise<void>;

export const undoCreate =
  (fs: IFileSystem, path: string, createdParents: readonly string[]): Undo =>
  async () => {
    if (await fs.exists(path)) {
      await fs.rm(path);
    }
    for (const parent of [...createdParents].toReversed()) {
      const names = await fs.readdir(parent);
      if (names.length === 0) {
        await fs.rm(parent);
      }
    }
  };

export const undoWrite =
  (fs: IFileSystem, path: string, previous: Uint8Array): Undo =>
  async () => {
    await fs.writeFile(path, previous);
  };

export const undoMove =
  (
    fs: IFileSystem,
    source: string,
    destination: string,
    previous: Uint8Array,
    createdParents: readonly string[] = [],
  ): Undo =>
  async () => {
    if (await fs.exists(destination)) {
      await fs.rm(destination);
    }
    await fs.writeFile(source, previous);
    for (const parent of [...createdParents].toReversed()) {
      const exists = await fs.exists(parent);
      const names = exists ? await fs.readdir(parent) : undefined;
      if (names?.length === 0) {
        await fs.rm(parent);
      }
    }
  };

export const undoDelete =
  (fs: IFileSystem, path: string, previous: Uint8Array): Undo =>
  async () => {
    await fs.writeFile(path, previous);
  };

export const missingParents = async (fs: IFileSystem, path: string): Promise<readonly string[]> => {
  const missing: string[] = [];
  for (const parent of parentPaths(path)) {
    if (!(await fs.exists(parent))) {
      missing.push(parent);
    }
  }
  return missing;
};

export const runUndos = async (undos: readonly Undo[]): Promise<void> => {
  const failures: unknown[] = [];
  for (const undo of [...undos].toReversed()) {
    try {
      await undo();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more patch rollback operations failed.');
  }
};
