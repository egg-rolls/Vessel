/**
 * 0.18 守卫：tenant 流是唯一事件面。
 *
 * gateway 只从 `TenantEventHub` 观察事件；没有共享流、没有单流 `events` 选项，
 * 也没有业务代码可以 publish 到扇入面（hub 不暴露 publish）。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryEventStream, type RunEvent, type Transport } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import { startGateway } from '../src/gateway';
import { createLocalRpcDispatcher, type LocalRpcDispatcher } from '../src/local';
import { createGatewayEventHub } from '../src/tenant-event-hub';
import { runDispatcher } from './rpc-test-utils';

const dispatchers: LocalRpcDispatcher[] = [];
const gateways: Gateway[] = [];

afterEach(() => {
  for (const dispatcher of dispatchers.splice(0)) dispatcher.dispose();
  for (const gateway of gateways.splice(0)) void gateway.stop();
});

function requestPermission(requestId: string): RunEvent {
  return {
    type: 'tool.permission.request',
    run_id: 'run-1',
    data: { requestId, tool: 'bash', input: { cmd: 'ls' } },
    ts: Date.now(),
  };
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

describe('tenant event plane (0.18)', () => {
  it('accepts interactions from tenant streams and never from an external projection', async () => {
    const tenant = new MemoryEventStream();
    const projection = new MemoryEventStream();
    const hub = createGatewayEventHub({
      streams: [{ tenantId: 'default', stream: tenant }],
    });
    const dispatcher = createLocalRpcDispatcher({ hub });
    dispatchers.push(dispatcher);

    // 外部流不属于 hub：即使发布请求也不会进 engine。
    projection.publish(requestPermission('perm-projection'));
    const ignored = await dispatcher.dispatch({
      v: 1,
      id: crypto.randomUUID(),
      method: 'permission.respond',
      params: { request_id: 'perm-projection', decision: 'allow' },
    });
    expect(ignored.ok).toBe(false);
    if (!ignored.ok) expect(ignored.error.code).toBe('not_found');

    tenant.publish(requestPermission('perm-tenant'));
    const accepted = await runDispatcher(dispatcher.dispatch, 'permission.respond', {
      request_id: 'perm-tenant',
      decision: 'allow',
    });
    expect(accepted).toMatchObject({ ok: true, decision: 'allow' });

    expect(
      tenant
        .getHistory()
        .some(
          (event) =>
            event.type === 'tool.permission.response' &&
            (event.data as { requestId?: string }).requestId === 'perm-tenant',
        ),
    ).toBe(true);
    expect(projection.getHistory().some((event) => event.type === 'tool.permission.response')).toBe(
      false,
    );
  });

  it('publishes team diagnostics to the default tenant stream', async () => {
    const tenant = new MemoryEventStream();
    const hub = createGatewayEventHub({
      streams: [{ tenantId: 'default', stream: tenant }],
    });
    const transport: Transport = {
      kind: 'in-process',
      send: async () => undefined,
      receive: () => () => undefined,
      peers: async () => [],
      close: async () => undefined,
    };
    const gateway = startGateway({ hub, port: 0, nodeId: 'A', team: { nodeId: 'A', transport } });
    gateways.push(gateway);

    const res = await fetch(`${gateway.url}/v1/team/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gateway.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: 1,
        message: {
          id: 'msg-1',
          from: 'A:owner',
          to: 'B:worker',
          kind: 'task',
          content: 'hello',
          ts: Date.now(),
        },
      }),
    });
    expect(res.status).toBe(202);

    const diagnostic = hub.since(0).find((item) => item.event.type === 'team.message.sent');
    expect(diagnostic?.event.tenant_id).toBe('default');
    expect(diagnostic?.event.data).toMatchObject({ messageId: 'msg-1' });
  });

  it('does not close the injected hub when the gateway stops', async () => {
    const tenant = new MemoryEventStream();
    const hub = createGatewayEventHub({
      streams: [{ tenantId: 'default', stream: tenant }],
    });
    const gateway = startGateway({ hub, port: 0 });
    await gateway.stop();

    // gateway.stop 只退订；app 之后仍能读 hub 并继续注册 / 关闭。
    expect(hub.streamFor('default')).toBe(tenant);
    tenant.publish({ type: 'run.started', run_id: 'r1', data: {}, ts: Date.now() });
    expect(hub.latestSeq).toBe(1);
    hub.close();
  });

  it('keeps no shared-stream or single-stream leftovers in serve sources', () => {
    const root = join(import.meta.dir, '..', 'src');
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain('sharedEvents');
      expect(source).not.toContain('tenantEventSources');
      expect(source).not.toContain('interactionTtlMs');
      expect(source).not.toContain('sweep(');
      // 单流 GatewayOptions.events 已删除（事件变量名不在此守卫范围）。
      expect(source).not.toMatch(/^\s*events: EventStream;$/m);
    }
  });
});
