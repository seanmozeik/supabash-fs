import { asUnknownRecord } from '../api/json.js';

export const isStorageNotFound = (error: unknown): boolean => {
  const record = asUnknownRecord(error);
  if (record === undefined) {
    return false;
  }
  const statuses = [record['status'], record['statusCode']];
  return (
    statuses.some((status) => status === 404 || status === '404') || record['code'] === 'not_found'
  );
};
