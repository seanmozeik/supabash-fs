import { SupabashError } from '../api/errors.js';
import { asUnknownRecord, isJsonRecord, type JsonValue } from '../api/json.js';

export const decodeObject = (value: unknown, label: string): Record<string, unknown> => {
  const record = asUnknownRecord(value);
  if (record === undefined) {
    throw corrupt(`Postgres ${label} is not an object.`);
  }
  return record;
};

export const arrayField = (
  record: Record<string, unknown>,
  ...keys: readonly string[]
): readonly unknown[] => {
  const value = decodeValueAt(record, ...keys);
  if (!Array.isArray(value)) {
    throw corrupt(`Postgres field '${keys[0] ?? 'unknown'}' is not an array.`);
  }
  return value;
};

export const stringField = (record: Record<string, unknown>, ...keys: readonly string[]): string =>
  primitiveString(decodeValueAt(record, ...keys), keys[0] ?? 'unknown');

export const textField = (record: Record<string, unknown>, ...keys: readonly string[]): string => {
  const value = decodeValueAt(record, ...keys);
  if (typeof value !== 'string') {
    throw corrupt(`Postgres field '${keys[0] ?? 'unknown'}' is not a string.`);
  }
  return value;
};

export const primitiveString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw corrupt(`Postgres field '${label}' is not a non-empty string.`);
  }
  return value;
};

export const optionalString = (
  record: Record<string, unknown>,
  ...keys: readonly string[]
): string | undefined => {
  const value = decodeValueAt(record, ...keys);
  return value === undefined || value === null
    ? undefined
    : primitiveString(value, keys[0] ?? 'unknown');
};

export const nullableString = (
  record: Record<string, unknown>,
  ...keys: readonly string[]
): string | null => {
  const value = decodeValueAt(record, ...keys);
  return value === undefined || value === null
    ? null
    : primitiveString(value, keys[0] ?? 'unknown');
};

export const numberField = (
  record: Record<string, unknown>,
  ...keys: readonly string[]
): number => {
  const value = decodeValueAt(record, ...keys);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw corrupt(`Postgres field '${keys[0] ?? 'unknown'}' is not a safe non-negative integer.`);
  }
  return value;
};

export const optionalNumber = (
  record: Record<string, unknown>,
  ...keys: readonly string[]
): number | undefined => {
  const value = decodeValueAt(record, ...keys);
  return value === undefined || value === null ? undefined : numberField({ value }, 'value');
};

export const booleanField = (
  record: Record<string, unknown>,
  ...keys: readonly string[]
): boolean => {
  const value = decodeValueAt(record, ...keys);
  if (typeof value !== 'boolean') {
    throw corrupt(`Postgres field '${keys[0] ?? 'unknown'}' is not boolean.`);
  }
  return value;
};

export const optionalBoolean = (
  record: Record<string, unknown>,
  ...keys: readonly string[]
): boolean | undefined => {
  const value = decodeValueAt(record, ...keys);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw corrupt(`Postgres field '${keys[0] ?? 'unknown'}' is not boolean.`);
  }
  return value;
};

export const optionalJsonObject = (
  record: Record<string, unknown>,
  ...keys: readonly string[]
): Readonly<Record<string, JsonValue>> | undefined => {
  const value = decodeValueAt(record, ...keys);
  const result = asUnknownRecord(value);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (result === undefined || !isJsonRecord(result)) {
    throw corrupt(`Postgres field '${keys[0] ?? 'unknown'}' is not JSON metadata.`);
  }
  return result;
};

export const decodeValueAt = (
  record: Record<string, unknown>,
  ...keys: readonly string[]
): JsonValue | undefined => {
  for (const key of keys) {
    if (key in record) {
      return decodeJsonValue(record[key], key);
    }
  }
  return undefined;
};

const decodeJsonValue = (value: unknown, label: string): JsonValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => decodeJsonValue(entry, label));
  }
  const record = asUnknownRecord(value);
  if (record !== undefined && isJsonRecord(record)) {
    return record;
  }
  throw corrupt(`Postgres field '${label}' is not valid JSON.`);
};

export const dateField = (value: string, label: string): Date => {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw corrupt(`Postgres ${label} is not a valid date.`);
  }
  return result;
};

export const corrupt = (message: string, path?: string): SupabashError =>
  new SupabashError('HISTORY_CORRUPTION', message, path === undefined ? {} : { path });
