import { createStorageWorkspace } from '../core/workspace.js';
import { authenticate } from '../supabase/auth.js';
import { createSupabaseStorage } from '../supabase/storage.js';
import type { Workspace } from './contracts.js';
import type { SupabashOptions } from './options.js';

export { SupabashError } from './errors.js';

const open = async (options: SupabashOptions): Promise<Workspace> => {
  const { client, userId } = await authenticate(options);
  const storage = createSupabaseStorage(client, options.bucket, userId);
  return createStorageWorkspace(storage, {
    ...(options.maxFileSystemBytes !== undefined && {
      maxFileSystemBytes: options.maxFileSystemBytes,
    }),
    ...(options.uploadConcurrency !== undefined && {
      uploadConcurrency: options.uploadConcurrency,
    }),
  });
};

export const Supabash = Object.freeze({ open });
