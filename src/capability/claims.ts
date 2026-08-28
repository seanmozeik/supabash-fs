import {
  CAPABILITY_SCHEMA_VERSION,
  POSTGRES_CAPABILITY_SCHEMA_VERSION,
  type AnyDelegatedCapabilityClaims,
  type DelegatedOperation,
} from '../api/capability.js';
import { SupabashError } from '../api/errors.js';
import { asUnknownRecord } from '../api/json.js';

const SAFE_BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const SAFE_PREFIX = /^[A-Za-z0-9_-]{1,128}(?:\/[A-Za-z0-9_-]{1,128})*$/u;

export const parseClaims = (value: unknown): AnyDelegatedCapabilityClaims => {
  const record = asObject(value);
  const ops = parseOps(record['ops']);
  if (record['backend'] === 'postgres') {
    const schemaVersion = requiredNumber(record, 'sv');
    if (schemaVersion !== POSTGRES_CAPABILITY_SCHEMA_VERSION) {
      throw invalid('Capability schema version is not supported.');
    }
    return {
      aud: requiredString(record, 'aud'),
      backend: 'postgres',
      corr: requiredString(record, 'corr'),
      exp: requiredNumber(record, 'exp'),
      iat: requiredNumber(record, 'iat'),
      iss: requiredString(record, 'iss'),
      nonce: requiredString(record, 'nonce'),
      ops,
      origin: requiredString(record, 'origin'),
      sub: requiredString(record, 'sub'),
      sv: schemaVersion,
      workspace: requiredString(record, 'workspace'),
    };
  }
  return {
    aud: requiredString(record, 'aud'),
    bucket: requiredString(record, 'bucket'),
    corr: requiredString(record, 'corr'),
    exp: requiredNumber(record, 'exp'),
    iat: requiredNumber(record, 'iat'),
    iss: requiredString(record, 'iss'),
    nonce: requiredString(record, 'nonce'),
    ops,
    origin: requiredString(record, 'origin'),
    prefix: requiredString(record, 'prefix'),
    sub: requiredString(record, 'sub'),
    sv: requiredNumber(record, 'sv'),
  };
};

export const assertClaimSchema = (claims: AnyDelegatedCapabilityClaims): void => {
  if ('backend' in claims) {
    if (!SAFE_WORKSPACE.test(claims.workspace)) {
      throw invalid('Capability workspace is not a safe identifier.');
    }
    return;
  }
  if (!SAFE_BUCKET.test(claims.bucket)) {
    throw invalid('Capability bucket is not a safe storage identifier.');
  }
  if (!SAFE_PREFIX.test(claims.prefix)) {
    throw invalid('Capability prefix is not a safe storage path.');
  }
  if (claims.sv !== CAPABILITY_SCHEMA_VERSION) {
    throw invalid('Capability schema version is not supported.');
  }
};

const SAFE_WORKSPACE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const parseOps = (value: unknown): readonly DelegatedOperation[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid('Capability operations must be a non-empty array.');
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || !isOperation(entry)) {
      throw invalid('Capability contains an unsupported operation.');
    }
    return entry;
  });
};

const isOperation = (value: string): value is DelegatedOperation => {
  switch (value) {
    case 'checkpoint':
    case 'commit':
    case 'history':
    case 'purge':
    case 'read':
    case 'restore':
    case 'write': {
      return true;
    }
    default: {
      return false;
    }
  }
};

const asObject = (value: unknown): Record<string, unknown> => {
  const record = asUnknownRecord(value);
  if (record === undefined) {
    throw invalid('Capability payload is not an object.');
  }
  return record;
};

const requiredString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`Capability is missing '${key}'.`);
  }
  return value;
};

const requiredNumber = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalid(`Capability is missing '${key}'.`);
  }
  return value;
};

const invalid = (message: string): SupabashError =>
  new SupabashError('INVALID_CAPABILITY', message);
