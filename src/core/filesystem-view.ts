import type { IFileSystem } from 'just-bash/browser';

import { SupabashError } from '../api/errors.js';
import { parentVirtualPath } from './path.js';

const NULL_DEVICE = '/dev/null';
const denyLinks = (): Promise<never> =>
  Promise.reject(
    new SupabashError('POLICY_DENIED', 'Links are not available through a workspace view.'),
  );

export interface WorkspaceFileSystemViewOptions {
  /** A workspace directory presented to tools as their filesystem root. */
  readonly root?: string;
  /** Paths relative to the presented root that tools cannot see or address. */
  readonly hiddenRoots?: readonly string[];
}

export const createWorkspaceFileSystemView = (
  inner: IFileSystem,
  options: WorkspaceFileSystemViewOptions = {},
): IFileSystem => {
  const root = inner.resolvePath('/', options.root ?? '/');
  const hiddenRoots = Object.freeze(
    [...new Set(options.hiddenRoots)]
      .map((path) => viewPath(inner, '/', path))
      .filter((path) => path !== '/')
      .map((path) => toInnerPath(inner, root, path))
      .toSorted(),
  );

  const visibleActualPath = (path: string): boolean =>
    (path === NULL_DEVICE || inside(path, root)) &&
    !hiddenRoots.some((hidden) => inside(path, hidden));
  const assertVisibleActualPath = (path: string): void => {
    if (!visibleActualPath(path)) {
      throw denied(path);
    }
  };
  const checked = (path: string): string => {
    const actual = toInnerPath(inner, root, viewPath(inner, '/', path));
    assertVisibleActualPath(actual);
    return actual;
  };
  const checkedForAccess = async (path: string): Promise<string> => {
    const actual = checked(path);
    if (actual === NULL_DEVICE) {
      return actual;
    }
    let candidate = actual;
    for (;;) {
      if (await inner.exists(candidate)) {
        assertVisibleActualPath(await inner.realpath(candidate));
        return actual;
      }
      if (candidate === root || candidate === '/') {
        return actual;
      }
      candidate = parentVirtualPath(candidate);
    }
  };
  const mapFromInner = (path: string): string => {
    const normalized = inner.resolvePath('/', path);
    assertVisibleActualPath(normalized);
    if (normalized === NULL_DEVICE) {
      return normalized;
    }
    if (root === '/') {
      return normalized;
    }
    return normalized === root ? '/' : normalized.slice(root.length);
  };
  const resolvePath = (base: string, path: string): string => {
    const resolved = viewPath(inner, base, path);
    assertVisibleActualPath(toInnerPath(inner, root, resolved));
    return resolved;
  };
  const fs: IFileSystem = {
    appendFile: async (path, content, writeOptions) =>
      inner.appendFile(await checkedForAccess(path), content, writeOptions),
    chmod: async (path, mode) => inner.chmod(await checkedForAccess(path), mode),
    cp: async (source, destination, copyOptions) =>
      inner.cp(await checkedForAccess(source), await checkedForAccess(destination), copyOptions),
    exists: async (path) => {
      try {
        return await inner.exists(await checkedForAccess(path));
      } catch (error) {
        if (error instanceof SupabashError && error.code === 'POLICY_DENIED') {
          return false;
        }
        throw error;
      }
    },
    getAllPaths: () =>
      inner
        .getAllPaths()
        .filter((path) => visibleActualPath(path))
        .map((path) => mapFromInner(path))
        .toSorted(),
    link: denyLinks,
    lstat: async (path) => inner.lstat(await checkedForAccess(path)),
    mkdir: async (path, mkdirOptions) => inner.mkdir(await checkedForAccess(path), mkdirOptions),
    mv: async (source, destination) =>
      inner.mv(await checkedForAccess(source), await checkedForAccess(destination)),
    readFile: async (path, readOptions) =>
      inner.readFile(await checkedForAccess(path), readOptions),
    readFileBuffer: async (path) => inner.readFileBuffer(await checkedForAccess(path)),
    readdir: async (path) => {
      const actual = await checkedForAccess(path);
      const entries = await inner.readdir(actual);
      return entries.filter((entry) => visibleActualPath(inner.resolvePath(actual, entry)));
    },
    readlink: denyLinks,
    realpath: async (path) => mapFromInner(await inner.realpath(await checkedForAccess(path))),
    resolvePath,
    rm: async (path, removeOptions) => inner.rm(await checkedForAccess(path), removeOptions),
    stat: async (path) => inner.stat(await checkedForAccess(path)),
    symlink: denyLinks,
    utimes: async (path, atime, mtime) => inner.utimes(await checkedForAccess(path), atime, mtime),
    writeFile: async (path, content, writeOptions) =>
      inner.writeFile(await checkedForAccess(path), content, writeOptions),
  };
  const readFileBytes = inner.readFileBytes?.bind(inner);
  if (readFileBytes !== undefined) {
    fs.readFileBytes = async (path) => readFileBytes(await checkedForAccess(path));
  }
  const readdirWithFileTypes = inner.readdirWithFileTypes?.bind(inner);
  if (readdirWithFileTypes !== undefined) {
    fs.readdirWithFileTypes = async (path) => {
      const actual = await checkedForAccess(path);
      const entries = await readdirWithFileTypes(actual);
      return entries.filter((entry) => visibleActualPath(inner.resolvePath(actual, entry.name)));
    };
  }
  return Object.freeze(fs);
};

const viewPath = (inner: IFileSystem, base: string, path: string): string => {
  const resolved = inner.resolvePath(base, path);
  return resolved === NULL_DEVICE ? resolved : inner.resolvePath('/', resolved);
};

const toInnerPath = (inner: IFileSystem, root: string, path: string): string => {
  if (path === NULL_DEVICE) {
    return path;
  }
  if (root === '/') {
    return inner.resolvePath('/', path);
  }
  return inner.resolvePath('/', path === '/' ? root : `${root}${path}`);
};

const inside = (candidate: string, root: string): boolean =>
  candidate === root || candidate.startsWith(`${root === '/' ? '' : root}/`);

const denied = (path: string): SupabashError =>
  new SupabashError('POLICY_DENIED', 'Tool path is outside the workspace view.', { path });
