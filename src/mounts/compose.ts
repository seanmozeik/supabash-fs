import { InMemoryFs, MountableFs } from 'just-bash/browser';

import { SupabashError } from '../api/errors.js';
import { restrictFileSystem } from '../capability/readonly-fs.js';
import { createWorkspaceFileSystemView } from '../core/filesystem-view.js';
import { isSameOrDescendant, normalizeVirtualPath } from '../core/path.js';
import type { FileSystemMount, MountedFileSystem, MountDescriptor } from './contracts.js';
import { guardMountedFileSystem } from './guard.js';

/** Compose already-authorized sources. This view has no commit, restore, or purge API. */
export const createMountedFileSystem = (mounts: readonly FileSystemMount[]): MountedFileSystem => {
  const descriptors: MountDescriptor[] = [];
  const sources = mounts.map((mount) => {
    const mountPoint = normalizeVirtualPath(mount.mountPoint);
    if (
      mountPoint !== mount.mountPoint ||
      mountPoint === '/' ||
      isSameOrDescendant(mountPoint, '/dev') ||
      isSameOrDescendant('/dev', mountPoint) ||
      descriptors.some(
        (existing) =>
          isSameOrDescendant(mountPoint, existing.mountPoint) ||
          isSameOrDescendant(existing.mountPoint, mountPoint),
      )
    ) {
      throw new SupabashError(
        'INVALID_PATH',
        'Mount points must be canonical, disjoint, and outside /dev.',
        { path: mount.mountPoint },
      );
    }
    const sourceId = mount.access === 'read-only' ? mount.snapshot.sourceId : mount.sourceId;
    if (sourceId.trim().length === 0 || sourceId.length > 1024) {
      throw new SupabashError(
        'INVALID_PATH',
        'Mount source identity must be a bounded identifier.',
      );
    }
    const root = normalizeVirtualPath(mount.view?.root ?? '/');
    const hiddenRoots = Object.freeze(
      [
        ...new Set((mount.view?.hiddenRoots ?? []).map((path) => normalizeVirtualPath(path))),
      ].toSorted(),
    );
    if (hiddenRoots.includes('/')) {
      throw new SupabashError('INVALID_PATH', 'A mount cannot hide its entire root.');
    }
    const descriptor: MountDescriptor = Object.freeze({
      hiddenRoots,
      mountPoint,
      root,
      sourceId,
      ...(mount.access === 'read-only'
        ? { access: mount.access, digest: mount.snapshot.digest, revision: mount.snapshot.revision }
        : { access: mount.access }),
    });
    descriptors.push(descriptor);
    const inner = mount.access === 'read-only' ? mount.snapshot.fs : mount.workspace.fs;
    const fs = createWorkspaceFileSystemView(inner, { hiddenRoots, root });
    return { descriptor, fs: mount.access === 'read-only' ? restrictFileSystem(fs, 'read') : fs };
  });
  const base = new InMemoryFs({ '/dev/null': '' });
  const composed = new MountableFs({
    base,
    mounts: sources.map(({ descriptor, fs }) => ({
      filesystem: fs,
      mountPoint: descriptor.mountPoint,
    })),
  });
  const locate = (path: string) =>
    sources.find(({ descriptor }) => isSameOrDescendant(path, descriptor.mountPoint));
  const required = (path: string) => {
    const source = locate(normalizeVirtualPath(path));
    if (source === undefined) {
      throw new SupabashError('INVALID_PATH', 'Path is outside the configured mounts.', { path });
    }
    return source;
  };
  return Object.freeze({
    fs: guardMountedFileSystem(composed, (path) => locate(path)?.descriptor),
    mounts: Object.freeze(descriptors),
    toSourcePath: (path: string) => {
      const { descriptor, fs } = required(path);
      const relative = fs.resolvePath(
        '/',
        normalizeVirtualPath(path).slice(descriptor.mountPoint.length) || '/',
      );
      return Object.freeze({
        mountPoint: descriptor.mountPoint,
        sourceId: descriptor.sourceId,
        path:
          relative === '/dev/null'
            ? relative
            : normalizeVirtualPath(`${descriptor.root}/${relative}`),
      });
    },
    toVirtualPath: (mountPoint: string, sourcePath: string) => {
      const { descriptor, fs } = required(mountPoint);
      if (
        mountPoint !== descriptor.mountPoint ||
        (normalizeVirtualPath(sourcePath) !== '/dev/null' &&
          !isSameOrDescendant(sourcePath, descriptor.root))
      ) {
        throw new SupabashError('INVALID_PATH', 'Stored path is outside the selected mount.');
      }
      const path = normalizeVirtualPath(sourcePath);
      const relative = fs.resolvePath(
        '/',
        descriptor.root === '/' || path === '/dev/null'
          ? path
          : path.slice(descriptor.root.length) || '/',
      );
      return normalizeVirtualPath(`${mountPoint}/${relative}`);
    },
  });
};
