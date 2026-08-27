import { SupabashError } from '../api/errors.js';
import { asUnknownRecord } from '../api/json.js';

export const parseHistoryObject = (input: unknown): Record<string, unknown> => {
  const record = asUnknownRecord(input);
  if (record === undefined) {
    throw new SupabashError('HISTORY_CORRUPTION', 'History record is not an object.');
  }
  return record;
};

export const requiredString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new SupabashError('HISTORY_CORRUPTION', `History record is missing '${key}'.`);
  }
  return value;
};

export const optionalString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new SupabashError(
      'HISTORY_CORRUPTION',
      `History record field '${key}' must be a string.`,
    );
  }
  return value;
};

export const nullableString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new SupabashError(
      'HISTORY_CORRUPTION',
      `History record field '${key}' must be a string.`,
    );
  }
  return value;
};

export const requiredNumber = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SupabashError('HISTORY_CORRUPTION', `History record is missing '${key}'.`);
  }
  return value;
};
