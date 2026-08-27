import { sha256 } from '../core/hash.js';
import { createStorageWorkspace } from '../core/workspace.js';
import { authenticate } from '../supabase/auth.js';
import { createSupabaseStorage } from '../supabase/storage.js';
import type { Workspace } from './contracts.js';
import type { SupabashOptions } from './options.js';

export { SupabashError } from './errors.js';

const open = async (options: SupabashOptions): Promise<Workspace> => {
  const { client, userId } = await authenticate(options);
  const storage = createSupabaseStorage(client, options.bucket, userId);
  const scope = await sha256(new TextEncoder().encode(userId));
  return createStorageWorkspace(storage, {
    scope,
    ...(options.coordinator !== undefined && { coordinator: options.coordinator }),
    ...(options.limits !== undefined && { limits: options.limits }),
    ...(options.maxFileSystemBytes !== undefined && {
      maxFileSystemBytes: options.maxFileSystemBytes,
    }),
    ...(options.uploadConcurrency !== undefined && {
      uploadConcurrency: options.uploadConcurrency,
    }),
  });
};

export const Supabash = Object.freeze({ open });
