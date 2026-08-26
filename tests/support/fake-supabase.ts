export interface SupabaseCall {
  readonly authorization: string | null;
  readonly method: string;
  readonly path: string;
}

interface StoredObject {
  readonly body: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly etag: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly modifiedAt: string;
}

const AUTH_PATH = '/auth/v1/user';
const STORAGE_ROOT = '/storage/v1/object/';
const TIMESTAMP = '2026-08-26T12:00:00.000Z';

export class FakeSupabase {
  readonly calls: SupabaseCall[] = [];
  readonly listPrefixes: string[] = [];
  private etagSequence = 0;
  private readonly objects = new Map<string, StoredObject>();
  private readonly users: ReadonlyMap<string, string>;

  constructor(users: Readonly<Record<string, string>>) {
    this.users = new Map(Object.entries(users));
  }

  readonly fetch: typeof fetch = Object.assign(
    (input: string | URL | Request, init?: BunFetchRequestInit) => this.route(input, init),
    { preconnect: (): void => undefined },
  );

  keys(): string[] {
    return [...this.objects.keys()].toSorted();
  }

  text(key: string): string | undefined {
    const body = this.objects.get(key)?.body;
    return body === undefined ? undefined : new TextDecoder().decode(body);
  }

  private route(input: string | URL | Request, init?: BunFetchRequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    this.calls.push({
      authorization: request.headers.get('authorization'),
      method: request.method,
      path: url.pathname,
    });

    if (url.pathname === AUTH_PATH && request.method === 'GET') {
      return Promise.resolve(this.authenticate(request));
    }
    if (url.pathname.startsWith(`${STORAGE_ROOT}list-v2/`) && request.method === 'POST') {
      return this.list(request);
    }
    if (url.pathname.startsWith(`${STORAGE_ROOT}info/`) && request.method === 'GET') {
      return Promise.resolve(this.info(url.pathname));
    }
    if (url.pathname.startsWith(STORAGE_ROOT) && request.method === 'POST') {
      return this.upload(request, url.pathname);
    }
    if (url.pathname.startsWith(STORAGE_ROOT) && request.method === 'DELETE') {
      return this.remove(request);
    }
    if (url.pathname.startsWith(STORAGE_ROOT) && request.method === 'GET') {
      return Promise.resolve(this.download(url.pathname));
    }
    return Promise.resolve(json({ message: 'Unhandled fake Supabase route.' }, 501));
  }

  private authenticate(request: Request): Response {
    const userId = this.users.get(bearerToken(request));
    if (userId === undefined) {
      return json({ code: 401, message: 'Invalid token.' }, 401);
    }
    return json({
      app_metadata: {},
      aud: 'authenticated',
      created_at: TIMESTAMP,
      id: userId,
      role: 'authenticated',
      user_metadata: {},
    });
  }

  private async list(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    const prefix = recordString(body, 'prefix');
    this.listPrefixes.push(prefix);
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, object]) => ({
        created_at: object.modifiedAt,
        id: key,
        last_accessed_at: object.modifiedAt,
        metadata: systemMetadata(object),
        name: key.slice(prefix.length),
        updated_at: object.modifiedAt,
      }));
    return json({ folders: [], hasNext: false, objects });
  }

  private info(path: string): Response {
    const key = pathAfter(path, `${STORAGE_ROOT}info/`);
    const object = this.objects.get(keyAfterBucket(key));
    if (object === undefined) {
      return json({ error: 'not_found', message: 'Object not found.', statusCode: '404' }, 400);
    }
    return json({
      bucket_id: bucketFrom(key),
      content_type: object.contentType,
      created_at: object.modifiedAt,
      etag: object.etag,
      id: key,
      last_modified: object.modifiedAt,
      metadata: object.metadata,
      name: keyAfterBucket(key),
      size: object.body.byteLength,
      version: object.etag,
    });
  }

  private async upload(request: Request, path: string): Promise<Response> {
    const bucketAndKey = pathAfter(path, STORAGE_ROOT);
    const key = keyAfterBucket(bucketAndKey);
    const body = new Uint8Array(await request.arrayBuffer());
    const metadata = metadataFrom(request);
    const etag = this.nextEtag();
    this.objects.set(key, {
      body,
      contentType: request.headers.get('content-type') ?? 'application/octet-stream',
      etag,
      metadata,
      modifiedAt: TIMESTAMP,
    });
    return json({ Id: etag, Key: bucketAndKey });
  }

  private async remove(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    const prefixes = recordStrings(body, 'prefixes');
    for (const prefix of prefixes) {
      this.objects.delete(prefix);
    }
    return json([]);
  }

  private download(path: string): Response {
    const object = this.objects.get(keyAfterBucket(pathAfter(path, STORAGE_ROOT)));
    if (object === undefined) {
      return json({ error: 'not_found', message: 'Object not found.', statusCode: '404' }, 404);
    }
    return new Response(new Blob([object.body]), {
      headers: { 'content-type': object.contentType },
    });
  }

  private nextEtag(): string {
    this.etagSequence += 1;
    return `etag-${this.etagSequence}`;
  }
}

const bearerToken = (request: Request): string =>
  request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? '';

const metadataFrom = (request: Request): Readonly<Record<string, string>> => {
  const encoded = request.headers.get('x-metadata');
  const parsed: unknown = JSON.parse(atob(encoded ?? 'e30='));
  if (!isRecord(parsed)) {
    throw new TypeError('Expected encoded object metadata.');
  }
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
};

const systemMetadata = (object: StoredObject): Record<string, string | number> => ({
  eTag: object.etag,
  mimetype: object.contentType,
  size: object.body.byteLength,
});

const recordString = (value: unknown, key: string): string => {
  const entry = isRecord(value) ? value[key] : undefined;
  if (typeof entry !== 'string') {
    throw new TypeError(`Expected ${key} to be a string.`);
  }
  return entry;
};

const recordStrings = (value: unknown, key: string): readonly string[] => {
  const entry = isRecord(value) ? value[key] : undefined;
  if (!Array.isArray(entry) || !entry.every((item) => typeof item === 'string')) {
    throw new TypeError(`Expected ${key} to contain strings.`);
  }
  return entry;
};

const pathAfter = (path: string, prefix: string): string =>
  decodeURIComponent(path.slice(prefix.length));

const bucketFrom = (bucketAndKey: string): string => bucketAndKey.split('/', 1)[0] ?? '';

const keyAfterBucket = (bucketAndKey: string): string =>
  bucketAndKey.slice(bucketAndKey.indexOf('/') + 1);

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { headers: { 'content-type': 'application/json' }, status });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
