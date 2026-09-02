import { createClient } from '@supabase/supabase-js';

import type { DelegatedOperation } from '../api/capability.js';
import { SupabashError } from '../api/errors.js';
import type {
  CreatePostgresWorkspaceOptions,
  DelegatedPostgresWorkspace,
  OpenPostgresDelegatedOptions,
  PostgresWorkspace,
  PostgresWorkspaceOptions,
} from '../api/postgres.js';
import { createBackendWorkspace } from '../backend/workspace.js';
import { guardDelegatedPostgresWorkspace } from '../capability/guard.js';
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
    ...(options.documentCodec !== undefined && { documentCodec: options.documentCodec }),
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
  return callPostgresRpc(
    client,
    'supabash_create_workspace',
    decodeCreatedWorkspace,
    {},
    { outcomeUnknownOnTransportFailure: true },
  );
};

export const openPostgresDelegated = async (
  options: OpenPostgresDelegatedOptions,
): Promise<DelegatedPostgresWorkspace> => {
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
  assertExpectedOperations(claims.ops, options.expectedOperations);

  const client = createClient(options.supabaseUrl, options.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    ...(options.fetch !== undefined && { global: { fetch: options.fetch } }),
  });
  const grant = await callPostgresRpc(
    client,
    'supabash_exchange_capability',
    (value) => decodeDelegatedGrant(value, claims),
    { p_capability: options.capability },
    { outcomeUnknownOnTransportFailure: true },
  );
  const backend = createPostgresBackend({
    client,
    delegatedGrant: grant.delegatedGrant,
    workspace: claims.workspace,
    ...(options.documentCodec !== undefined && { documentCodec: options.documentCodec }),
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
  const actor = `delegated:${claims.sub}`;
  const operations = Object.freeze([...claims.ops]);
  return guardDelegatedPostgresWorkspace(
    workspace,
    new Set(operations),
    actor,
    claims.corr,
    Object.freeze({
      actor,
      correlationId: claims.corr,
      operations,
      subject: claims.sub,
      workspace: claims.workspace,
    }),
  );
};

const assertExpectedOperations = (
  actual: readonly DelegatedOperation[],
  expected: OpenPostgresDelegatedOptions['expectedOperations'],
): void => {
  if (expected === undefined) {
    return;
  }
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (
    actualSet.size !== actual.length ||
    expectedSet.size !== expected.length ||
    actualSet.size !== expectedSet.size ||
    [...actualSet].some((operation) => !expectedSet.has(operation))
  ) {
    throw new SupabashError(
      'INVALID_CAPABILITY',
      'Capability operations do not match the operations required by the caller.',
    );
  }
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
