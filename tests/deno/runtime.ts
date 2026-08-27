import { Supabash, type Workspace } from '@seanmozeik/supabash-fs';

export interface DenoRuntime {
  readonly env: { readonly get: (name: string) => string | undefined };
  readonly stdout: { readonly write: (data: Uint8Array) => Promise<number> | number };
  readonly version: { readonly deno: string };
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isDenoRuntime = (value: unknown): value is DenoRuntime =>
  isRecord(value) &&
  isRecord(value['env']) &&
  typeof value['env']['get'] === 'function' &&
  isRecord(value['stdout']) &&
  typeof value['stdout']['write'] === 'function' &&
  isRecord(value['version']) &&
  typeof value['version']['deno'] === 'string';

export const denoRuntime = (): DenoRuntime => {
  const runtimeRoot: unknown = globalThis;
  if (!isRecord(runtimeRoot)) {
    throw new Error('The global runtime object is unavailable.');
  }
  const runtime = runtimeRoot['Deno'];
  if (!isDenoRuntime(runtime)) {
    throw new Error('This integration test requires Deno.');
  }
  return runtime;
};

export const assert: (condition: boolean, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) {
    throw new Error(message);
  }
};

export const requiredEnvironment = (env: DenoRuntime['env'], name: string): string => {
  const value = env.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
};

export const subjectFrom = (token: string): string => {
  const [, payload] = token.split('.');
  if (payload === undefined) {
    throw new Error('Access token is not a JWT.');
  }
  const decoded: unknown = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/')));
  if (!isRecord(decoded) || typeof decoded['sub'] !== 'string') {
    throw new Error('Access token is missing a subject.');
  }
  return decoded['sub'];
};

export const errorCode = (error: unknown): string => {
  if (isRecord(error) && typeof error['code'] === 'string') {
    return error['code'];
  }
  return '';
};

export const openWorkspace = (input: {
  readonly accessToken: string;
  readonly bucket: string;
  readonly publishableKey: string;
  readonly supabaseUrl: string;
}): Promise<Workspace> =>
  Supabash.open({
    bucket: input.bucket,
    publishableKey: input.publishableKey,
    request: new Request('https://workspace.example', {
      headers: { Authorization: `Bearer ${input.accessToken}` },
    }),
    supabaseUrl: input.supabaseUrl,
  });
