import { SupabashError } from '../api/errors.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const decodeUtf8 = (body: Uint8Array, path: string): string => {
  try {
    return decoder.decode(body);
  } catch (cause) {
    throw new SupabashError('UNSUPPORTED_CONTENT', 'File is not UTF-8 text.', { cause, path });
  }
};
