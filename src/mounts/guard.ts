import type { IFileSystem } from 'just-bash/browser';

import { SupabashError } from '../api/errors.js';
import { createWorkspaceFileSystemView } from '../core/filesystem-view.js';
import { normalizeVirtualPath } from '../core/path.js';
import type { MountDescriptor } from './contracts.js';

export const guardMountedFileSystem = (
  inner: IFileSystem,
  locate: (path: string) => MountDescriptor | undefined,
): IFileSystem => {
  // Reuse the canonical path and realpath checks, and deny links on both sides of a mount.
  const view = createWorkspaceFileSystemView(inner);
  const writable = (path: string): MountDescriptor => {
    const normalized = normalizeVirtualPath(path);
    const mount = locate(normalized);
    if (mount?.access !== 'read-write' || normalized === mount.mountPoint) {
      throw new SupabashError(
        'POLICY_DENIED',
        'Path is outside a writable mount or is a mount boundary.',
        { path },
      );
    }
    return mount;
  };
  return Object.freeze({
    ...view,
    appendFile: async (path, content, options) => {
      if (normalizeVirtualPath(path) === '/dev/null') {
        return;
      }
      writable(path);
      await view.appendFile(path, content, options);
    },
    chmod: async (path, mode) => {
      writable(path);
      await view.chmod(path, mode);
    },
    cp: async (source, destination, options) => {
      writable(destination);
      if (locate(normalizeVirtualPath(source)) === undefined) {
        throw new SupabashError('POLICY_DENIED', 'Copy source must be inside one mount.', {
          path: source,
        });
      }
      await view.cp(source, destination, options);
    },
    mkdir: async (path, options) => {
      writable(path);
      await view.mkdir(path, options);
    },
    mv: async (source, destination) => {
      const from = writable(source);
      const to = writable(destination);
      if (from !== to) {
        throw new SupabashError(
          'POLICY_DENIED',
          'Moves across mounts are not atomic; copy explicitly instead.',
        );
      }
      await view.mv(source, destination);
    },
    rm: async (path, options) => {
      writable(path);
      await view.rm(path, options);
    },
    utimes: async (path, atime, mtime) => {
      writable(path);
      await view.utimes(path, atime, mtime);
    },
    writeFile: async (path, content, options) => {
      if (normalizeVirtualPath(path) === '/dev/null') {
        return;
      }
      writable(path);
      await view.writeFile(path, content, options);
    },
  } satisfies IFileSystem);
};
