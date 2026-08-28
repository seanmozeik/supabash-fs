import { describe, expect, test, vi } from 'vitest';

import { SupabashError } from '../../src/api/errors.ts';
import type { WorkspaceOperationEvent } from '../../src/api/observability.ts';
import { startOperation } from '../../src/core/observability.ts';

describe('workspace observability', () => {
  test('emits only structured privacy-safe fields', () => {
    const events: WorkspaceOperationEvent[] = [];
    startOperation(
      {
        onOperation: (event) => {
          events.push(event);
        },
      },
      'postgres',
      'snapshot-load',
    ).success({ documentCount: 3, serializedPayloadBytes: 120, totalUtf8Bytes: 42 });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      backend: 'postgres',
      documentCount: 3,
      operation: 'snapshot-load',
      outcome: 'success',
      serializedPayloadBytes: 120,
      totalUtf8Bytes: 42,
    });
    expect(Object.keys(events[0] ?? {})).not.toStrictEqual(
      expect.arrayContaining(['body', 'error', 'path', 'token', 'userId', 'workspaceId']),
    );
  });

  test('maps typed conflicts and ignores observer failures', () => {
    const observer = vi.fn<(event: WorkspaceOperationEvent) => void>(() => {
      throw new Error('observer failed');
    });
    expect(() => {
      startOperation({ onOperation: observer }, 'postgres', 'commit').failure(
        new SupabashError('COMMIT_CONFLICT', 'stale'),
        { changeCount: 2 },
      );
    }).not.toThrow();
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        changeCount: 2,
        errorCode: 'COMMIT_CONFLICT',
        outcome: 'conflict',
      }),
    );
  });

  test('does no clock or callback work when absent', () => {
    const now = vi.spyOn(performance, 'now');
    startOperation(undefined, 'storage', 'history').success();
    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
  });
});
