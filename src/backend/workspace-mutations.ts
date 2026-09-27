import type { WorkspaceChange } from '../api/contracts.js';
import type { TextDocumentCodec } from '../api/document-codec.js';
import { comparePaths } from '../core/entry-order.js';
import type { PendingChanges, UploadEntry } from '../core/storage.js';
import type { TrackedFileSystem } from '../core/tracked-file-system.js';
import { prepareUpload, previewWorkspaceChanges } from '../core/workspace-changes.js';
import type { BackendDocument, BackendMutation } from './contracts.js';
import { persistentPending } from './pending.js';
import { decodeText, documentFromContent, TEXT_FILE_MODE, unsupported } from './text-tree.js';

interface PreparedChanges {
  readonly documents: ReadonlyMap<string, BackendDocument>;
  readonly uploads: readonly UploadEntry[];
}

export const prepareChanges = async (
  fs: TrackedFileSystem,
  pending: PendingChanges,
  documentCodec: TextDocumentCodec,
): Promise<PreparedChanges> => {
  const uploads: UploadEntry[] = [];
  const documents = new Map<string, BackendDocument>();
  for (const path of pending.upserts) {
    const draft = await fs.uploadEntry(path);
    if (draft.kind === 'directory') {
      throw unsupported(path, 'Empty directories are not durable in a UTF-8 text tree.');
    }
    if (draft.kind === 'symlink') {
      throw unsupported(path, 'Symbolic links are not supported by the UTF-8 text backend.');
    }
    if (draft.mode !== TEXT_FILE_MODE) {
      throw unsupported(path, 'File modes are not supported by the UTF-8 text backend.');
    }
    const content = decodeText(draft.body ?? new Uint8Array(), path);
    const document = await documentFromContent(path, content, documentCodec);
    const canonicalBody = new TextEncoder().encode(document.content);
    const upload = await prepareUpload({ ...draft, body: canonicalBody });
    uploads.push(upload);
    documents.set(path, document);
  }
  return { documents, uploads };
};

export const mutationsFrom = (
  fs: TrackedFileSystem,
  pending: PendingChanges,
  prepared: PreparedChanges,
): readonly BackendMutation[] => {
  const movedFrom = new Set(pending.moves.map(({ from }) => from));
  const movedTo = new Set(pending.moves.map(({ to }) => to));
  return [
    ...pending.moves.map(({ from, to }): BackendMutation => {
      const document = prepared.documents.get(to);
      const changed =
        document !== undefined && document.contentHash !== fs.baselineEntry(from)?.contentHash;
      return {
        from,
        kind: 'move',
        path: to,
        ...(changed && {
          body: document.body,
          bodyByteSize: document.bodyByteSize,
          bodyHash: document.bodyHash,
          byteSize: document.byteSize,
          contentHash: document.contentHash,
          metadata: document.metadata,
        }),
      };
    }),
    ...pending.deletions
      .filter(({ path }) => !movedFrom.has(path))
      .map(({ path }) => ({ kind: 'delete' as const, path })),
    ...[...prepared.documents.values()]
      .filter(({ path }) => !movedTo.has(path))
      .map(({ body, bodyByteSize, bodyHash, byteSize, contentHash, metadata, path }) => ({
        body,
        bodyByteSize,
        bodyHash,
        byteSize,
        contentHash,
        kind: 'upsert' as const,
        metadata,
        path,
      })),
  ].toSorted((left, right) => comparePaths(left.path, right.path));
};

export const publicChanges = (fs: TrackedFileSystem): readonly WorkspaceChange[] =>
  previewWorkspaceChanges(persistentPending(fs), (path) => fs.kindOf(path));
