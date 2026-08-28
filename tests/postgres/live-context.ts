import { Supabash, type PostgresWorkspace } from '@seanmozeik/supabash-fs';

import type { IntegrationRuntime } from './runtime.ts';

export type Json = null | boolean | number | string | Json[] | JsonRecord;
export interface JsonRecord {
  readonly [key: string]: Json;
}

export interface TestUser {
  readonly accessToken: string;
  readonly id: string;
}

export interface RpcResponse {
  readonly body: Json;
  readonly ok: boolean;
  readonly status: number;
}

export class LiveContext {
  readonly assertions: string[] = [];
  readonly functionsUrl: string;
  readonly publishableKey: string;
  readonly resultsFile: string;
  readonly runId: string;
  readonly serviceRoleKey: string;
  readonly supabaseUrl: string;
  private readonly createdUsers: string[] = [];

  constructor(runtime: IntegrationRuntime) {
    this.supabaseUrl = required(runtime, 'SUPABASH_TEST_SUPABASE_URL');
    this.publishableKey = required(runtime, 'SUPABASH_TEST_PUBLISHABLE_KEY');
    this.serviceRoleKey = required(runtime, 'SUPABASH_TEST_SERVICE_ROLE_KEY');
    this.functionsUrl = required(runtime, 'SUPABASH_TEST_FUNCTIONS_URL');
    this.runId = required(runtime, 'SUPABASH_TEST_RUN_ID');
    this.resultsFile = required(runtime, 'SUPABASH_TEST_RESULTS_FILE');
  }

  async cleanupUsers(): Promise<readonly string[]> {
    const failures: string[] = [];
    for (const userId of this.createdUsers) {
      const response = await fetch(`${this.supabaseUrl}/auth/v1/admin/users/${userId}`, {
        headers: LiveContext.headers(this.serviceRoleKey, this.serviceRoleKey),
        method: 'DELETE',
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        failures.push(`Synthetic user cleanup failed with HTTP ${response.status}.`);
      }
    }
    return failures;
  }

  async createUser(label: string): Promise<TestUser> {
    const email = `supabash-postgres-test-${label}-${this.runId}@example.test`;
    const password = `T3st-${this.runId}-${label}-aA!`;
    const created = await this.jsonRequest('/auth/v1/admin/users', {
      body: { email, email_confirm: true, password },
      key: this.serviceRoleKey,
      method: 'POST',
      token: this.serviceRoleKey,
    });
    assert(created.ok, `Could not create synthetic ${label}: HTTP ${created.status}.`);
    const id = stringField(created.body, 'id', 'created user');
    this.createdUsers.push(id);
    const session = await this.jsonRequest('/auth/v1/token?grant_type=password', {
      body: { email, password },
      key: this.publishableKey,
      method: 'POST',
    });
    assert(session.ok, `Could not sign in synthetic ${label}: HTTP ${session.status}.`);
    return { accessToken: stringField(session.body, 'access_token', 'session'), id };
  }

  async createWorkspace(accessToken: string): Promise<string> {
    const result = await this.rpc(accessToken, 'supabash_create_workspace', {});
    assert(result.ok, `Workspace creation failed with HTTP ${result.status}.`);
    return stringField(result.body, 'workspaceId', 'workspace creation');
  }

  async directTableDenied(accessToken: string, table: string): Promise<boolean> {
    const response = await fetch(`${this.supabaseUrl}/rest/v1/${table}?select=*&limit=1`, {
      headers: {
        ...LiveContext.headers(this.publishableKey, accessToken),
        'accept-profile': 'supabash',
      },
      signal: AbortSignal.timeout(30_000),
    });
    return !response.ok;
  }

  open(accessToken: string, workspace: string): Promise<PostgresWorkspace> {
    return Supabash.openPostgres({
      publishableKey: this.publishableKey,
      request: new Request('https://workspace.example.test', {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
      supabaseUrl: this.supabaseUrl,
      workspace,
    });
  }

  record(name: string): void {
    this.assertions.push(name);
  }

  rpc(accessToken: string, name: string, args: JsonRecord): Promise<RpcResponse> {
    return this.jsonRequest(`/rest/v1/rpc/${name}`, {
      body: args,
      key: this.publishableKey,
      method: 'POST',
      token: accessToken,
    });
  }

  async serviceRpc(name: string, args: JsonRecord): Promise<Json> {
    const result = await this.serviceRpcResponse(name, args);
    assert(result.ok, `${name} failed with HTTP ${result.status}.`);
    return result.body;
  }

  serviceRpcResponse(name: string, args: JsonRecord): Promise<RpcResponse> {
    return this.jsonRequest(`/rest/v1/rpc/${name}`, {
      body: args,
      key: this.serviceRoleKey,
      method: 'POST',
      token: this.serviceRoleKey,
    });
  }

  private static headers(key: string, token?: string): Record<string, string> {
    const headers: Record<string, string> = { apikey: key, 'content-type': 'application/json' };
    if (token !== undefined) {
      headers['authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  private async jsonRequest(
    path: string,
    input: {
      readonly body: JsonRecord;
      readonly key: string;
      readonly method: 'POST';
      readonly token?: string;
    },
  ): Promise<RpcResponse> {
    const response = await fetch(`${this.supabaseUrl}${path}`, {
      body: JSON.stringify(input.body),
      headers: LiveContext.headers(input.key, input.token),
      method: input.method,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    return {
      body: text.length === 0 ? null : parseJson(JSON.parse(text)),
      ok: response.ok,
      status: response.status,
    };
  }
}

const required = (runtime: IntegrationRuntime, name: string): string => {
  const value = runtime.env.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
};

export const parseJson = (value: unknown): Json => {
  if (value === null) {
    return null;
  }
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => parseJson(entry));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, parseJson(entry)]));
  }
  throw new TypeError('Value is not JSON.');
};

export const asRecord = (value: Json, label: string): JsonRecord => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is not an object.`);
  }
  return value;
};

const stringField = (value: Json, key: string, label: string): string => {
  const field = asRecord(value, label)[key];
  if (typeof field !== 'string') {
    throw new TypeError(`${label} has no ${key}.`);
  }
  return field;
};

export const assert: (condition: boolean, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) {
    throw new Error(message);
  }
};

export const errorCode = (error: unknown): string => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return '';
  }
  return typeof error.code === 'string' ? error.code : '';
};

export const expectCode = async (
  work: Promise<unknown>,
  code: string,
  message: string,
): Promise<void> => {
  try {
    await work;
    throw new Error(message);
  } catch (error) {
    if (error instanceof Error && error.message === message) {
      throw error;
    }
    assert(
      errorCode(error) === code,
      `${message} Received ${errorCode(error) || 'no typed code'}.`,
    );
  }
};

export const subjectFrom = (token: string): string => {
  const [, payload] = token.split('.');
  if (payload === undefined) {
    throw new Error('Access token has no payload.');
  }
  const parsed = parseJson(JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))));
  const subject = asRecord(parsed, 'access token payload')['sub'];
  if (typeof subject !== 'string') {
    throw new TypeError('Access token has no subject.');
  }
  return subject;
};

export const formatError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown integration failure.';

export const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error('Unknown integration failure.');
