/**
 * 0.15 E8：delegate 事件关联字段、嵌套 opt-in、result_ref。
 *
 * 故障形状：
 * - 事件缺 tool_call_id/parent_session_id/delegate_path → UI 无法把子事件挂到正确的工具卡/会话；
 * - 嵌套事件二次加前缀（subagent.subagent.*）→ 消费方按前缀过滤时丢失整棵子树；
 * - allow_nested 默认放开 / 后代上限失效 → 指数扇出；
 * - completed 只有文本没有 result_ref → 事后无法指回 child run。
 */

import { describe, expect, it } from 'bun:test';
import {
  type AgentHandle,
  AgentRuntime,
  type AgentSpec,
  type LLMProvider,
  MemoryContextManager,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  type RunEvent,
  type RuntimeHost,
  type ToolContext,
} from '@vessel-agent/core';
import { createDelegateTaskPlugin } from '../src/index';

/** 构造一次 tool_calls 响应（参数 JSON 化） */
function toolCallResponse(callId: string, name: string, args: Record<string, unknown>) {
  return {
    content: '',
    finish_reason: 'tool_calls' as const,
    tool_calls: [
      {
        id: callId,
        type: 'function' as const,
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

/** 按类型取事件 data */
function dataOf(event: RunEvent | undefined): Record<string, unknown> {
  const data = event?.data;
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}

/** 建一个父 runtime（delegate 插件装到 host 上） */
async function makeRuntime(
  provider: LLMProvider,
  events: MemoryEventStream,
  options: Parameters<typeof createDelegateTaskPlugin>[0],
): Promise<AgentRuntime> {
  const host = new MemoryPluginHost();
  host.registerTool({
    name: 'echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => 'echo-ok',
  });
  return AgentRuntime.create({
    provider,
    model: 'test-model',
    pluginHost: host,
    context: new MemoryContextManager(),
    events,
    limits: {},
    termination: { maxIterations: 10 },
    plugins: [createDelegateTaskPlugin(options)],
  });
}

/** 所有 delegate_path 长度达到 n 的 started 事件 */
function startedAtDepth(events: RunEvent[], n: number): RunEvent[] {
  return events.filter((event) => {
    if (event.type !== 'subagent.delegate.started') return false;
    const path = dataOf(event).delegate_path;
    return Array.isArray(path) && path.length === n;
  });
}

describe('delegate 事件关联字段（E8）', () => {
  it('delegate.started / 转发事件缺 tool_call_id 或 parent_session_id 时无法归属', async () => {
    const provider = new MemoryLLMProvider();
    provider.setResponse(
      'ROOT_FIELDS',
      toolCallResponse('tc-root-fields', 'delegate_task', { task: 'CHILD_FIELDS' }),
    );
    provider.setResponse('CHILD_FIELDS', {
      content: 'child answer',
      finish_reason: 'stop',
    });

    const events = new MemoryEventStream();
    const runtime = await makeRuntime(provider, events, {
      providerFactory: () => provider,
      model: 'test-model',
    });
    await runtime.run('ROOT_FIELDS', 'parent-sess');

    const history = events.getHistory();
    const started = history.find((event) => event.type === 'subagent.delegate.started');
    const completed = history.find((event) => event.type === 'subagent.delegate.completed');
    const forwarded = history.find((event) => event.type === 'subagent.run.started');
    if (!started || !completed || !forwarded) throw new Error('delegate events missing');

    const startedData = dataOf(started);
    const delegateId = startedData.delegateId;
    expect(startedData.tool_call_id).toBe('tc-root-fields');
    expect(startedData.parent_session_id).toBe('parent-sess');
    expect(startedData.delegate_path).toEqual([delegateId]);
    expect('parent_delegate_id' in startedData).toBe(false);

    const completedData = dataOf(completed);
    expect(completedData.tool_call_id).toBe('tc-root-fields');
    expect(completedData.parent_session_id).toBe('parent-sess');
    expect(completedData.delegate_path).toEqual([delegateId]);

    // 转发事件同样带关联字段，且保持原 run_id（child run）
    const forwardedData = dataOf(forwarded);
    expect(forwardedData.delegateId).toBe(delegateId);
    expect(forwardedData.tool_call_id).toBe('tc-root-fields');
    expect(forwardedData.parent_session_id).toBe('parent-sess');
    expect(forwardedData.delegate_path).toEqual([delegateId]);
  });

  it('delegate.completed 缺 result_ref 时无法从结果指回 child run', async () => {
    const provider = new MemoryLLMProvider();
    provider.setResponse(
      'ROOT_REF',
      toolCallResponse('tc-root-ref', 'delegate_task', { task: 'CHILD_REF' }),
    );
    provider.setResponse('CHILD_REF', { content: 'child answer', finish_reason: 'stop' });

    const events = new MemoryEventStream();
    const runtime = await makeRuntime(provider, events, {
      providerFactory: () => provider,
      model: 'test-model',
    });
    await runtime.run('ROOT_REF');

    const history = events.getHistory();
    const completed = history.find((event) => event.type === 'subagent.delegate.completed');
    const childRun = history.find((event) => event.type === 'subagent.run.started');
    if (!completed || !childRun) throw new Error('delegate events missing');

    const ref = dataOf(completed).result_ref as Record<string, unknown> | undefined;
    expect(ref?.kind).toBe('run');
    expect(ref?.id).toBe(childRun.run_id);
  });
});

describe('孙 agent opt-in（allow_nested）', () => {
  it('默认禁止孙 agent：child 看不到 delegate_task', async () => {
    const provider = new MemoryLLMProvider();
    provider.setResponse(
      'ROOT_CLOSED',
      toolCallResponse('p1', 'delegate_task', { task: 'CHILD_CLOSED' }),
    );
    provider.setResponse(
      'CHILD_CLOSED',
      toolCallResponse('c1', 'delegate_task', { task: 'GRANDCHILD' }),
    );

    const events = new MemoryEventStream();
    const runtime = await makeRuntime(provider, events, {
      providerFactory: () => provider,
      model: 'test-model',
    });
    const result = await runtime.run('ROOT_CLOSED');

    expect(result).toContain('not found');
    expect(startedAtDepth(events.getHistory(), 2)).toHaveLength(0);
  });

  it('allow_nested 开启后孙 agent 可用，事件只有单层 subagent. 前缀与完整 path', async () => {
    const provider = new MemoryLLMProvider();
    provider.setResponse(
      'ROOT_NEST',
      toolCallResponse('tc-root-nest', 'delegate_task', { task: 'CHILD_A' }),
    );
    provider.setResponse(
      'CHILD_A',
      toolCallResponse('tc-child-a', 'delegate_task', { task: 'CHILD_B' }),
    );
    provider.setResponse('CHILD_B', { content: 'grandchild done', finish_reason: 'stop' });

    const events = new MemoryEventStream();
    const runtime = await makeRuntime(provider, events, {
      providerFactory: () => provider,
      model: 'test-model',
      allowNested: true,
    });
    const result = await runtime.run('ROOT_NEST', 'parent-sess');
    expect(result).toContain('grandchild done');

    const history = events.getHistory();
    const level1 = startedAtDepth(history, 1);
    const level2 = startedAtDepth(history, 2);
    expect(level1).toHaveLength(1);
    expect(level2).toHaveLength(1);

    const aId = dataOf(level1[0]).delegateId;
    const nestedData = dataOf(level2[0]);
    expect(nestedData.parent_delegate_id).toBe(aId);
    expect(nestedData.delegate_path).toEqual([aId, nestedData.delegateId]);
    expect(nestedData.tool_call_id).toBe('tc-child-a');
    expect(nestedData.parent_session_id).toBe('parent-sess');

    // 嵌套转发事件保持单层前缀，且带两层 path
    expect(history.some((event) => event.type.startsWith('subagent.subagent.'))).toBe(false);
    const nestedRunStarted = history.find(
      (event) =>
        event.type === 'subagent.run.started' &&
        Array.isArray(dataOf(event).delegate_path) &&
        (dataOf(event).delegate_path as unknown[]).length === 2,
    );
    expect(nestedRunStarted).toBeDefined();
    expect(dataOf(nestedRunStarted).delegateId).toBe(nestedData.delegateId);
  });

  it('max_depth 对孙 agent 仍生效', async () => {
    const provider = new MemoryLLMProvider();
    provider.setResponse(
      'ROOT_DEPTH',
      toolCallResponse('t1', 'delegate_task', { task: 'DEPTH_A' }),
    );
    provider.setResponse('DEPTH_A', toolCallResponse('t2', 'delegate_task', { task: 'DEPTH_B' }));
    provider.setResponse('DEPTH_B', toolCallResponse('t3', 'delegate_task', { task: 'DEPTH_C' }));

    const events = new MemoryEventStream();
    const runtime = await makeRuntime(provider, events, {
      providerFactory: () => provider,
      model: 'test-model',
      allowNested: true,
      maxDepth: 2,
    });
    const result = await runtime.run('ROOT_DEPTH');
    expect(result).toContain('depth exceeded');
    expect(startedAtDepth(events.getHistory(), 3)).toHaveLength(0);
  });

  it('max_descendants 按根树计数，超过后不再 spawn', async () => {
    const provider = new MemoryLLMProvider();
    provider.setResponse('ROOT_DESC', toolCallResponse('d1', 'delegate_task', { task: 'DESC_A' }));
    provider.setResponse('DESC_A', toolCallResponse('d2', 'delegate_task', { task: 'DESC_B' }));
    provider.setResponse('DESC_B', toolCallResponse('d3', 'delegate_task', { task: 'DESC_C' }));

    const events = new MemoryEventStream();
    const runtime = await makeRuntime(provider, events, {
      providerFactory: () => provider,
      model: 'test-model',
      allowNested: true,
      maxDepth: 5,
      maxDescendants: 1,
    });
    const result = await runtime.run('ROOT_DESC');
    expect(result).toContain('descendants exceeded');
    expect(startedAtDepth(events.getHistory(), 3)).toHaveLength(0);
  });
});

describe('bridge 交互事件', () => {
  it('子 agent 的权限请求缺少 delegate_path 时会被挂到错误节点', async () => {
    const provider = new MemoryLLMProvider();
    provider.setResponse(
      'ROOT_BRIDGE',
      toolCallResponse('tc-root-bridge', 'delegate_task', { task: 'CHILD_BRIDGE' }),
    );
    provider.setResponse('CHILD_BRIDGE', toolCallResponse('tc-child-bridge', 'needs_perm', {}));

    const host = new MemoryPluginHost();
    host.registerTool({
      name: 'needs_perm',
      description: 'needs permission',
      inputSchema: { type: 'object', properties: {} },
      checkPermission: async (_input: unknown, ctx: ToolContext) => {
        const requestId = 'req-bridge-1';
        ctx.events.publish({
          type: 'tool.permission.request',
          run_id: ctx.run_id,
          data: { requestId, tool: 'needs_perm' },
          ts: Date.now(),
        });
        const response = (await ctx.events.waitFor('tool.permission.response', {
          requestId,
          timeout: 5000,
        })) as { decision?: 'allow' | 'deny' } | undefined;
        return response?.decision ?? 'deny';
      },
      handler: async () => 'granted-result',
    });

    const events = new MemoryEventStream();
    let bridgeData: Record<string, unknown> | undefined;
    events.subscribe((event) => {
      if (event.type !== 'tool.permission.request') return;
      bridgeData = dataOf(event);
      events.publish({
        type: 'tool.permission.response',
        run_id: event.run_id,
        data: { requestId: bridgeData.requestId, decision: 'allow' },
        ts: Date.now(),
      });
    });

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost: host,
      context: new MemoryContextManager(),
      events,
      limits: {},
      termination: { maxIterations: 10 },
      plugins: [
        createDelegateTaskPlugin({
          providerFactory: () => provider,
          model: 'test-model',
        }),
      ],
    });
    const result = await runtime.run('ROOT_BRIDGE', 'parent-sess');
    expect(result).toContain('granted-result');

    const started = events.getHistory().find((event) => event.type === 'subagent.delegate.started');
    expect(bridgeData?.delegate_path).toEqual([dataOf(started).delegateId]);
    expect(bridgeData?.parent_session_id).toBe('parent-sess');
    expect(bridgeData?.tool_call_id).toBe('tc-root-bridge');
  });
});

/** 假 Host：run.result 立即失败，用于验证 failed 事件的 result_ref */
function createFailingHost(): RuntimeHost {
  const events = new MemoryEventStream();
  const host = {
    events,
    scheduler: {},
    spawn: async (spec: AgentSpec) => {
      const id = spec.id ?? 'child';
      return {
        id,
        name: spec.name,
        status: () => ({ id, state: 'idle', toolNames: [] }),
        run: async () => ({
          id: 'child-run-failed',
          agentId: id,
          sessionId: 'default',
          status: () => 'running',
          result: Promise.reject(new Error('child exploded')),
          usage: () => undefined,
          cancel: () => undefined,
        }),
        send: async () => undefined,
        inbox: async () => ({ messages: [], cursor: '' }),
        cancel: () => undefined,
        close: async () => undefined,
      } as unknown as AgentHandle;
    },
    get: () => undefined,
    list: () => [],
    send: async () => undefined,
    inbox: async () => ({ messages: [], cursor: '' }),
    cancel: () => undefined,
    close: async () => undefined,
  } as unknown as RuntimeHost;
  return host;
}

describe('delegate.failed', () => {
  it('child 失败时 failed 事件仍用 result_ref 指回 child run', async () => {
    const parentHost = new MemoryPluginHost();
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => new MemoryLLMProvider(),
      model: 'test-model',
      runtimeHost: createFailingHost(),
    });
    plugin.install(parentHost);
    const tool = parentHost.getTool('delegate_task');
    if (!tool) throw new Error('delegate_task not registered');

    const events = new MemoryEventStream();
    const ctx: ToolContext = { run_id: 'parent-run', messages: [], events };
    await expect(tool.handler({ task: 'fail' }, ctx)).rejects.toThrow('child exploded');

    const failed = events.getHistory().find((event) => event.type === 'subagent.delegate.failed');
    const ref = dataOf(failed).result_ref as Record<string, unknown> | undefined;
    expect(ref?.kind).toBe('run');
    expect(ref?.id).toBe('child-run-failed');
  });
});
