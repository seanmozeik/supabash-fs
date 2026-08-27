import { describe, expect, test } from 'vitest';

import { isStorageNotFound } from '../../src/supabase/not-found.ts';

describe('storage not-found errors', () => {
  test('accepts the 404 shapes returned by Storage', () => {
    expect({
      code: isStorageNotFound({ code: 'not_found' }),
      missing: isStorageNotFound('missing'),
      other: isStorageNotFound({ status: 500 }),
      status: isStorageNotFound({ status: 404 }),
      statusCodeNumber: isStorageNotFound({ statusCode: 404 }),
      statusCodeString: isStorageNotFound({ statusCode: '404' }),
    }).toStrictEqual({
      code: true,
      missing: false,
      other: false,
      status: true,
      statusCodeNumber: true,
      statusCodeString: true,
    });
  });
});
