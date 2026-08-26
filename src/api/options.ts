export interface SupabashOptions {
  readonly bucket: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxFileSystemBytes?: number;
  readonly publishableKey: string;
  readonly request: Request;
  readonly supabaseUrl: string;
  readonly uploadConcurrency?: number;
}
