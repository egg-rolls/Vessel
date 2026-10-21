/**
 * 0.16 `agent` 工具：spawn / send / close、消息不阻塞、成员不串消息、
 * visibility 拒绝、权限桥、legacyTools 开关、close 幂等。
 * 全部进程内、fake Host，不联网。
 */

import { describe, expect, it } from 'bun:test';
import {
  type AgentHandle,
  type AgentMessage,
  type AgentSpec,
  type AgentStatus,
  MemoryEventBus,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  type RunHandle,
  type RuntimeHost,
  type ToolContext,
} from '@vessel-agent/core';
import {
  createTeamPlugin,
  type MemberRecord,
  MemberRegistry,
  type TeamPluginOptions,
} from '../src/index';

/** 轮询等待条件成立 */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** fake 成员 handle：run 挂起，直到测试显式 resolve */
class FakeHandle implements AgentHandle {
  state: AgentStatus['state'] = 'idle';
  closeCalls = 0;
  readonly runs: Array<{ id: string; input: string; resolve: (text: string) => void }> = [];

  constructor(
    readonly id: string,
    private readonly host: FakeHost,
  ) {}

  status(): AgentStatus {
    return { id: this.id, state: this.state, toolNames: [] };
  }

  async run(input: string | { content: string }): Promise<RunHandle> {
    const text = typeof input === 'string' ? input : input.content;
    const runId = `run-${this.id}-${this.runs.length}`;
    this.state = 'running';
    this.host.events.publish({
      type: 'agent.run.started',
      run_id: runId,
      data: { agentId: this.id, runId, sessionId: 'default' },
      ts: Date.now(),
    });
    let resolve!: (text: string) => void;
    const result = new Promise<string>((done) => {
      resolve = done;
    });
    this.runs.push({ id: runId, input: text, resolve });
    return {
      id: runId,
      agentId: this.id,
      sessionId: 'default',
      status: () => 'running',
      result,
      usage: () => undefined,
      cancel: () => undefined,
    };
  }

  async send(): Promise<void> {}
  async inbox() {
    return { messages: [], cursor: '' };
  }
  cancel(): void {}
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
    this.host.handles.delete(this.id);
  }
}

/** fake RuntimeHost：只实现 AgentHandle 生命周期与事件总线 */
class FakeHost implements RuntimeHost {
  readonly events = new MemoryEventBus();
  readonly handles = new Map<string, FakeHandle>();
  readonly spawns: AgentSpec[] = [];
  readonly sent: AgentMessage[] = [];
  readonly scheduler = {} as RuntimeHost['scheduler'];

  async spawn(spec: AgentSpec): Promise<AgentHandle> {
    this.spawns.push(spec);
    const id = spec.id ?? `member-${this.handles.size + 1}`;
    const handle = new FakeHandle(id, this);
    this.handles.set(id, handle);
    return handle;
  }

  get(id: string): AgentHandle | undefined {
    return this.handles.get(id);
  }

  list(): AgentStatus[] {
    return [...this.handles.values()].map((handle) => handle.status());
  }

  async send(message: AgentMessage): Promise<void> {
    this.sent.push(message);
  }

  async inbox() {
    return { messages: [], cursor: '' };
  }

  cancel(): void {}
  async close(): Promise<void> {
    this.handles.clear();
  }

  /** 让挂起的成员 run 完成（触发结果回投） */
  finish(id: string, text: string): void {
    const run = this.handles.get(id)?.runs.at(-1);
    run?.resolve(text);
  }
}

function makeContext(sessionId = 'parent-session'): ToolContext {
  return {
    run_id: 'parent-run',
    session_id: sessionId,
    messages: [],
    events: new MemoryEventStream(),
  };
}

interface Setup {
  host: FakeHost;
  events: MemoryEventStream;
  pluginHost: MemoryPluginHost;
  tool: NonNullable<ReturnType<MemoryPluginHost['getTool']>>;
}

function setup(options: Partial<TeamPluginOptions> = {}): Setup {
  const host = new FakeHost();
  const events = new MemoryEventStream();
  const pluginHost = new MemoryPluginHost();
  createTeamPlugin({
    providerFactory: () => new MemoryLLMProvider(),
    model: 'member-model',
    host,
    events,
    ...options,
  }).install(pluginHost);
  const tool = pluginHost.getTool('agent');
  if (!tool) throw new Error('agent tool not registered');
  return { host, events, pluginHost, tool };
}

