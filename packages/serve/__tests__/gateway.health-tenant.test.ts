import { afterEach, describe, expect, it } from 'bun:test';
import {
  type ChatRequest,
  type LLMProvider,
  type LLMResponse,
  MemoryEventStream,
  MemoryPluginHost,
} from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import { startGateway } from '../src/gateway';
import type { GatewayAuthLike } from '../src/tenant';
import { createRuntime, SlowProvider, TestWs } from './helpers';

const gateways: Gateway[] = [];
const clients: TestWs[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const gateway of gateways.splice(0)) gateway.stop();
});

function authFor(): GatewayAuthLike {
  const entries: Record<string, { tenant_id: string; role: 'read' | 'write' | 'admin' }> = {
    a: { tenant_id: 'a', role: 'admin' },
    b: { tenant_id: 'b', role: 'write' },
  };
  return {
    configured: true,
    authenticate: (token) => (token === null ? null : (entries[token] ?? null)),
  };
}

function hostWithTool(name: string): MemoryPluginHost {
  const host = new MemoryPluginHost();
  host.registerTool({
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object' },
    handler: async () => name,
  });
  return host;
}

async function rpc(
  gateway: Gateway,
  token: string,
  method: string,
  params?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${gateway.url}/v1/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, id: crypto.randomUUID(), method, params }),
  });
  return (await response.json()) as Record<string, unknown>;
}

/** 记录模型请求已开始，保证 active run 已进入 engine。 */
class SignalingProvider implements LLMProvider {
  readonly started: Promise<void>;
  private markStarted!: () => void;
  private readonly inner = new SlowProvider(5_000);

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
  }

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.markStarted();
    return this.inner.chat(req);
  }
}

interface NodeShape {
  status: string;
  current_run_id?: string;
  current_session_id?: string;
  capabilities: { tools: string[] };
}

async function startBusyGateway(): Promise<{
  gateway: Gateway;
  runId: string;
}> {
  const events = new MemoryEventStream();
  const provider = new SignalingProvider();
  const runtime = await createRuntime({ events, provider });
  const gateway = startGateway({
    events,
    port: 0,
    token: 'legacy',
    auth: authFor(),
    runtimeFor: () => runtime,
    pluginHost: hostWithTool('default_tool'),
    pluginHostFor: (tenantId) => {
      if (tenantId === 'a') return hostWithTool('tenant_a_tool');
      if (tenantId === 'b') return hostWithTool('tenant_b_tool');
      return undefined;
    },
  });
  gateways.push(gateway);

  const started = await rpc(gateway, 'a', 'runs.start', { input: 'a-run' });
  expect(started.ok).toBe(true);
  const runId = (started.result as { run_id: string }).run_id;
  // 等 runtime 真正开始处理，避免和 engine 入队存在竞态。
  await provider.started;
  return { gateway, runId };
}

describe('health.get tenant isolation', () => {
  it('hides another tenant active run and tools in health.get', async () => {
    const { gateway, runId } = await startBusyGateway();

    const asA = (await rpc(gateway, 'a', 'health.get')).result as { node: NodeShape };
    expect(asA.node.status).toBe('busy');
    expect(asA.node.current_run_id).toBe(runId);
    expect(typeof asA.node.current_session_id).toBe('string');
    expect(asA.node.capabilities.tools).toEqual(['tenant_a_tool']);

    const asB = (await rpc(gateway, 'b', 'health.get')).result as { node: NodeShape };
    expect(asB.node.status).toBe('idle');
    expect(asB.node.current_run_id).toBeUndefined();
    expect(asB.node.current_session_id).toBeUndefined();
    expect(asB.node.capabilities.tools).not.toContain('tenant_a_tool');
    expect(asB.node.capabilities.tools).toEqual(['tenant_b_tool']);

    await rpc(gateway, 'a', 'runs.cancel', { run_id: runId });
  });

  it('scopes the REST /v1/health node to the bearer principal', async () => {
    const { gateway, runId } = await startBusyGateway();

    const asA = (await (
      await fetch(`${gateway.url}/v1/health`, { headers: { Authorization: 'Bearer a' } })
    ).json()) as { node: NodeShape };
    expect(asA.node.status).toBe('busy');
    expect(asA.node.current_run_id).toBe(runId);

    const asB = (await (
      await fetch(`${gateway.url}/v1/health`, { headers: { Authorization: 'Bearer b' } })
    ).json()) as { node: NodeShape };
    expect(asB.node.status).toBe('idle');
    expect(asB.node.current_run_id).toBeUndefined();
    expect(asB.node.capabilities.tools).toEqual(['tenant_b_tool']);

    // 无凭据时只返回进程级字段，不暴露任何 tenant 的运行态 / 工具面。
    const anonymous = (await (await fetch(`${gateway.url}/v1/health`)).json()) as {
      node: NodeShape;
    };
    expect(anonymous.node.status).toBe('idle');
    expect(anonymous.node.current_run_id).toBeUndefined();
    expect(anonymous.node.capabilities.tools).toEqual([]);

    await rpc(gateway, 'a', 'runs.cancel', { run_id: runId });
  });

  it('scopes the hello frame node to the connection tenant', async () => {
    const { gateway, runId } = await startBusyGateway();

    const clientA = await TestWs.connect(gateway, { token: 'a' });
    clients.push(clientA);
    const helloA = await clientA.next((frame) => frame.kind === 'hello');
    if (helloA.kind !== 'hello') throw new Error('expected hello');
    expect(helloA.node.status).toBe('busy');
    expect(helloA.node.current_run_id).toBe(runId);
    expect(helloA.node.capabilities.tools).toEqual(['tenant_a_tool']);

    const clientB = await TestWs.connect(gateway, { token: 'b' });
    clients.push(clientB);
    const helloB = await clientB.next((frame) => frame.kind === 'hello');
    if (helloB.kind !== 'hello') throw new Error('expected hello');
    expect(helloB.node.status).toBe('idle');
    expect(helloB.node.current_run_id).toBeUndefined();
    expect(helloB.node.current_session_id).toBeUndefined();
    expect(helloB.node.capabilities.tools).toEqual(['tenant_b_tool']);

    await rpc(gateway, 'a', 'runs.cancel', { run_id: runId });
  });
});
