/**
 * team 原型测试：RuntimeHost 最小形状 + 5 个工具。
 * 全部进程内、不联网；跨进程 transport 不在 0.1.0 范围。
 */

import { describe, expect, it } from 'bun:test';
import {
  type AgentMessage,
  type AgentSpec as CoreAgentSpec,
  InProcessRuntimeHost as CoreInProcessRuntimeHost,
  GuardrailStage,
  HookType,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  type PeerInfo,
  type ToolContext,
  type ToolDefinition,
  type Transport,
  type Unsubscribe,
} from '@vessel-agent/core';
import { CoreHostAdapter } from '../src/core-adapter';
import type { TeamMessage } from '../src/host';
import { buildChildHost, createTeamPlugin, disabledTeamPlugin } from '../src/index';

interface FakeRequest {
  requestId?: string;
  method: string;
  params?: unknown;
}

/** 带 request 的 fake transport：记录方法名，响应由测试注入 */
class RequestTransport implements Transport {
  readonly kind = 'in-process' as const;
  readonly methods: string[] = [];
  responder: (nodeId: string, request: FakeRequest) => Promise<unknown> = async () => {
    throw new Error('no responder');
  };

  async send(_message: AgentMessage): Promise<void> {}
  receive(_handler: (message: AgentMessage) => void | Promise<void>): Unsubscribe {
    return () => {};
  }
  async peers(): Promise<PeerInfo[]> {
    return [];
  }
  async request<T>(nodeId: string, request: FakeRequest): Promise<T> {
    this.methods.push(request.method);
    return (await this.responder(nodeId, request)) as T;
  }
  async close(): Promise<void> {}
}

/** 轮询等待条件成立 */
async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 构造一条消息 */
function message(
  from: string,
  to: string,
  kind: TeamMessage['kind'],
  content: string,
): TeamMessage {
  return { id: `${from}-${to}-${Date.now()}`, from, to, kind, content, ts: Date.now() };
}

/** 空工具上下文（工具 handler 不依赖 runtime） */
function makeContext(): ToolContext {
  return { run_id: 'team-test', messages: [], events: new MemoryEventStream() };
}

