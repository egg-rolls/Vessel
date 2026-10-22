import { describe, expect, test } from 'bun:test';
import {
  askFromEvent,
  enqueueInteraction,
  enqueuePermission,
  interactionAgentId,
  isExpiredError,
  isNotFoundError,
  isRunEndedError,
  permissionFromEvent,
  permissionRespondParams,
  removeInteraction,
  SubmitGuard,
} from '../src/gateway/interactions';
import type { RunEvent } from '../src/gateway/types';

interface Item {
  requestId: string;
}

describe('interaction queue (0.18: no TTL)', () => {
  test('never drops a request over time', () => {
    const item: Item = { requestId: 'perm-old' };
    const queue = enqueueInteraction([], item);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toBe(item);
  });

  test('does not enqueue the same requestId twice', () => {
    const item: Item = { requestId: 'perm-1' };
    const once = enqueueInteraction([], item);
    const twice = enqueueInteraction(once, { ...item });
    expect(twice).toBe(once);
    expect(twice).toHaveLength(1);
  });
});

describe('not_found handling', () => {
  test('not_found removes the popup entry, other errors keep it', () => {
    const queue: Item[] = [{ requestId: 'perm-1' }];
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

  test('maps association fields without an expiry deadline', () => {
    const item = permissionFromEvent(
      event({ requestId: 'perm-1', tool: 'bash', input: { cmd: 'ls' } }),
      9_999,
    );
    expect(item).toMatchObject({
      requestId: 'perm-1',
      tool: 'bash',
      runId: 'run-1',
      requestedAt: 1_000,
    });
  });

  test('keeps association fields and ignores legacy deadline_at', () => {
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
    });
  });

  test('accepts request_id for older emitters and drops events without an id', () => {
    expect(permissionFromEvent(event({ request_id: 'legacy-1' }))?.requestId).toBe('legacy-1');
    expect(permissionFromEvent(event({ tool: 'bash' }))).toBeNull();
  });

  test('never drops a permission request over time and dedupes by requestId', () => {
    const item = permissionFromEvent(event({ requestId: 'perm-1' }));
    expect(item).not.toBeNull();
    if (!item) return;
    const first = enqueuePermission([], item);
    expect(first).toHaveLength(1);
    // 重放/刷新：同一 requestId 不重复入队；不做过期过滤。
    expect(enqueuePermission(first, { ...item, requestedAt: 99_999 })).toBe(first);
  });

  test('maps subagent association fields without changing old streams', () => {
    expect(
      permissionFromEvent(event({ requestId: 'perm-1', delegate_id: 'delegate-1' }))?.agentId,
    ).toBe('delegate-1');
    expect(permissionFromEvent(event({ requestId: 'perm-2', agent_id: 'agent-1' }))?.agentId).toBe(
      'agent-1',
    );
    expect(
      permissionFromEvent(event({ requestId: 'perm-3', parent_delegate_id: 'parent-1' }))?.agentId,
    ).toBe('parent-1');
    // delegate 插件用 camelCase；内层 agent 优先于 parent。
    expect(interactionAgentId({ delegateId: 'inner-1', parent_delegate_id: 'outer-1' })).toBe(
      'inner-1',
    );
    expect(permissionFromEvent(event({ requestId: 'perm-4' }))).not.toHaveProperty('agentId');
  });

  test('keeps session_id and parent_session_id for member bridge requests', () => {
    const item = permissionFromEvent(
      event({
        requestId: 'perm-1',
        session_id: 'member-1',
        parent_session_id: 'chat-1',
      }),
    );
    expect(item).toMatchObject({ sessionId: 'member-1', parentSessionId: 'chat-1' });

    // 旧事件没有 parent_session_id：不得凭空生成该属性。
    const legacy = permissionFromEvent(event({ requestId: 'perm-2', session_id: 'member-2' }));
    expect(legacy?.sessionId).toBe('member-2');
    expect(legacy).not.toHaveProperty('parentSessionId');
  });
});

describe('askFromEvent (0.17)', () => {
  const event = (data: Record<string, unknown>, ts = 1_000): RunEvent => ({
    type: 'ask.user.requested',
    run_id: 'run-1',
    ts,
    data,
  });

  test('maps questions, session, agentId and the event requestedAt', () => {
    const item = askFromEvent(
      event({
        requestId: 'ask-1',
        questions: [{ header: 'Pick', question: 'Which?' }],
        delegate_id: 'delegate-9',
      }),
      'session-1',
    );
    expect(item).toMatchObject({
      requestId: 'ask-1',
      runId: 'run-1',
      sessionId: 'session-1',
      agentId: 'delegate-9',
      requestedAt: 1_000,
    });
  });

  test('falls back to now when the event timestamp is missing', () => {
    const item = askFromEvent(
      {
        type: 'ask.user.requested',
        run_id: 'run-1',
        ts: 0,
        data: { requestId: 'ask-2', questions: [{ question: 'Q' }] },
      },
      undefined,
      5_000,
    );
    expect(item?.requestedAt).toBe(5_000);
  });

  test('keeps old streams working and rejects malformed payloads', () => {
    const legacy = askFromEvent(
      event({ request_id: 'ask-legacy', questions: [{ question: 'Q' }] }),
      undefined,
    );
    expect(legacy?.requestId).toBe('ask-legacy');
    expect(legacy).not.toHaveProperty('sessionId');
    expect(legacy).not.toHaveProperty('agentId');
    expect(askFromEvent(event({ questions: [{ question: 'Q' }] }))).toBeNull();
    expect(askFromEvent(event({ requestId: 'ask-3', questions: [] }))).toBeNull();
  });

  test('keeps the caller session and maps parent_session_id', () => {
    const item = askFromEvent(
      event({
        requestId: 'ask-1',
        questions: [{ question: 'Q' }],
        parent_session_id: 'chat-1',
      }),
      'member-1',
    );
    expect(item).toMatchObject({ sessionId: 'member-1', parentSessionId: 'chat-1' });

    const legacy = askFromEvent(
      event({ requestId: 'ask-2', questions: [{ question: 'Q' }] }),
      'member-1',
    );
    expect(legacy?.sessionId).toBe('member-1');
    expect(legacy).not.toHaveProperty('parentSessionId');
  });
});

describe('expired / run-ended error + scope params (0.13)', () => {
  test('recognizes expired over both WS and HTTP shapes', () => {
    expect(isExpiredError(new Error('expired: Permission request expired'))).toBe(true);
    expect(isExpiredError({ code: 'expired', message: 'gone' })).toBe(true);
    expect(isExpiredError(new Error('not_found: missing'))).toBe(false);
  });

  test('recognizes run_ended as “run has ended”, not “not allowed”', () => {
    expect(isRunEndedError(new Error('run_ended: Run has ended'))).toBe(true);
    expect(
      isRunEndedError({ code: 'run_ended', message: 'ended', details: { status: 'orphaned' } }),
    ).toBe(true);
    expect(isRunEndedError(new Error('expired: gone'))).toBe(false);
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
