import { SupabashError } from '../api/errors.js';

export const jwtRole = (token: string): string | undefined => {
  const [, payload] = token.split('.');
  if (payload === undefined) {
    return undefined;
  }
  try {
    const decoded: unknown = JSON.parse(decodeBase64Url(payload));
    return isRecord(decoded) && typeof decoded['role'] === 'string' ? decoded['role'] : undefined;
  } catch {
    return undefined;
  }
};

export const decodeBase64Url = (value: string): string => {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return atob(padded);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Delegated access needs a trusted service-role credential, never a user token. */
export const assertServiceRoleKey = (key: string): void => {
  if (key.startsWith('sb_secret_') || jwtRole(key) === 'service_role') {
    return;
  }
  throw new SupabashError(
    'AUTHORIZATION',
    'Delegated access requires a trusted service-role credential.',
  );
};
