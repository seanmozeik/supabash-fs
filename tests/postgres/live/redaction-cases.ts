import { createYamlFrontmatterCodec, Supabash } from '@seanmozeik/supabash-fs';

import { asRecord, assert, expectCode, type LiveContext } from './context.ts';

export const proveRepeatedRedaction = async (
  context: LiveContext,
  accessToken: string,
): Promise<void> => {
  const workspaceId = await context.createWorkspace(accessToken);
  const codec = createYamlFrontmatterCodec();
  const workspace = await context.open(accessToken, workspaceId, codec);
  await workspace.fs.writeFile('/memory.md', 'secret');
  await workspace.fs.writeFile('/empty.md', '');
  await workspace.fs.writeFile('/frontmatter.md', '---\nredacted: true\n---\n');
  const first = await workspace.commit({
    context: { actor: 'retry-test', correlationId: context.runId, metadata: { private: 'secret' } },
  });
  const before = await workspace.readRevision(first.revision);
  const frontmatter = await before.readFile('/frontmatter.md');
  assert(frontmatter.includes('redacted: true'), 'User frontmatter was mistaken for a tombstone.');
  await workspace.fs.writeFile('/memory.md', 'safe');
  await workspace.commit();
  const diff = await workspace.diff({ from: { revision: first.revision }, to: { staged: true } });
  assert(
    diff.entries.every((entry) => entry.kind !== 'unavailable'),
    'User frontmatter poisoned a diff.',
  );
  await workspace.redact({ paths: ['/memory.md'] });
  await workspace.redact({ paths: ['/memory.md'], metadataKeys: ['private'] });
  const history = await workspace.history();
  assert(
    history.records.find((record) => record.revision === first.revision)?.metadata?.['private'] ===
      undefined,
    'Previously tombstoned revisions were excluded from metadata scrubbing.',
  );
  // Read an unaffected historical document after the path fence exists.
  const readable = await context.rpc(accessToken, 'supabash_load_document', {
    p_workspace_id: workspaceId,
    p_revision_id: first.revision,
    p_path: '/frontmatter.md',
  });
  assert(readable.ok, 'Valid redacted=true frontmatter became unavailable.');
  let loseResponse = true;
  const retrying = await Supabash.openPostgres({
    workspace: workspaceId,
    documentCodec: codec,
    publishableKey: context.publishableKey,
    supabaseUrl: context.supabaseUrl,
    request: new Request('https://workspace.example.test', {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await fetch(input, init);
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith('/supabash_redact') && loseResponse) {
          assert(response.ok, 'Redaction failed before simulated transport loss.');
          await response.text();
          loseResponse = false;
          throw new Error('Simulated response loss after successful redaction');
        }
        return response;
      },
      { preconnect: (): void => undefined },
    ),
  });
  await expectCode(
    retrying.redact({ paths: ['/memory.md'] }),
    'STORAGE',
    'Lost response was reported successful.',
  );
  await expectCode(
    retrying.commit(),
    'REDACTION_INVALIDATED',
    'Uncertain redaction left the worker writable.',
  );
  await retrying.redact({ paths: ['/memory.md'] });
  await retrying.fs.writeFile('/after-retry.md', 'safe');
  await retrying.commit();
  assert(
    (await retrying.fs.readFile('/empty.md')) === '',
    'Repeated redaction changed the empty file.',
  );
  const afterRetry = await retrying.fs.readFile('/frontmatter.md');
  assert(afterRetry.includes('redacted: true'), 'Repeated redaction changed user frontmatter.');
};

export const proveUnreferencedBody = async (
  context: LiveContext,
  accessToken: string,
): Promise<void> => {
  const workspaceId = await context.createWorkspace(accessToken);
  const secret = 'unreferenced private body';
  const secretHash = await hash(secret);
  const safeHash = await hash('safe');
  const changes = [secret, 'safe'].map((body, index) => ({
    kind: 'upsert',
    path: '/overwritten.md',
    body,
    metadata: {},
    bodyHash: index === 0 ? secretHash : safeHash,
    contentHash: index === 0 ? secretHash : safeHash,
    bodyByteSize: new TextEncoder().encode(body).length,
    byteSize: new TextEncoder().encode(body).length,
  }));
  const result = await context.rpc(accessToken, 'supabash_commit', {
    p_workspace_id: workspaceId,
    p_base_revision: null,
    p_redaction_epoch: '0',
    p_changes: changes,
    p_receipt_changes: changes.map((change, index) => {
      const receiptChange = {
        kind: 'upsert',
        entryKind: 'file',
        path: change.path,
        afterHash: change.contentHash,
        contentHash: change.contentHash,
        afterSize: change.byteSize,
      };
      return index === 0
        ? receiptChange
        : Object.assign(receiptChange, { beforeHash: secretHash, beforeSize: secret.length });
    }),
    p_actor: 'orphan-test',
    p_correlation_id: context.runId,
    p_transaction_id: crypto.randomUUID(),
    p_fingerprint: secretHash,
  });
  assert(result.ok, 'Upsert-then-overwrite fixture failed.');
  const workspace = await context.open(accessToken, workspaceId);
  const dry = await workspace.redact({ bodyHashes: [secretHash], dryRun: true });
  assert(dry.bodies.includes(secretHash), 'Unreferenced body was absent from dry-run candidates.');
  const applied = await workspace.redact({ bodyHashes: [secretHash] });
  assert(
    applied.bodies.includes(secretHash) && applied.bytes === secret.length,
    'Unreferenced body was not reclaimed.',
  );
  const repeated = await workspace.redact({ bodyHashes: [secretHash] });
  assert(repeated.bodies.length === 0, 'Reclaimed body remained in storage.');
  assert(
    (await workspace.fs.readFile('/overwritten.md')) === 'safe',
    'Reclamation changed the final document.',
  );
  // Missing epochs fail closed even for callers bypassing the TypeScript layer.
  const missing = await context.rpc(accessToken, 'supabash_commit', {
    p_workspace_id: workspaceId,
    p_base_revision: workspace.committedRevision(),
    p_changes: [],
    p_receipt_changes: [],
    p_actor: 'orphan-test',
    p_correlation_id: context.runId,
    p_transaction_id: crypto.randomUUID(),
    p_fingerprint: safeHash,
  });
  assert(
    !missing.ok &&
      JSON.stringify(asRecord(missing.body, 'missing epoch error')).includes(
        'SUPABASH_REDACTION_INVALIDATED',
      ),
    'A raw commit bypassed the epoch check.',
  );
};

const hash = async (body: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};
