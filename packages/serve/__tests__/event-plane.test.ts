/**
 * 0.18 Step 2 守卫：engine 只观察 / 投递 tenant 流，shared 只是出站投影。
 *
 * gateway 不再从 shared 订阅里调用 engine.handleEvent；shared 上出现的
 * 交互请求不会被受理，也不会产生 pending。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryEventStream, type RunEvent } from '@vessel-agent/core';
import { createLocalRpcDispatcher, type LocalRpcDispatcher } from '../src/local';
import { runDispatcher } from './rpc-test-utils';

const dispatchers: LocalRpcDispatcher[] = [];

afterEach(() => {
  for (const dispatcher of dispatchers.splice(0)) dispatcher.dispose();
});

function requestPermission(requestId: string): RunEvent {
  return {
    type: 'tool.permission.request',
    run_id: 'run-1',
    data: { requestId, tool: 'bash', input: { cmd: 'ls' } },
    ts: Date.now(),
  };
}

describe('gateway event plane (tenant streams drive the engine)', () => {
  it('ignores interactions published only on the projection stream', async () => {
    const shared = new MemoryEventStream();
    const tenant = new MemoryEventStream();
    const dispatcher = createLocalRpcDispatcher({
      events: shared,
      tenantEventSources: () => [{ tenantId: 'default', events: tenant }],
    });
    dispatchers.push(dispatcher);

    shared.publish(requestPermission('perm-shared'));
    const ignored = await dispatcher.dispatch({
      v: 1,
      id: crypto.randomUUID(),
      method: 'permission.respond',
      params: { request_id: 'perm-shared', decision: 'allow' },
    });
    expect(ignored.ok).toBe(false);
    if (!ignored.ok) expect(ignored.error.code).toBe('not_found');

    tenant.publish(requestPermission('perm-tenant'));
    const accepted = await runDispatcher(dispatcher.dispatch, 'permission.respond', {
      request_id: 'perm-tenant',
      decision: 'allow',
    });
    expect(accepted).toMatchObject({ ok: true, decision: 'allow' });

    // 应答只出现在 tenant 流；gateway 不再替 shared 补写。
    expect(
      tenant
        .getHistory()
        .some(
          (event) =>
            event.type === 'tool.permission.response' &&
            (event.data as { requestId?: string }).requestId === 'perm-tenant',
        ),
    ).toBe(true);
    expect(shared.getHistory().some((event) => event.type === 'tool.permission.response')).toBe(
      false,
    );
  });

  it('keeps the run engine free of single-stream and TTL options', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'run-engine.ts'), 'utf8');
    expect(source).not.toContain('interactionTtlMs');
    expect(source).not.toContain('sweep(');
    expect(source).not.toMatch(/^\s*events: EventStream;/m);
  });
});
