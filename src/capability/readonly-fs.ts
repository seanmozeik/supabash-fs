import type { FsStat, IFileSystem } from 'just-bash/browser';

import { SupabashError } from '../api/errors.js';

export type FileSystemAccess = 'none' | 'read' | 'write';

export const restrictFileSystem = (inner: IFileSystem, access: FileSystemAccess): IFileSystem => {
  if (access === 'write') {
    return inner;
  }
  const deny = (): Promise<never> => Promise.reject(denied(access));
  const denySync = (): never => {
    throw denied(access);
  };
  const readable = access === 'read';
  const fs: IFileSystem = {
    appendFile: deny,
    chmod: deny,
    cp: deny,
    exists: readable ? inner.exists.bind(inner) : deny,
    getAllPaths: readable ? inner.getAllPaths.bind(inner) : denySync,
    link: deny,
    lstat: readable ? async (path) => detachedStat(await inner.lstat(path)) : deny,
    mkdir: deny,
    mv: deny,
    readFile: readable ? inner.readFile.bind(inner) : deny,
    readFileBuffer: readable
      ? async (path) => {
          const buffer = await inner.readFileBuffer(path);
          return new Uint8Array(buffer);
        }
      : deny,
    readdir: readable ? inner.readdir.bind(inner) : deny,
    readlink: readable ? inner.readlink.bind(inner) : deny,
    realpath: readable ? inner.realpath.bind(inner) : deny,
    resolvePath: readable ? inner.resolvePath.bind(inner) : denySync,
    rm: deny,
    stat: readable ? async (path) => detachedStat(await inner.stat(path)) : deny,
    symlink: deny,
    utimes: deny,
    writeFile: deny,
  };
  if (readable && inner.readFileBytes !== undefined) {
    fs.readFileBytes = inner.readFileBytes.bind(inner);
  }
  if (readable && inner.readdirWithFileTypes !== undefined) {
    fs.readdirWithFileTypes = inner.readdirWithFileTypes.bind(inner);
  }
  return fs;
};

const detachedStat = (stat: FsStat): FsStat => ({ ...stat, mtime: new Date(stat.mtime) });

const denied = (access: FileSystemAccess): SupabashError =>
  new SupabashError(
    'AUTHORIZATION',
    access === 'none'
      ? 'Delegated capability does not allow filesystem access.'
      : 'Delegated capability does not allow filesystem writes.',
  );