function parse<T>(result: string): T {
  return JSON.parse(result) as T;
}

describe('agent spawn/send/close', () => {
  it('spawn 返回 MemberStatus 并记录 owner/visibility/session', async () => {
    const { host, tool } = setup();
    const status = parse<Record<string, unknown>>(
      await tool.handler({ action: 'spawn', name: 'worker', visibility: 'team' }, makeContext()),
    );
    expect(status.state).toBe('idle');
    expect(status.visibility).toBe('team');
    expect(status.parent_id).toBe('owner');
    expect(typeof status.id).toBe('string');
    expect(status.session_id).toBe(status.id);
    expect(host.spawns[0]?.sessionId).toBe(status.id as string);
  });

  it('spawn 默认 private；非法 visibility 拒绝', async () => {
    const { tool } = setup();
    const status = parse<Record<string, unknown>>(
      await tool.handler({ action: 'spawn' }, makeContext()),
    );
    expect(status.visibility).toBe('private');
    const invalid = await tool.handler({ action: 'spawn', visibility: 'public' }, makeContext());
    expect(invalid).toContain('Error');
  });

  it('send 入队即返回，不等待成员 run 完成', async () => {
    const { host, tool } = setup();
    const spawned = parse<{ id: string }>(await tool.handler({ action: 'spawn' }, makeContext()));
    const result = parse<{ queued: boolean; message_id: string }>(
      await tool.handler({ action: 'send', to: spawned.id, content: 'do work' }, makeContext()),
    );
    expect(result.queued).toBe(true);
    expect(result.message_id).not.toBe('');
    // 成员 run 仍挂起，send 已返回
    expect(host.handles.get(spawned.id)?.runs).toHaveLength(1);
    host.finish(spawned.id, 'done');
  });

  it('两个成员各自收消息，结果不串', async () => {
    const { host, events, tool } = setup();
    const a = parse<{ id: string }>(
      await tool.handler({ action: 'spawn', name: 'a' }, makeContext()),
    );
    const b = parse<{ id: string }>(
      await tool.handler({ action: 'spawn', name: 'b' }, makeContext()),
    );
    await tool.handler({ action: 'send', to: a.id, content: 'task-a' }, makeContext());
    await tool.handler({ action: 'send', to: b.id, content: 'task-b' }, makeContext());

    const tasks = host.sent.filter((message) => message.kind === 'task');
    expect(tasks.map((message) => [message.to, message.content])).toEqual([
      [a.id, 'task-a'],
      [b.id, 'task-b'],
    ]);

    host.finish(a.id, 'result-a');
    host.finish(b.id, 'result-b');
    const results = await waitFor(() => {
      const delivered = host.sent.filter((message) => message.kind === 'result');
      return delivered.length === 2 ? delivered : undefined;
    });
    expect(
      results
        .map((message) => [message.from, message.content])
        .sort((x, y) => (x[1] ?? '').localeCompare(y[1] ?? '')),
    ).toEqual([
      [a.id, 'result-a'],
      [b.id, 'result-b'],
    ]);
    expect(
      events.getHistory().filter((event) => event.type === 'agent.message.queued'),
    ).toHaveLength(2);
  });

  it('send 到未知成员报错；到已关闭成员返回 closed', async () => {
    const { tool } = setup();
    expect(
      await tool.handler({ action: 'send', to: 'missing', content: 'x' }, makeContext()),
    ).toContain('unknown team member');
    const spawned = parse<{ id: string }>(await tool.handler({ action: 'spawn' }, makeContext()));
    await tool.handler({ action: 'close', member: spawned.id }, makeContext());
    expect(
      await tool.handler({ action: 'send', to: spawned.id, content: 'x' }, makeContext()),
    ).toContain('member closed');
  });

  it('close 幂等，只释放一次', async () => {
    const { host, tool } = setup();
    const spawned = parse<{ id: string }>(await tool.handler({ action: 'spawn' }, makeContext()));
    const handle = host.handles.get(spawned.id) as FakeHandle;
    const first = parse<{ state: string }>(
      await tool.handler({ action: 'close', member: spawned.id }, makeContext()),
    );
    const second = parse<{ state: string }>(
      await tool.handler({ action: 'close', member: spawned.id }, makeContext()),
    );
    expect(first.state).toBe('closed');
    expect(second.state).toBe('closed');
    expect(handle.closeCalls).toBe(1);
  });
});

