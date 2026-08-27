export interface HistoryBlobStore {
  readonly get: (key: string) => Promise<Uint8Array | undefined>;
  readonly list: (prefix: string) => Promise<readonly string[]>;
  readonly put: (key: string, body: Uint8Array) => Promise<void>;
  readonly remove: (keys: readonly string[]) => Promise<void>;
}
