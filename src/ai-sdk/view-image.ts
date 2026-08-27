import { jsonSchema, tool, type Tool } from 'ai';

import type { Workspace } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
import { normalizeVirtualPath } from '../core/path.js';
import { DEFAULT_MAX_IMAGE_BYTES } from './bounds.js';
import type { ViewImageResult } from './options.js';

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export const createViewImageTool = (
  workspace: Workspace,
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
): Tool =>
  tool({
    description:
      'Inspect an image file in the already-scoped workspace root. This tool cannot edit files, select a bucket, or access storage credentials.',
    execute: async ({ path }: { path: string }): Promise<ViewImageResult> => {
      const normalized = normalizeVirtualPath(path);
      const stat = await workspace.fs.lstat(normalized);
      if (stat.isSymbolicLink) {
        throw new SupabashError('UNSUPPORTED_CONTENT', 'Path is a symbolic link.', {
          path: normalized,
        });
      }
      if (!stat.isFile) {
        throw new SupabashError('UNSUPPORTED_CONTENT', 'Path is not an image file.', {
          path: normalized,
        });
      }
      if (stat.size > maxBytes) {
        throw new SupabashError('QUOTA_EXCEEDED', 'Image exceeds the byte limit.', {
          path: normalized,
        });
      }
      const body = await workspace.fs.readFileBuffer(normalized);
      if (body.byteLength > maxBytes) {
        throw new SupabashError('QUOTA_EXCEEDED', 'Image exceeds the byte limit.', {
          path: normalized,
        });
      }
      const mediaType = mediaTypeFor(normalized, body);
      return { data: bytesToBase64(body), mediaType, path: normalized };
    },
    inputSchema: jsonSchema<{ path: string }>({
      additionalProperties: false,
      properties: { path: { type: 'string' } },
      required: ['path'],
      type: 'object',
    }),
  });

const mediaTypeFor = (path: string, body: Uint8Array): string => {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const fromName = IMAGE_TYPES[extension];
  const fromBytes = sniffImageType(body);
  if (fromName === undefined || fromBytes === undefined || fromName !== fromBytes) {
    throw new SupabashError('UNSUPPORTED_CONTENT', 'File is not a supported image type.', { path });
  }
  return fromName;
};

const sniffImageType = (body: Uint8Array): string | undefined => {
  if (hasPrefix(body, [0x89, 0x50, 0x4e, 0x47])) {
    return 'image/png';
  }
  if (hasPrefix(body, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (hasPrefix(body, [0x47, 0x49, 0x46, 0x38])) {
    return 'image/gif';
  }
  if (
    hasPrefix(body, [0x52, 0x49, 0x46, 0x46]) &&
    body[8] === 0x57 &&
    body[9] === 0x45 &&
    body[10] === 0x42 &&
    body[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
};

const hasPrefix = (body: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((value, index) => body[index] === value);

const bytesToBase64 = (body: Uint8Array): string => {
  let binary = '';
  for (const byte of body) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
};