describe('member visibility / tenant 寻址', () => {
  function record(overrides: Partial<MemberRecord>): MemberRecord {
    return {
      id: 'm1',
      sessionId: 's1',
      owner: 'owner',
      visibility: 'private',
      permissionMode: 'bridge',
      state: 'idle',
      ...overrides,
    };
  }

  it('private 仅 owner 可寻址；team 同 tenant 可见；跨 tenant 不可见', () => {
    const registry = new MemberRegistry('tenant-a');
    expect(registry.canAddress(record({ tenantId: 'tenant-a' }), 'owner')).toBe(true);
    expect(registry.canAddress(record({ tenantId: 'tenant-a' }), 'stranger')).toBe(false);
    expect(
      registry.canAddress(record({ tenantId: 'tenant-a', visibility: 'team' }), 'stranger'),
    ).toBe(true);
    expect(registry.canAddress(record({ tenantId: 'tenant-b', visibility: 'team' }), 'owner')).toBe(
      false,
    );
  });

  it('waiting_permission 状态带 current_tool', () => {
    const registry = new MemberRegistry();
    registry.add(record({}));
    registry.setState('m1', 'waiting_permission', 'bash');
    expect(registry.get('m1')).toMatchObject({
      state: 'waiting_permission',
      currentTool: 'bash',
    });
  });
});

describe('权限桥', () => {
  it('bridge 请求补关联字段，应答回灌 Host 聚合流', async () => {
    const { host, events, tool } = setup();
    const spawned = parse<{ id: string }>(await tool.handler({ action: 'spawn' }, makeContext()));

    host.events.publish({
      type: 'tool.permission.request',
      run_id: 'member-run',
      data: {
        requestId: 'req-1',
        tool: 'bash',
        input: { command: 'ls' },
        session_id: 'member-session',
        tool_call_id: 'call-1',
        source: 'runtime',
        agentId: spawned.id,
      },
      ts: Date.now(),
    });

    const forwarded = await waitFor(() =>
      events.getHistory().find((event) => event.type === 'tool.permission.request'),
    );
    expect(forwarded.data).toMatchObject({
      request_id: 'req-1',
      agent_id: spawned.id,
      session_id: 'member-session',
      parent_session_id: 'parent-session',
      tool_call_id: 'call-1',
      delegate_path: ['owner', spawned.id],
      state: 'waiting_permission',
    });
    const requested = events
      .getHistory()
      .find((event) => event.type === 'agent.permission.requested');
    expect(requested?.data).toMatchObject({ agent_id: spawned.id, tool: 'bash' });

    events.publish({
      type: 'tool.permission.response',
      run_id: 'member-run',
      data: { requestId: 'req-1', decision: 'allow' },
      ts: Date.now(),
    });
    const routed = await waitFor(() =>
      host.events.getHistory().find((event) => event.type === 'tool.permission.response'),
    );
    expect(routed.data).toMatchObject({ requestId: 'req-1' });
    expect(
      events
        .getHistory()
        .some(
          (event) =>
            event.type === 'agent.permission.responded' &&
            (event.data as Record<string, unknown>).agent_id === spawned.id,
        ),
    ).toBe(true);
  });

  it('allow 模式的成员不桥接权限请求', async () => {
    const { host, events, tool } = setup({ permissionMode: 'allow' });
    const spawned = parse<{ id: string }>(await tool.handler({ action: 'spawn' }, makeContext()));
    host.events.publish({
      type: 'tool.permission.request',
      run_id: 'member-run',
      data: { requestId: 'req-2', tool: 'bash', agentId: spawned.id },
      ts: Date.now(),
    });
    expect(events.getHistory().some((event) => event.type === 'tool.permission.request')).toBe(
      false,
    );
  });
});

describe('legacyTools 开关', () => {
  it('默认同时注册 agent 与 5 个 team_*', () => {
    const { pluginHost } = setup();
    expect(
      pluginHost
        .listTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['agent', 'team_cancel', 'team_inbox', 'team_send', 'team_spawn', 'team_status']);
  });

  it('legacyTools=false 时只有 agent', () => {
    const { pluginHost } = setup({ legacyTools: false });
    expect(pluginHost.listTools().map((tool) => tool.name)).toEqual(['agent']);
  });

  it('成员工具面不含 agent（不能 spawn 兄弟）', async () => {
    const { host, tool } = setup();
    await tool.handler({ action: 'spawn' }, makeContext());
    const childHost = host.spawns[0]?.pluginHost;
    expect(childHost?.getTool('agent')).toBeUndefined();
  });
});
