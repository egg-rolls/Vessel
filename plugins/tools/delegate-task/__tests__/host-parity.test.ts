/**
 * R5 协作 parity：delegate_task 从「工具 handler 内 spawn」切到 core Host 临时成员时，
 * 以下语义必须保持不变（DECISION-003 A6 / DECISION-004）。
 *
 * 这套测试只依赖外部行为：真实 AgentRuntime、真实工具调用与事件流；
 * 不 mock 运行时、不读 delegate 内部状态。当前旧路径与 R5 Host 路径都应通过。
 * 唯一例外：父取消传播在 ToolContext.signal 落地前不可测，标 todo。
 */

import { describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  type ChatRequest,
  InProcessRuntimeHost as CoreInProcessRuntimeHost,
  GuardrailStage,
  type LLMProvider,
  type LLMResponse,
  MemoryContextManager,
  MemoryEventBus,
  MemoryEventStream,
  MemoryPluginHost,
  type Message,
  type Plugin,
  type ToolContext,
  type Usage,
} from '@vessel-agent/core';
import { createDelegateTaskPlugin, type DelegateTaskOptions } from '../src/index';

/** 按顺序返回预设响应并记录请求消息的 provider */
class RecordingProvider implements LLMProvider {
  readonly requests: Message[][] = [];
  private index = 0;

  constructor(private readonly responses: LLMResponse[]) {}

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.requests.push(structuredClone(req.messages));
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) throw new Error(`no preset response for call ${this.index}`);
    return response;
  }
}

