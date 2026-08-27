import type { IFileSystem } from 'just-bash/browser';

import { SupabashError } from '../api/errors.js';

export const readOnlyFileSystem = (inner: IFileSystem): IFileSystem => {
  const deny = (): Promise<never> => Promise.reject(readOnly());
  const fs: IFileSystem = {
    appendFile: deny,
    chmod: deny,
    cp: deny,
    exists: inner.exists.bind(inner),
    getAllPaths: inner.getAllPaths.bind(inner),
    link: deny,
    lstat: inner.lstat.bind(inner),
    mkdir: deny,
    mv: deny,
    readFile: inner.readFile.bind(inner),
    readFileBuffer: inner.readFileBuffer.bind(inner),
    readdir: inner.readdir.bind(inner),
    readlink: inner.readlink.bind(inner),
    realpath: inner.realpath.bind(inner),
    resolvePath: inner.resolvePath.bind(inner),
    rm: deny,
    stat: inner.stat.bind(inner),
    symlink: deny,
    utimes: deny,
    writeFile: deny,
  };
  if (inner.readFileBytes !== undefined) {
    fs.readFileBytes = inner.readFileBytes.bind(inner);
  }
  if (inner.readdirWithFileTypes !== undefined) {
    fs.readdirWithFileTypes = inner.readdirWithFileTypes.bind(inner);
  }
  return fs;
};

const readOnly = (): SupabashError =>
  new SupabashError('AUTHORIZATION', 'Delegated capability does not allow filesystem writes.');
