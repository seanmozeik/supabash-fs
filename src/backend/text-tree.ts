import { renderStoredDocument, type TextDocumentCodec } from '../api/document-codec.js';
import { SupabashError } from '../api/errors.js';
import type { ReadonlyWorkspaceView, RevisionEntry } from '../api/history.js';
import { normalizeVirtualPath } from '../core/path.js';
import { isRuntimeOwnedPath } from '../core/runtime-paths.js';
import type { RemoteEntry } from '../core/storage.js';
import { TrackedFileSystem } from '../core/tracked-file-system.js';
import { prepareUpload } from '../core/workspace-changes.js';
import type { BackendDocument, PinnedSnapshot } from './contracts.js';
import { loadDocument } from './document-loader.js';

export const TEXT_FILE_MODE = 0o644;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export const snapshotFromFileSystem = async (
  fs: TrackedFileSystem,
  documentCodec: TextDocumentCodec,
): Promise<PinnedSnapshot> => {
  const documents = [];
  for (const path of fs.getAllPaths().toSorted()) {
    if (!isRuntimeOwnedPath(path) && fs.kindOf(path) === 'file') {
      const content = decodeText(await fs.readFileBuffer(path), path);
      documents.push(await documentFromContent(path, content, documentCodec));
    }
  }
  return { documents, revision: null };
};

export interface TextTreeProjection {
  readonly filesystem: TrackedFileSystem;
  readonly replaceSnapshotBodies: (snapshot: PinnedSnapshot) => void;
}

export const projectSnapshot = async (
  snapshot: PinnedSnapshot,
  maxFileSystemBytes?: number,
): Promise<TextTreeProjection> => {
  let current = bodyLoader(snapshot);
  const filesystem = await TrackedFileSystem.create(
    entriesFrom(snapshot),
    (entry) => current(entry),
    maxFileSystemBytes,
  );
  return {
    filesystem,
    replaceSnapshotBodies(next) {
      current = bodyLoader(next);
    },
  };
};

export const entriesFrom = (snapshot: PinnedSnapshot): readonly RemoteEntry[] =>
  snapshot.documents
    .filter(({ path }) => !isRuntimeOwnedPath(path))
    .map((document) => ({
      contentHash: document.contentHash,
      kind: 'file',
      mode: TEXT_FILE_MODE,
      modifiedAt: snapshot.committedAt ?? new Date(0),
      path: document.path,
      size: document.byteSize,
      versionHash: document.contentHash,
    }));

export const bodyLoader = (
  snapshot: PinnedSnapshot,
): ((entry: RemoteEntry) => Promise<Uint8Array>) => {
  const entries = new Map(snapshot.documents.map((entry) => [entry.path, entry]));
  return async (remote) => {
    const entry = entries.get(remote.path);
    if (entry === undefined) {
      throw new SupabashError('HISTORY_CORRUPTION', 'Snapshot body is missing.', {
        path: remote.path,
      });
    }
    const document = await loadDocument(snapshot, entry);
    return textEncoder.encode(document.content);
  };
};

export const readonlyView = (snapshot: PinnedSnapshot, revision: string): ReadonlyWorkspaceView => {
  const readFile = (path: string): Promise<string> =>
    Promise.resolve().then(async () => {
      const normalized = normalizeVirtualPath(path);
      const document = snapshot.documents.find((candidate) => candidate.path === normalized);
      if (document === undefined) {
        throw new SupabashError('REVISION_NOT_FOUND', 'Revision file does not exist.', {
          path: normalized,
        });
      }
      const loaded = await loadDocument(snapshot, document);
      return loaded.content;
    });
  return {
    entries: entriesFrom(snapshot).map((entry): RevisionEntry => ({
      entryKind: 'file',
      mode: entry.mode,
      path: entry.path,
      size: entry.size,
      contentHash: requireHash(entry.contentHash, entry.path),
    })),
    readFile,
    readFileBuffer: async (path) => new TextEncoder().encode(await readFile(path)),
    revision,
  };
};

export const decodeText = (body: Uint8Array, path: string): string => {
  let text: string;
  try {
    text = textDecoder.decode(body);
  } catch (error) {
    throw new SupabashError('UNSUPPORTED_CONTENT', 'File is not valid UTF-8 text.', {
      cause: error,
      path,
    });
  }
  if (text.includes('\0')) {
    throw unsupported(path, 'Postgres text values cannot contain NUL.');
  }
  return text;
};

export const requireRevision = (snapshot: PinnedSnapshot): string => {
  if (snapshot.revision === null) {
    throw new SupabashError('REVISION_NOT_FOUND', 'Workspace has no committed revision yet.');
  }
  return snapshot.revision;
};

export const snapshotDetails = (
  snapshot: PinnedSnapshot,
): { readonly documentCount: number; readonly totalUtf8Bytes: number } => ({
  documentCount: snapshot.documents.length,
  totalUtf8Bytes: snapshot.documents.reduce((total, document) => total + document.byteSize, 0),
});

export const documentFromContent = async (
  path: string,
  content: string,
  documentCodec: TextDocumentCodec,
): Promise<BackendDocument> => {
  const parsed = documentCodec.parse(path, content);
  if (parsed.path !== path || parsed.body.includes('\0')) {
    throw unsupported(path, 'Document codec returned an invalid stored document.');
  }
  const canonical = renderStoredDocument(parsed);
  if (canonical.includes('\0')) {
    throw unsupported(path, 'Document codec returned invalid UTF-8 text content.');
  }
  const bodyBytes = textEncoder.encode(parsed.body);
  const contentBytes = textEncoder.encode(canonical);
  const [bodyUpload, contentUpload] = await Promise.all([
    prepareUpload({
      body: bodyBytes,
      kind: 'file',
      mode: TEXT_FILE_MODE,
      modifiedAt: new Date(0),
      path,
    }),
    prepareUpload({
      body: contentBytes,
      kind: 'file',
      mode: TEXT_FILE_MODE,
      modifiedAt: new Date(0),
      path,
    }),
  ]);
  return {
    body: parsed.body,
    bodyByteSize: bodyBytes.byteLength,
    bodyHash: requireHash(bodyUpload.contentHash, path),
    byteSize: contentBytes.byteLength,
    content: canonical,
    contentHash: requireHash(contentUpload.contentHash, path),
    metadata: parsed.metadata,
    path,
  };
};

export const unsupported = (path: string, message: string): SupabashError =>
  new SupabashError('UNSUPPORTED_CONTENT', message, { path });

export const requireHash = (hash: string | undefined, path: string): string => {
  if (hash === undefined) {
    throw new SupabashError('STORAGE', 'Prepared text file has no content hash.', { path });
  }
  return hash;
};