/** tool_calls 响应 */
function call(callId: string, name: string, args: Record<string, unknown>): LLMResponse {
  return {
    content: '',
    finish_reason: 'tool_calls',
    tool_calls: [
      {
        id: callId,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

/** 文本响应 */
function final(content: string, usage?: Usage): LLMResponse {
  return {
    content,
    finish_reason: 'stop',
    ...(usage !== undefined ? { usage } : {}),
  };
}

/** delegate_task 调用响应 */
function delegate(callId: string, task: string): LLMResponse {
  return call(callId, 'delegate_task', { task });
}

/** 注册 echo 工具 */
function registerEcho(host: MemoryPluginHost): void {
  host.registerTool({
    name: 'echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => 'echo-ok',
  });
}

/** 注册任意工具 */
function registerTool(host: MemoryPluginHost, name: string, result = `${name}-result`): void {
  host.registerTool({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => result,
  });
}

interface ScenarioOptions {
  responses: LLMResponse[];
  input: string;
  pluginOptions?: Partial<DelegateTaskOptions>;
  setupHost?: (host: MemoryPluginHost) => void;
  events?: MemoryEventStream;
}

interface ScenarioResult {
  provider: RecordingProvider;
  events: MemoryEventStream;
  host: MemoryPluginHost;
  result: string;
}

/** 跑一次父 runtime + delegate_task */
async function runScenario(options: ScenarioOptions): Promise<ScenarioResult> {
  const provider = new RecordingProvider(options.responses);
  const events = options.events ?? new MemoryEventStream();
  const host = new MemoryPluginHost();
  options.setupHost?.(host);

  const plugin: Plugin = createDelegateTaskPlugin({
    providerFactory: () => provider,
    model: 'test-model',
    ...options.pluginOptions,
  });

  const runtime = await AgentRuntime.create({
    provider,
    model: 'test-model',
    pluginHost: host,
    context: new MemoryContextManager(),
    events,
    limits: {},
    termination: { maxIterations: 10 },
    plugins: [plugin],
  });

  const result = await runtime.run(options.input);
  return { provider, events, host, result };
}

/** 取一条请求里最后一条 tool 消息内容 */
function lastToolContent(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'tool') return message.content;
  }
  return '';
}

describe('R5 parity：delegate_task 外部语义', () => {
  it('P1 递归深度上限', async () => {
    const scenario = await runScenario({
      input: 'PARENT_DEPTH',
      pluginOptions: { maxDepth: 1, disallowed: [] },
      responses: [
        delegate('p1', 'CHILD_L1'),
        delegate('c1', 'CHILD_L2'),
        final('child saw depth exceeded'),
        final('parent done'),
      ],
    });

    expect(scenario.result).toBe('parent done');
    // 子 agent 第二次请求里的 tool 结果应包含深度错误
    const childSecond = scenario.provider.requests[2] ?? [];
    expect(lastToolContent(childSecond)).toContain('depth exceeded');
  });

  it('P2 默认工具白名单排除 delegate_task', async () => {
    const scenario = await runScenario({
      input: 'PARENT_WL',
      responses: [
        delegate('p1', 'CHILD_WL'),
        delegate('c1', 'CHILD_WL_2'),
        final('child done'),
        final('parent done'),
      ],
    });

    const childSecond = scenario.provider.requests[2] ?? [];
    expect(lastToolContent(childSecond)).toContain('not found');
  });

  it('P3 子 agent 继承 guardrail', async () => {
    const scenario = await runScenario({
      input: 'PARENT_GUARD',
      setupHost(host) {
        registerTool(host, 'forbidden');
        host.registerGuardrail({
          name: 'deny-forbidden',
          stage: GuardrailStage.ToolCall,
          check: async (value) => {
            const name =
              typeof value === 'object' && value !== null
                ? ((value as { function?: { name?: string } }).function?.name ?? '')
                : '';
            return name === 'forbidden'
              ? { allowed: false, reason: 'forbidden tool blocked' }
              : { allowed: true };
          },
        });
      },
      responses: [
        delegate('p1', 'CHILD_GUARD'),
        call('c1', 'forbidden', {}),
        // 新语义：阻断折回后 child 多一轮 LLM 调用
        final('child saw blocked by guardrail'),
        final('parent done'),
      ],
    });

    // child 第二轮请求应看到折回的 guardrail 错误
    const childSecond = scenario.provider.requests[2] ?? [];
    expect(lastToolContent(childSecond)).toContain('blocked by guardrail');

    // child 的最终文本经 delegate 结果回到 parent 第二轮请求
    const parentSecond = scenario.provider.requests[3] ?? [];
    expect(lastToolContent(parentSecond)).toContain('blocked by guardrail');
    expect(scenario.result).toBe('parent done');
  });

  it('P8 subagent. 前缀与 delegateId', async () => {
    const scenario = await runScenario({
      input: 'PARENT_EVENTS',
      responses: [delegate('p1', 'CHILD_EVENTS'), final('child done'), final('parent done')],
    });

    const history = scenario.events.getHistory();
    const types = history.map((event) => event.type);
    expect(types).toContain('subagent.delegate.started');
    expect(types).toContain('subagent.delegate.completed');
    expect(types).toContain('subagent.run.started');
    expect(types).toContain('subagent.run.completed');

    const started = history.find((event) => event.type === 'subagent.delegate.started');
    const completed = history.find((event) => event.type === 'subagent.delegate.completed');
    const startedId = (started?.data as Record<string, unknown> | undefined)?.delegateId;
    const completedId = (completed?.data as Record<string, unknown> | undefined)?.delegateId;
    expect(typeof startedId).toBe('string');
    expect(completedId).toBe(startedId);
  });

  it('P9 结果/上下文隔离：父上下文只有最终文本', async () => {
    const scenario = await runScenario({
      input: 'PARENT_ISO',
      setupHost: registerEcho,
      responses: [
        delegate('p1', 'CHILD_ISO'),
        { ...call('c1', 'echo', {}), content: 'CHILD_INTERMEDIATE' },
        final('child done'),
        final('parent done'),
      ],
    });

    const parentSecond = scenario.provider.requests[3] ?? [];
    expect(parentSecond.some((message) => message.content.includes('CHILD_INTERMEDIATE'))).toBe(
      false,
    );
    expect(lastToolContent(parentSecond)).toBe('child done');
  });

  it('P12 临时成员不残留（Host 事件配对）', async () => {
    const scenario = await runScenario({
      input: 'PARENT_EPHEMERAL',
      responses: [delegate('p1', 'CHILD_EPHEMERAL'), final('child done'), final('parent done')],
    });

    // 旧路径不产生 agent.spawned/agent.closed（0=0）；R5 切 Host 后应成对出现。
    const history = scenario.events.getHistory();
    const spawned = history.filter((event) => event.type === 'agent.spawned').length;
    const closed = history.filter((event) => event.type === 'agent.closed').length;
    expect(closed).toBe(spawned);
  });

  it('P11 父取消传播：父 run abort 会取消子 RunHandle', async () => {
    let markChildStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });

    const provider: LLMProvider = {
      async chat(req: ChatRequest): Promise<LLMResponse> {
        const user = [...req.messages].reverse().find((message) => message.role === 'user');
        if ((user?.content ?? '').includes('PARENT_CANCEL')) {
          return delegate('p1', 'CHILD_CANCEL');
        }
        markChildStarted();
        return new Promise((_resolve, reject) => {
          if (req.signal?.aborted) {
            reject(new Error('child aborted'));
            return;
          }
          req.signal?.addEventListener('abort', () => reject(new Error('child aborted')), {
            once: true,
          });
        });
      },
    };

    const events = new MemoryEventStream();
    const host = new MemoryPluginHost();
    const runtimeHost = new CoreInProcessRuntimeHost();
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => provider,
      model: 'test-model',
      runtimeHost,
    });
    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost: host,
      context: new MemoryContextManager(),
      events,
      limits: {},
      termination: { maxIterations: 10 },
      plugins: [plugin],
    });

    const controller = new AbortController();
    const runPromise = runtime.run('PARENT_CANCEL', undefined, { signal: controller.signal });
    await childStarted;
    controller.abort();

    await expect(runPromise).rejects.toThrow();
    expect(events.getHistory().some((event) => event.type === 'subagent.delegate.failed')).toBe(
      true,
    );

    // 临时成员完成后不残留
    expect(runtimeHost.list()).toEqual([]);
    const history = events.getHistory();
    expect(history.filter((event) => event.type === 'agent.closed').length).toBe(
      history.filter((event) => event.type === 'agent.spawned').length,
    );
  });

  it('F12 注入共享 Host（sameStream）时子事件仍有 subagent. 前缀与 delegateId', async () => {
    const bus = new MemoryEventBus();
    const runtimeHost = new CoreInProcessRuntimeHost({ events: bus });
    const provider = new RecordingProvider([
      delegate('p1', 'CHILD_SHARED'),
      final('child done'),
      final('parent done'),
    ]);
    const host = new MemoryPluginHost();
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => provider,
      model: 'test-model',
      runtimeHost,
    });
    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost: host,
      context: new MemoryContextManager(),
      events: bus,
      limits: {},
      termination: { maxIterations: 10 },
      plugins: [plugin],
    });

    await runtime.run('PARENT_SHARED');

    const history = bus.getHistory();
    const forwarded = history.find((event) => event.type === 'subagent.run.started');
    if (!forwarded) throw new Error('subagent.run.started not forwarded');
    expect((forwarded.data as Record<string, unknown>).delegateId).toBeDefined();

    // 不应出现 subagent.subagent.* 回环
    expect(history.some((event) => event.type.startsWith('subagent.subagent.'))).toBe(false);
    // 生命周期事件已在共享流里，不应重复
    expect(history.filter((event) => event.type === 'agent.spawned')).toHaveLength(1);
  });

  it('F13 ask_user 桥：子 ask.user.requested 到父流，应答回灌', async () => {
    const events = new MemoryEventStream();
    events.subscribe((event) => {
      if (event.type !== 'ask.user.requested') return;
      if (typeof event.data !== 'object' || event.data === null) return;
      events.publish({
        type: 'ask.user.answered',
        run_id: event.run_id,
        data: {
          requestId: (event.data as Record<string, unknown>).requestId,
          answers: [{ question_id: 'q1', answer: 'yes' }],
        },
        ts: Date.now(),
      });
    });

    const scenario = await runScenario({
      events,
      input: 'PARENT_ASK',
      setupHost(host) {
        host.registerTool({
          name: 'asks_user',
          description: 'asks user',
          inputSchema: { type: 'object', properties: {} },
          handler: async (_args: unknown, ctx: ToolContext) => {
            const requestId = 'ask-1';
            ctx.events.publish({
              type: 'ask.user.requested',
              run_id: ctx.run_id,
              data: { requestId, questions: [{ id: 'q1', text: 'ok?' }] },
              ts: Date.now(),
            });
            const answer = await ctx.events.waitFor('ask.user.answered', {
              requestId,
              timeout: 5000,
            });
            return `answered:${JSON.stringify(answer)}`;
          },
        });
      },
      responses: [
        delegate('p1', 'CHILD_ASK'),
        call('c1', 'asks_user', {}),
        final('child done'),
        final('parent done'),
      ],
    });

    const childSecond = scenario.provider.requests[2] ?? [];
    expect(lastToolContent(childSecond)).toContain('answered:');
  });
});
