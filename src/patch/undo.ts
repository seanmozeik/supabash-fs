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
  (fs: IFileSystem, source: string, destination: string, previous: Uint8Array): Undo =>
  async () => {
    if (await fs.exists(destination)) {
      await fs.rm(destination);
    }
    await fs.writeFile(source, previous);
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
  for (const undo of [...undos].toReversed()) {
    await undo();
  }
};
