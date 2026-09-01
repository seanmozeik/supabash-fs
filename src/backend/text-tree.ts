import type { CommitReceipt } from '../api/contracts.js';
import type { TextDocumentCodec } from '../api/document-codec.js';
import { SupabashError } from '../api/errors.js';
import type { ReadonlyWorkspaceView, RevisionEntry } from '../api/history.js';
import { normalizeVirtualPath } from '../core/path.js';
import { isRuntimeOwnedPath } from '../core/runtime-paths.js';
import type { RemoteEntry } from '../core/storage.js';
import { TrackedFileSystem } from '../core/tracked-file-system.js';
import { prepareUpload } from '../core/workspace-changes.js';
import type { BackendDocument, PinnedSnapshot } from './contracts.js';

export const TEXT_FILE_MODE = 0o644;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export const snapshotFromFileSystem = async (
  fs: TrackedFileSystem,
  documentCodec: TextDocumentCodec,
  receipt?: CommitReceipt,
): Promise<PinnedSnapshot> => {
  const documents = [];
  for (const path of fs.getAllPaths().toSorted()) {
    if (!isRuntimeOwnedPath(path) && fs.kindOf(path) === 'file') {
      const content = decodeText(await fs.readFileBuffer(path), path);
      documents.push(await documentFromContent(path, content, documentCodec));
    }
  }
  return {
    documents,
    revision: receipt?.revision ?? null,
    ...(receipt !== undefined && {
      committedAt: receipt.committedAt,
      transactionId: receipt.transactionId,
    }),
  };
};

export interface TextTreeProjection {
  readonly filesystem: TrackedFileSystem;
  readonly replaceSnapshotBodies: (snapshot: PinnedSnapshot) => void;
}

export const projectSnapshot = async (
  snapshot: PinnedSnapshot,
  maxFileSystemBytes?: number,
): Promise<TextTreeProjection> => {
  const bodies = snapshotBodyMap(snapshot);
  const filesystem = await TrackedFileSystem.create(
    entriesFrom(snapshot),
    loadSnapshotBody(bodies),
    maxFileSystemBytes,
  );
  return {
    filesystem,
    replaceSnapshotBodies(next) {
      bodies.clear();
      for (const [path, body] of snapshotBodyMap(next)) {
        bodies.set(path, body);
      }
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
  const bodies = snapshotBodyMap(snapshot);
  return loadSnapshotBody(bodies);
};

const snapshotBodyMap = (snapshot: PinnedSnapshot): Map<string, Uint8Array> =>
  new Map(snapshot.documents.map(({ content, path }) => [path, textEncoder.encode(content)]));

const loadSnapshotBody = (
  bodies: ReadonlyMap<string, Uint8Array>,
): ((entry: RemoteEntry) => Promise<Uint8Array>) => {
  return (entry: RemoteEntry): Promise<Uint8Array> => {
    const body = bodies.get(entry.path);
    if (body === undefined) {
      throw new SupabashError('HISTORY_CORRUPTION', 'Snapshot body is missing.', {
        path: entry.path,
      });
    }
    return Promise.resolve(body);
  };
};

export const readonlyView = (
  snapshot: PinnedSnapshot,
  revision: string,
): ReadonlyWorkspaceView => ({
  entries: entriesFrom(snapshot).map((entry): RevisionEntry => ({
    entryKind: 'file',
    mode: entry.mode,
    path: entry.path,
    size: entry.size,
    contentHash: requireHash(entry.contentHash, entry.path),
  })),
  readFile: (path) =>
    Promise.resolve().then(() => {
      const normalized = normalizeVirtualPath(path);
      const document = snapshot.documents.find((candidate) => candidate.path === normalized);
      if (document === undefined) {
        throw new SupabashError('REVISION_NOT_FOUND', 'Revision file does not exist.', {
          path: normalized,
        });
      }
      return document.content;
    }),
  revision,
});

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
  const canonical = documentCodec.render(parsed);
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
