import { readFile } from 'node:fs/promises';

export const edgeDnsPinTypes = {
  name: 'edge-dns-pin-types',
  load(id: string): Promise<string> | null {
    if (id.endsWith('/just-bash/dist/network/dns-pin.d.ts')) {
      return readFile(new URL('edge-dns-pin.d.ts', import.meta.url), 'utf8');
    }
    return null;
  },
};
