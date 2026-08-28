export interface IntegrationRuntime {
  readonly env: { readonly get: (name: string) => string | undefined };
  readonly version: { readonly deno: string };
  readonly writeTextFile: (path: string, data: string) => Promise<void>;
}

export interface EdgeRuntime extends IntegrationRuntime {
  readonly serve: (handler: (request: Request) => Response | Promise<Response>) => void;
}

interface RuntimeCandidate {
  readonly env: { readonly get: (name: string) => string | undefined };
  readonly serve?: (handler: (request: Request) => Response | Promise<Response>) => void;
  readonly version: { readonly deno: string };
  readonly writeTextFile: (path: string, data: string) => Promise<void>;
}

export const integrationRuntime = (): IntegrationRuntime => {
  const candidate = runtimeCandidate();
  return {
    env: { get: (name) => candidate.env.get(name) },
    version: { deno: candidate.version.deno },
    writeTextFile: (path, data) => candidate.writeTextFile(path, data),
  };
};

export const edgeRuntime = (): EdgeRuntime => {
  const candidate = runtimeCandidate();
  const { serve } = candidate;
  if (serve === undefined) {
    throw new Error('The Edge Runtime serve API is unavailable.');
  }
  return {
    env: { get: (name) => candidate.env.get(name) },
    serve: (handler) => {
      serve(handler);
    },
    version: { deno: candidate.version.deno },
    writeTextFile: (path, data) => candidate.writeTextFile(path, data),
  };
};

const runtimeCandidate = (): RuntimeCandidate => {
  const root: unknown = globalThis;
  if (!isRecord(root) || !isRuntimeCandidate(root['Deno'])) {
    throw new Error('This integration requires Deno.');
  }
  return root['Deno'];
};

const isRuntimeCandidate = (value: unknown): value is RuntimeCandidate =>
  isRecord(value) &&
  isEnv(value['env']) &&
  isVersion(value['version']) &&
  typeof value['writeTextFile'] === 'function' &&
  (value['serve'] === undefined || typeof value['serve'] === 'function');

const isEnv = (value: unknown): value is RuntimeCandidate['env'] =>
  isRecord(value) && typeof value['get'] === 'function';
const isVersion = (value: unknown): value is RuntimeCandidate['version'] =>
  isRecord(value) && typeof value['deno'] === 'string';
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
