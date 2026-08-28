import { createClient } from '@supabase/supabase-js';

import { SupabashError } from '../api/errors.js';
import type {
  CreatePostgresWorkspaceOptions,
  OpenPostgresDelegatedOptions,
  PostgresWorkspace,
  PostgresWorkspaceOptions,
} from '../api/postgres.js';
import { createBackendWorkspace } from '../backend/workspace.js';
import { guardWorkspaceWithCapabilities } from '../capability/guard.js';
import {
  consumeDelegatedCapabilityNonce,
  verifyDelegatedCapabilityClaims,
} from '../capability/verify.js';
import { authenticate } from '../supabase/auth.js';
import { jwtRole } from '../supabase/jwt.js';
import { decodeCreatedWorkspace, decodeDelegatedGrant } from './access.js';
import { createPostgresBackend } from './backend.js';
import { callPostgresRpc } from './rpc.js';

export const openPostgres = async (
  options: PostgresWorkspaceOptions,
): Promise<PostgresWorkspace> => {
  const { client } = await authenticate(options);
  const backend = createPostgresBackend({
    client,
    workspace: options.workspace,
    ...(options.observability !== undefined && { observability: options.observability }),
  });
  return createBackendWorkspace(backend, {
    ...(options.limits !== undefined && { limits: options.limits }),
    ...(options.maxFileSystemBytes !== undefined && {
      maxFileSystemBytes: options.maxFileSystemBytes,
    }),
    ...(options.observability !== undefined && { observability: options.observability }),
  });
};

export const createPostgresWorkspace = async (
  options: CreatePostgresWorkspaceOptions,
): Promise<string> => {
  const { client } = await authenticate(options);
  return callPostgresRpc(client, 'supabash_create_workspace', decodeCreatedWorkspace);
};

export const openPostgresDelegated = async (
  options: OpenPostgresDelegatedOptions,
): Promise<PostgresWorkspace> => {
  assertServiceRoleKey(options.serviceRoleKey);
  const claims = await verifyDelegatedCapabilityClaims({
    capability: options.capability,
    verifier: options.verifier,
  });
  if (!('backend' in claims)) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability backend is not Postgres.');
  }
  if (claims.origin !== options.supabaseUrl) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability origin does not match open options.');
  }
  if (!claims.ops.includes('read')) {
    throw new SupabashError(
      'INVALID_CAPABILITY',
      'A delegated Postgres workspace open requires the read operation.',
    );
  }

  const client = createClient(options.supabaseUrl, options.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    ...(options.fetch !== undefined && { global: { fetch: options.fetch } }),
  });
  const grant = await callPostgresRpc(
    client,
    'supabash_exchange_capability',
    (value) => decodeDelegatedGrant(value, claims),
    { p_capability: options.capability },
  );
  const backend = createPostgresBackend({
    client,
    delegatedGrant: grant.delegatedGrant,
    workspace: claims.workspace,
    ...(options.observability !== undefined && { observability: options.observability }),
  });
  const workspace = await createBackendWorkspace(backend, {
    ...(options.limits !== undefined && { limits: options.limits }),
    ...(options.maxFileSystemBytes !== undefined && {
      maxFileSystemBytes: options.maxFileSystemBytes,
    }),
    ...(options.observability !== undefined && { observability: options.observability }),
  });
  await consumeDelegatedCapabilityNonce(claims, options.verifier);
  return guardWorkspaceWithCapabilities(
    workspace,
    new Set(claims.ops),
    `delegated:${claims.sub}`,
    claims.corr,
  );
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
