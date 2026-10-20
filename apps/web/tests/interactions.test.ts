import { describe, expect, test } from 'bun:test';
import {
  enqueueInteraction,
  expireInteractions,
  INTERACTION_TTL_MS,
  interactionExpiresAt,
  isExpiredError,
  isInteractionExpired,
  isNotFoundError,
  permissionFromEvent,
  permissionRespondParams,
  removeInteraction,
  SubmitGuard,
} from '../src/gateway/interactions';
import type { RunEvent } from '../src/gateway/types';

interface Item {
  requestId: string;
  expiresAt: number;
}

describe('interactionExpiresAt', () => {
  test('computes expiry from the event timestamp, not from receive time', () => {
    const eventTs = 1_000_000;
    expect(interactionExpiresAt(eventTs, INTERACTION_TTL_MS, 9_999_999)).toBe(
      eventTs + INTERACTION_TTL_MS,
    );
  });

  test('falls back to now when the event timestamp is missing or invalid', () => {
    expect(interactionExpiresAt(undefined, 120_000, 5_000)).toBe(125_000);
    expect(interactionExpiresAt(Number.NaN, 120_000, 5_000)).toBe(125_000);
    expect(interactionExpiresAt(0, 120_000, 5_000)).toBe(125_000);
  });
});

describe('permission replay guard', () => {
  test('drops a replayed request whose event time is already past the TTL', () => {
    const eventTs = 1_000;
    const replayNow = eventTs + INTERACTION_TTL_MS + 1;
    const item: Item = { requestId: 'perm-old', expiresAt: interactionExpiresAt(eventTs) };
    expect(enqueueInteraction([], item, replayNow)).toHaveLength(0);
  });

  test('keeps a request that is still inside the TTL window', () => {
    const eventTs = 1_000;
    const replayNow = eventTs + INTERACTION_TTL_MS - 1;
    const item: Item = { requestId: 'perm-live', expiresAt: interactionExpiresAt(eventTs) };
    const queue = enqueueInteraction([], item, replayNow);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.expiresAt).toBe(eventTs + INTERACTION_TTL_MS);
    expect(isInteractionExpired(item, replayNow)).toBe(false);
  });

  test('does not enqueue the same requestId twice', () => {
    const item: Item = { requestId: 'perm-1', expiresAt: 10_000 };
    const once = enqueueInteraction([], item, 1_000);
    const twice = enqueueInteraction(once, { ...item, expiresAt: 20_000 }, 1_000);
    expect(twice).toBe(once);
    expect(twice).toHaveLength(1);
  });
});

describe('expiry cleanup and not_found handling', () => {
  test('removes only expired queue entries', () => {
    const queue: Item[] = [
      { requestId: 'old', expiresAt: 900 },
      { requestId: 'edge', expiresAt: 1_000 },
      { requestId: 'new', expiresAt: 1_001 },
    ];
    expect(expireInteractions(queue, 1_000).map((item) => item.requestId)).toEqual(['new']);
  });

  test('not_found removes the popup entry, other errors keep it', () => {
    const queue: Item[] = [{ requestId: 'perm-1', expiresAt: 10_000 }];
    const notFound = new Error('not_found: Permission request not found');
    expect(isNotFoundError(notFound)).toBe(true);
    expect(removeInteraction(queue, 'perm-1')).toHaveLength(0);

    const busy = new Error('internal: boom');
    expect(isNotFoundError(busy)).toBe(false);
    expect(removeInteraction(queue, 'missing')).toBe(queue);
  });

  test('recognizes HTTP GatewayHttpError codes too', () => {
    expect(isNotFoundError({ code: 'not_found', message: 'gone' })).toBe(true);
    expect(isNotFoundError({ code: 'conflict', message: 'busy' })).toBe(false);
  });
});

describe('permissionFromEvent (0.13)', () => {
  const event = (data: Record<string, unknown>, ts = 1_000): RunEvent => ({
    type: 'tool.permission.request',
    run_id: 'run-1',
    ts,
    data,
  });

  test('derives expiry from event time when deadline_at is missing', () => {
    const item = permissionFromEvent(
      event({ requestId: 'perm-1', tool: 'bash', input: { cmd: 'ls' } }),
      INTERACTION_TTL_MS,
      9_999,
    );
    expect(item).toMatchObject({
      requestId: 'perm-1',
      tool: 'bash',
      runId: 'run-1',
      requestedAt: 1_000,
      expiresAt: 1_000 + INTERACTION_TTL_MS,
    });
  });

  test('prefers the server deadline_at and keeps association fields', () => {
    const item = permissionFromEvent(
      event({
        requestId: 'perm-1',
        tool: 'bash',
        session_id: 'session-9',
        tool_call_id: 'call-3',
        source: 'workflow',
        deadline_at: 7_500,
      }),
    );
    expect(item).toMatchObject({
      sessionId: 'session-9',
      toolCallId: 'call-3',
      source: 'workflow',
      expiresAt: 7_500,
    });
  });

  test('accepts request_id for older emitters and drops events without an id', () => {
    expect(permissionFromEvent(event({ request_id: 'legacy-1' }))?.requestId).toBe('legacy-1');
    expect(permissionFromEvent(event({ tool: 'bash' }))).toBeNull();
  });
});

describe('expired error + scope params (0.13)', () => {
  test('recognizes expired over both WS and HTTP shapes', () => {
    expect(isExpiredError(new Error('expired: Permission request expired'))).toBe(true);
    expect(isExpiredError({ code: 'expired', message: 'gone' })).toBe(true);
    expect(isExpiredError(new Error('not_found: missing'))).toBe(false);
  });

  test('sends scope and keeps remember:true for always (old gateway compat)', () => {
    expect(permissionRespondParams('allow', 'always')).toEqual({
      decision: 'allow',
      scope: 'always',
      remember: true,
    });
    expect(permissionRespondParams('deny')).toEqual({ decision: 'deny', scope: 'once' });
    expect(permissionRespondParams('allow', 'session')).toEqual({
      decision: 'allow',
      scope: 'session',
    });
  });
});

describe('SubmitGuard', () => {
  test('a double click only submits once while the first request is in flight', async () => {
    const guard = new SubmitGuard();
    let calls = 0;
    const submit = async (): Promise<void> => {
      if (!guard.begin('perm-1')) return;
      calls += 1;
      await Promise.resolve();
      guard.end('perm-1');
    };
    await Promise.all([submit(), submit()]);
    expect(calls).toBe(1);
    expect(guard.has('perm-1')).toBe(false);
  });

  test('allows a retry after the previous submission finished', () => {
    const guard = new SubmitGuard();
    expect(guard.begin('perm-1')).toBe(true);
    expect(guard.begin('perm-1')).toBe(false);
    guard.end('perm-1');
    expect(guard.begin('perm-1')).toBe(true);
  });

  test('rejects an empty requestId', () => {
    const guard = new SubmitGuard();
    expect(guard.begin('')).toBe(false);
  });
});