/** 从插件 host 取工具 */
function toolOf(host: MemoryPluginHost, name: string): ToolDefinition {
  const tool = host.getTool(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
}

/** 创建装了 team 插件的 host（team 必须注入 core Host） */
function teamHost(options: Omit<Parameters<typeof createTeamPlugin>[0], 'host'>): MemoryPluginHost {
  const host = new MemoryPluginHost();
  createTeamPlugin({ ...options, host: new CoreInProcessRuntimeHost() }).install(host);
  return host;
}

describe('team 插件注册面', () => {
  it('默认导出是空插件（不注册任何工具）', () => {
    const host = new MemoryPluginHost();
    disabledTeamPlugin.install(host);
    expect(host.listTools()).toHaveLength(0);
  });
});

describe('buildChildHost（供 asm 远端 spawn 复用）', () => {
  it('剔除 team_*，保留普通工具与 guardrail/hook', () => {
    const parent = new MemoryPluginHost();
    parent.registerTool({
      name: 'bash',
      description: 'bash',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'ok',
    });
    parent.registerTool({
      name: 'team_send',
      description: 'team',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'ok',
    });
    parent.registerGuardrail({
      name: 'g',
      stage: GuardrailStage.Output,
      check: async () => ({ allowed: true }),
    });
    parent.registerHook({
      name: 'h',
      type: HookType.BeforeTool,
      run: async () => {},
    });

    const child = buildChildHost(parent);
    expect(child.listTools().map((tool) => tool.name)).toEqual(['bash']);
    expect(child.getGuardrails().map((guardrail) => guardrail.name)).toEqual(['g']);
    expect(child.getHooks().map((hook) => hook.name)).toEqual(['h']);
  });

  it('memberLimits / memberTermination 透传到 core AgentSpec', async () => {
    const coreHost = new CoreInProcessRuntimeHost();
    const spawned: CoreAgentSpec[] = [];
    const originalSpawn = coreHost.spawn.bind(coreHost);
    coreHost.spawn = async (spec) => {
      spawned.push(spec);
      return originalSpawn(spec);
    };

    const pluginHost = new MemoryPluginHost();
    createTeamPlugin({
      providerFactory: () => new MemoryLLMProvider(),
      model: 'test-model',
      host: coreHost,
      memberLimits: { requestLimit: 7, toolCallsLimit: 3 },
      memberTermination: { maxIterations: 2, maxRuntimeSeconds: 30 },
    }).install(pluginHost);

    await pluginHost.getTool('team_spawn')?.handler({ name: 'worker' }, makeContext());

    expect(spawned[0]?.limits).toEqual({ run: { requestLimit: 7, toolCallsLimit: 3 } });
    expect(spawned[0]?.termination).toEqual({ maxIterations: 2, maxRuntimeSeconds: 30 });
    await coreHost.close();
  });
});

describe('core Host 端口', () => {
  it('成员上限与未知成员报错', async () => {
    const host = new CoreHostAdapter(new CoreInProcessRuntimeHost({ maxMembers: 1 }));
    await host.spawn({
      id: 'one',
      provider: new MemoryLLMProvider(),
      model: 'm',
      pluginHost: new MemoryPluginHost(),
    });
    await expect(
      host.spawn({
        id: 'two',
        provider: new MemoryLLMProvider(),
        model: 'm',
        pluginHost: new MemoryPluginHost(),
      }),
    ).rejects.toThrow(/limit/);
    await expect(host.send(message('owner', 'missing', 'message', 'x'))).rejects.toThrow(
      /unknown team member/,
    );
  });
});

describe('team 工具面', () => {
  it('spawn → send task → inbox 全链路，且成员不继承 team_* 工具', async () => {
    const events = new MemoryEventStream();
    const host = teamHost({
      providerFactory: () => new MemoryLLMProvider(),
      model: 'test-model',
      events,
    });
    // 父 host 上另有一个普通工具，成员应当继承它
    host.registerTool({
      name: 'bash',
      description: 'bash',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'ok',
    });

    const spawnResult = await toolOf(host, 'team_spawn').handler({ name: 'worker' }, makeContext());
    const spawned = JSON.parse(spawnResult) as { id: string; toolNames: string[] };
    expect(spawned.id).toBeTruthy();
    expect(spawned.toolNames).toContain('bash');
    expect(spawned.toolNames.some((name) => name.startsWith('team_'))).toBe(false);

    await toolOf(host, 'team_send').handler(
      { to: spawned.id, content: 'hello', kind: 'task' },
      makeContext(),
    );

    const inboxResult = await waitFor(async () => {
      const raw = await toolOf(host, 'team_inbox').handler({}, makeContext());
      const page = JSON.parse(raw) as { messages: Array<{ content: string }> };
      return page.messages.length > 0 ? page : undefined;
    });
    expect(inboxResult.messages[0]?.content).toBe('Echo: hello');

    const statusRaw = await toolOf(host, 'team_status').handler(
      { member: spawned.id },
      makeContext(),
    );
    const status = JSON.parse(statusRaw) as { state: string };
    expect(status.state).toBe('idle');
    expect(events.getHistory().some((e) => e.type === 'team.run.completed')).toBe(true);
  });

  it('send 参数校验与未知成员返回错误文本', async () => {
    const host = teamHost({
      providerFactory: () => new MemoryLLMProvider(),
      model: 'test-model',
    });
    const send = toolOf(host, 'team_send');
    expect(await send.handler({ to: '', content: 'x' }, makeContext())).toContain('non-empty to');
    expect(await send.handler({ to: 'a', content: '' }, makeContext())).toContain(
      'non-empty content',
    );
    expect(await send.handler({ to: 'missing', content: 'x' }, makeContext())).toContain(
      'unknown team member',
    );
  });

  it('node 参数把 spawn/inbox/status 路由到远端', async () => {
    const transport = new RequestTransport();
    transport.responder = async (_nodeId, request) => {
      switch (request.method) {
        case 'team.spawn':
          return { protocol: 1, agent: { id: 'worker', state: 'idle', tool_names: [] } };
        case 'team.inbox':
          return {
            protocol: 1,
            agent_id: 'worker',
            messages: [
              {
                id: 'm1',
                from: 'owner',
                to: 'worker',
                kind: 'message',
                content: 'hi',
                ts: Date.now(),
              },
            ],
            cursor: 'c1',
          };
        case 'team.status.list':
          return { protocol: 1, agents: [{ id: 'worker', state: 'idle', tool_names: [] }] };
        default:
          throw new Error(`unexpected method: ${request.method}`);
      }
    };
    const host = teamHost({
      providerFactory: () => new MemoryLLMProvider(),
      model: 'test-model',
      transport,
      nodeId: 'nodeA',
    });

    const spawned = JSON.parse(
      await toolOf(host, 'team_spawn').handler({ name: 'worker', node: 'nodeB' }, makeContext()),
    ) as { nodeId?: string };
    expect(spawned.nodeId).toBe('nodeB');

    const page = JSON.parse(
      await toolOf(host, 'team_inbox').handler({ member: 'worker', node: 'nodeB' }, makeContext()),
    ) as { messages: Array<{ nodeId?: string }> };
    expect(page.messages[0]?.nodeId).toBe('nodeB');

    const list = JSON.parse(
      await toolOf(host, 'team_status').handler({ node: 'nodeB' }, makeContext()),
    ) as Array<{ nodeId?: string }>;
    expect(list[0]?.nodeId).toBe('nodeB');
    expect(transport.methods).toEqual(['team.spawn', 'team.inbox', 'team.status.list']);
  });
});
