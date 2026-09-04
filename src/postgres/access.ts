import {
  isDelegatedOperation,
  WORKSPACE_ID_PATTERN,
  type DelegatedOperation,
  type PostgresDelegatedCapabilityClaims,
} from '../api/capability.js';
import { SupabashError } from '../api/errors.js';
import { asUnknownRecord } from '../api/json.js';

export interface DelegatedDatabaseGrant {
  readonly actorSubject: string;
  readonly correlationId: string;
  readonly delegatedGrant: string;
  readonly expiresAt: Date;
  readonly operations: readonly DelegatedOperation[];
  readonly workspace: string;
}

export const decodeCreatedWorkspace = (value: unknown): string => {
  const record = asUnknownRecord(value);
  const workspace = record?.['workspace'] ?? record?.['workspaceId'] ?? record?.['id'];
  if (typeof workspace !== 'string') {
    throw invalidResponse('Workspace creation returned no identifier.');
  }
  assertPostgresWorkspaceIdentifier(workspace);
  return workspace;
};

/**
 * Decodes the grant that the database minted after it verified the capability.
 * `claims` are the unverified claims the delegate presented. They are compared
 * only so that a swapped or stale response cannot widen the grant.
 */
export const decodeDelegatedGrant = (
  value: unknown,
  claims: PostgresDelegatedCapabilityClaims,
): DelegatedDatabaseGrant => {
  const record = asUnknownRecord(value);
  if (record === undefined) {
    throw invalidCapability('Capability exchange did not return an object.');
  }
  const actorSubject = stringField(record, 'actorSubject');
  const delegatedGrant = stringField(record, 'delegatedGrant');
  const correlationId = stringField(record, 'correlationId');
  const workspace = stringField(record, 'workspace');
  const expiresAt = dateField(record, 'expiresAt');
  const operations = operationsField(record['operations']);
  if (
    actorSubject !== claims.sub ||
    workspace !== claims.workspace ||
    correlationId !== claims.corr ||
    Math.floor(expiresAt.getTime() / 1000) !== claims.exp ||
    !sameOperations(operations, claims.ops)
  ) {
    throw invalidCapability('Capability exchange result does not match the presented capability.');
  }
  return { actorSubject, correlationId, delegatedGrant, expiresAt, operations, workspace };
};

export const assertPostgresWorkspaceIdentifier = (workspace: string): void => {
  if (!WORKSPACE_ID_PATTERN.test(workspace)) {
    throw new SupabashError('INVALID_PATH', 'Workspace must be one canonical identifier.');
  }
};

const operationsField = (value: unknown): readonly DelegatedOperation[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidCapability('Capability exchange returned no operations.');
  }
  const operations: DelegatedOperation[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !isDelegatedOperation(entry)) {
      throw invalidCapability('Capability exchange returned an unsupported operation.');
    }
    operations.push(entry);
  }
  if (new Set(operations).size !== operations.length) {
    throw invalidCapability('Capability exchange returned duplicate operations.');
  }
  return operations;
};

const sameOperations = (
  left: readonly DelegatedOperation[],
  right: readonly DelegatedOperation[],
): boolean => {
  const sortedLeft = left.toSorted();
  const sortedRight = right.toSorted();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((operation, index) => operation === sortedRight[index])
  );
};

const stringField = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidCapability(`Capability exchange field '${key}' is invalid.`);
  }
  return value;
};

const dateField = (record: Record<string, unknown>, key: string): Date => {
  const value = stringField(record, key);
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw invalidCapability(`Capability exchange field '${key}' is not a date.`);
  }
  return result;
};

const invalidCapability = (message: string): SupabashError =>
  new SupabashError('INVALID_CAPABILITY', message);

const invalidResponse = (message: string): SupabashError =>
  new SupabashError('HISTORY_CORRUPTION', message);
