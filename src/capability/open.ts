import { createClient } from '@supabase/supabase-js';

import type { OpenDelegatedOptions } from '../api/capability.js';
import type { Workspace } from '../api/contracts.js';
import { SupabashError } from '../api/errors.js';
import { sha256 } from '../core/hash.js';
import { createStorageWorkspace } from '../core/workspace.js';
import { jwtRole } from '../supabase/jwt.js';
import { createSupabaseStorage } from '../supabase/storage.js';
import { guardWorkspace } from './guard.js';
import { consumeDelegatedCapabilityNonce, verifyDelegatedCapabilityClaims } from './verify.js';

export const openDelegated = async (options: OpenDelegatedOptions): Promise<Workspace> => {
  assertServiceRoleKey(options.serviceRoleKey);
  const claims = await verifyDelegatedCapabilityClaims({
    capability: options.capability,
    verifier: options.verifier,
  });
  if (claims.bucket !== options.bucket) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability bucket does not match open options.');
  }
  if (claims.origin !== options.supabaseUrl) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability origin does not match open options.');
  }
  const client = createClient(options.supabaseUrl, options.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    ...(options.fetch !== undefined && { global: { fetch: options.fetch } }),
  });
  const storage = createSupabaseStorage(client, options.bucket, claims.prefix);
  const scope = await sha256(new TextEncoder().encode(claims.prefix));
  const workspace = await createStorageWorkspace(storage, {
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
  await consumeDelegatedCapabilityNonce(claims, options.verifier);
  return guardWorkspace(workspace, new Set(claims.ops), `delegated:${claims.sub}`, claims.corr);
};

const assertServiceRoleKey = (key: string): void => {
  if (key.startsWith('sb_secret_') || jwtRole(key) === 'service_role') {
    return;
  }
  throw new SupabashError(
    'AUTHORIZATION',
    'Delegated access requires a trusted service-role credential.',
  );
};
