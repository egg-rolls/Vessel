import { describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  type AgentRuntimeOptions,
  type ChatRequest,
  type Guardrail,
  GuardrailStage,
  type Hook,
  HookType,
  type LLMProvider,
  type LLMResponse,
  type Logger,
  MemoryEventStream,
  MemoryPluginHost,
  type RunEvent,
  type ToolDefinition,
} from '@vessel-agent/core';
import {
  type AgentMessage,
  createInProcessMemberRuntime,
  type InProcessMemberRuntimeOptions,
  type MemberRuntimeMember,
} from '../src/index.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function member(overrides: Partial<MemberRuntimeMember> = {}): MemberRuntimeMember {
  return {
    id: 'm1',
    session_id: 'm1',
    owner: 'main',
    visibility: 'private',
    ...overrides,
  };
}

function message(content: string, to = 'm1'): AgentMessage {
  return { id: `msg-${content}`, from: 'main', to, content, ts: 0 };
}

function makeTool(name: string, decision: 'allow' | 'deny' | 'ask' = 'allow'): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    checkPermission: async () => decision,
    handler: async () => `${name}:ok`,
  };
}

function makeHost(tools: ToolDefinition[]): MemoryPluginHost {
  const host = new MemoryPluginHost();
  for (const tool of tools) host.registerTool(tool);
  return host;
}

/** 每个成员一个回显 provider；records[i] 是第 i 个 spawn 的成员收到的请求 */
function echoProviders(): {
  records: ChatRequest[][];
  providerFactory: () => LLMProvider;
} {
  const records: ChatRequest[][] = [];
  return {
    records,
    providerFactory: () => {
      const requests: ChatRequest[] = [];
      records.push(requests);
      return {
        async chat(req) {
          requests.push(req);
          const lastUser = [...req.messages].reverse().find((entry) => entry.role === 'user');
          const response: LLMResponse = {
            content: `echo:${lastUser?.content ?? ''}`,
            finish_reason: 'stop',
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          };
          return response;
        },
      };
    },
  };
}

/** 捕获传给 AgentRuntime 的 options，并交给真实 runtime 执行 */
function capturingRuntimeFactory(
  captured: AgentRuntimeOptions[],
): (options: AgentRuntimeOptions) => Promise<AgentRuntime> {
  return async (options) => {
    captured.push(options);
    return AgentRuntime.create(options);
  };
}

function makeRuntime(
  options: Partial<InProcessMemberRuntimeOptions> = {},
): ReturnType<typeof createInProcessMemberRuntime> {
  const { providerFactory } = echoProviders();
  return createInProcessMemberRuntime({
    providerFactory,
    model: 'default-model',
    pluginHost: makeHost([makeTool('bash'), makeTool('read'), makeTool('edit')]),
    ...options,
  });
}

describe('InProcessMemberRuntime', () => {
  it('runTurn returns the final text and usage of the completed run', async () => {
    const runtime = makeRuntime();
    const target = member();
    await runtime.spawn(target);

    const result = await runtime.runTurn(target, message('hello'));

    expect(result.content).toBe('echo:hello');
    expect(result.outcome).toBe('completed');
    expect(result.usage?.total_tokens).toBe(7);
  });

  it('two members keep separate context histories', async () => {
    const { records, providerFactory } = echoProviders();
    const runtime = createInProcessMemberRuntime({
      providerFactory,
      model: 'default-model',
      pluginHost: makeHost([makeTool('read')]),
    });
    const first = member({ id: 'a', session_id: 'a' });
    const second = member({ id: 'b', session_id: 'b' });
    await runtime.spawn(first);
    await runtime.spawn(second);

    await runtime.runTurn(first, message('alpha', 'a'));
    await runtime.runTurn(second, message('beta', 'b'));
    await runtime.runTurn(first, message('gamma', 'a'));

    const firstHistory = (records[0]?.[1]?.messages ?? []).map((entry) => entry.content);
    const secondHistory = (records[1]?.[0]?.messages ?? []).map((entry) => entry.content);
    expect(firstHistory.some((content) => content.includes('alpha'))).toBe(true);
    expect(firstHistory.some((content) => content.includes('beta'))).toBe(false);
    expect(secondHistory.some((content) => content.includes('beta'))).toBe(true);
    expect(secondHistory.some((content) => content.includes('alpha'))).toBe(false);
  });

  it('spawns the same member id on two Bodies and addresses each by session', async () => {
    const runtime = makeRuntime();
    const oldBody = member({ id: 'm1', session_id: 'body-old' });
    const newBody = member({ id: 'm1', session_id: 'body-new' });
    await runtime.spawn(oldBody);
    await runtime.spawn(newBody);

    expect((await runtime.runTurn(oldBody, message('alpha', 'body-old'))).content).toBe(
      'echo:alpha',
    );
    expect((await runtime.runTurn(newBody, message('beta', 'body-new'))).content).toBe('echo:beta');

    await runtime.dispose(oldBody);
    await expect(runtime.runTurn(oldBody, message('late', 'body-old'))).rejects.toThrow(
      /not spawned/,
    );
    expect((await runtime.runTurn(newBody, message('gamma', 'body-new'))).content).toBe(
      'echo:gamma',
    );
  });

  it('forwards only agent.limit.warning to onMemberEvent with the Body session', async () => {
    const captured: AgentRuntimeOptions[] = [];
    const calls: Array<{ memberId: string; sessionId: string; type: string }> = [];
    const runtime = makeRuntime({
      runtimeFactory: capturingRuntimeFactory(captured),
      onMemberEvent: (memberId, sessionId, event) => {
        calls.push({ memberId, sessionId, type: event.type });
      },
    });
    await runtime.spawn(member({ id: 'm1', session_id: 'body-a' }));

    const events = captured[0]?.events;
    if (!events) throw new Error('spawn did not capture an event stream');
    events.publish({ type: 'run.completed', run_id: 'r1', data: {}, ts: 1 });
    events.publish({ type: 'agent.limit.warning', run_id: 'r1', data: {}, ts: 2 });

    expect(calls).toEqual([{ memberId: 'm1', sessionId: 'body-a', type: 'agent.limit.warning' }]);
  });

  it('member runtime hides team_* and delegate_task but can expose agent', async () => {
    const captured: AgentRuntimeOptions[] = [];
    const names = ['bash', 'read', 'edit', 'agent', 'team_spawn', 'delegate_task', 'ask_user'];
    const runtime = makeRuntime({
      pluginHost: makeHost(names.map((name) => makeTool(name))),
      extraTools: ['agent', 'team_spawn', 'delegate_task', 'ask_user'],
      runtimeFactory: capturingRuntimeFactory(captured),
    });
    await runtime.spawn(member());

    const toolNames = (captured[0]?.pluginHost?.listTools() ?? []).map((tool) => tool.name).sort();
    expect(toolNames).toEqual(['agent', 'ask_user', 'bash', 'edit', 'read']);
  });

  it('member run drops parent hooks or guardrails', async () => {
    const captured: AgentRuntimeOptions[] = [];
    const parent = makeHost([makeTool('read')]);
    const hook: Hook = {
      name: 'audit',
      type: HookType.BeforeLlm,
      run: async () => {},
    };
    const guardrail: Guardrail = {
      name: 'blocker',
      stage: GuardrailStage.Input,
      check: async () => ({ allowed: true }),
    };
    parent.registerHook(hook);
    parent.registerGuardrail(guardrail);
    const runtime = makeRuntime({
      pluginHost: parent,
      runtimeFactory: capturingRuntimeFactory(captured),
    });

    await runtime.spawn(member());

    const memberHost = captured[0]?.pluginHost;
    expect(memberHost).not.toBe(parent);
    expect(memberHost?.getHooks().map((entry) => entry.name)).toEqual(['audit']);
    expect(memberHost?.getGuardrails().map((entry) => entry.name)).toEqual(['blocker']);
  });

  it('deny mode keeps only read; allow mode keeps the whitelisted tools', async () => {
    const denied: AgentRuntimeOptions[] = [];
    const denyRuntime = makeRuntime({
      permissionMode: 'deny',
      runtimeFactory: capturingRuntimeFactory(denied),
    });
    await denyRuntime.spawn(member());
    expect((denied[0]?.pluginHost?.listTools() ?? []).map((tool) => tool.name).sort()).toEqual([
      'read',
    ]);

    const allowed: AgentRuntimeOptions[] = [];
    const allowRuntime = makeRuntime({
      pluginHost: makeHost(['bash', 'read', 'edit', 'ask_user'].map((name) => makeTool(name))),
      extraTools: ['ask_user'],
      runtimeFactory: capturingRuntimeFactory(allowed),
    });
    await allowRuntime.spawn(member());
    expect((allowed[0]?.pluginHost?.listTools() ?? []).map((tool) => tool.name).sort()).toEqual([
      'ask_user',
      'bash',
      'edit',
      'read',
    ]);
  });

  it('exposes agent to members in allow / bridge mode and hides it in deny mode', async () => {
    const tools = ['agent', 'bash', 'edit', 'read'].map((name) => makeTool(name));

    const allowCaptured: AgentRuntimeOptions[] = [];
    const allowRuntime = makeRuntime({
      pluginHost: makeHost(tools),
      runtimeFactory: capturingRuntimeFactory(allowCaptured),
    });
    await allowRuntime.spawn(member({ session_id: 'allow-body' }));
    const allowNames = (allowCaptured[0]?.pluginHost?.listTools() ?? []).map((tool) => tool.name);
    expect(allowNames).toContain('agent');

    const bridgeCaptured: AgentRuntimeOptions[] = [];
    const bridgeRuntime = makeRuntime({
      pluginHost: makeHost(tools),
      permissionMode: 'bridge',
      parentEvents: new MemoryEventStream(),
      runtimeFactory: capturingRuntimeFactory(bridgeCaptured),
    });
    await bridgeRuntime.spawn(member({ session_id: 'bridge-body' }));
    const bridgeNames = (bridgeCaptured[0]?.pluginHost?.listTools() ?? []).map((tool) => tool.name);
    expect(bridgeNames).toContain('agent');

    const denyCaptured: AgentRuntimeOptions[] = [];
    const denyRuntime = makeRuntime({
      pluginHost: makeHost(tools),
      permissionMode: 'deny',
      runtimeFactory: capturingRuntimeFactory(denyCaptured),
    });
    await denyRuntime.spawn(member({ session_id: 'deny-body' }));
    const denyNames = (denyCaptured[0]?.pluginHost?.listTools() ?? []).map((tool) => tool.name);
    expect(denyNames).not.toContain('agent');
    expect(denyNames).toEqual(['read']);
  });

  it('exposes the agent tool to members with rotate/post/send/list and keeps other schemas', async () => {
    const readSchema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    };
    const agentTool: ToolDefinition = {
      name: 'agent',
      description: 'owner lifecycle tool',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['new', 'send', 'close', 'list', 'rotate'] },
          to: { type: 'string', description: 'send / rotate target' },
          startup_prompt: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['action'],
      },
      handler: async () => 'agent:ok',
    };
    const readTool: ToolDefinition = {
      name: 'read',
      description: 'read tool',
      inputSchema: readSchema,
      handler: async () => 'read:ok',
    };

    const captured: AgentRuntimeOptions[] = [];
    const allowRuntime = makeRuntime({
      pluginHost: makeHost([agentTool, readTool]),
      runtimeFactory: capturingRuntimeFactory(captured),
    });
    await allowRuntime.spawn(member({ session_id: 'allow-agent-body' }));

    const bridgeCaptured: AgentRuntimeOptions[] = [];
    const bridgeRuntime = makeRuntime({
      pluginHost: makeHost([agentTool, readTool]),
      permissionMode: 'bridge',
      parentEvents: new MemoryEventStream(),
      runtimeFactory: capturingRuntimeFactory(bridgeCaptured),
    });
    await bridgeRuntime.spawn(member({ session_id: 'bridge-agent-body' }));

    for (const stream of [captured, bridgeCaptured]) {
      const tools = stream[0]?.pluginHost?.listTools() ?? [];
      const selectedAgent = tools.find((tool) => tool.name === 'agent');
      const schema = selectedAgent?.inputSchema as {
        properties: Record<string, { enum?: string[] }>;
        required: string[];
      };
      expect(schema.properties.action?.enum).toEqual(['rotate', 'post', 'send', 'list']);
      expect(schema.required).toEqual(['action']);
      expect(Object.keys(schema.properties).sort()).toEqual([
        'action',
        'content',
        'messages',
        'startup_prompt',
        'state',
        'to',
        'visibility',
      ]);
      expect('handoff_path' in schema.properties).toBe(false);
      expect(selectedAgent?.description).not.toContain('handoff_path');
      expect(tools.find((tool) => tool.name === 'read')?.inputSchema).toBe(readSchema);
    }
  });

  it('an ask from a tool checkPermission is denied instead of waiting for a missing bridge', async () => {
    let calls = 0;
    const requests: ChatRequest[] = [];
    const providerFactory = (): LLMProvider => ({
      async chat(req) {
        requests.push(req);
        calls += 1;
        if (calls === 1) {
          return {
            content: '',
            finish_reason: 'tool_calls',
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'bash', arguments: '{}' },
              },
            ],
          };
        }
        return { content: 'done', finish_reason: 'stop' };
      },
    });
    const runtime = createInProcessMemberRuntime({
      providerFactory,
      model: 'default-model',
      pluginHost: makeHost([makeTool('bash', 'ask')]),
    });
    const target = member();
    await runtime.spawn(target);

    let timer: ReturnType<typeof setTimeout> | undefined;
    // 无 bridge 时一旦漏了 ask -> deny，run 会永久等待；用本地计时器把死等变成明确失败。
    const result = await Promise.race([
      runtime.runTurn(target, message('run bash')),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('run hung waiting for a permission response')),
          2_000,
        );
      }),
    ]).finally(() => clearTimeout(timer));

    expect(result.content).toBe('done');
    const toolMessage = requests[1]?.messages.find((entry) => entry.role === 'tool');
    expect(toolMessage?.content).toContain('denied');
  });

  it('cancel makes the active runTurn settle as cancelled', async () => {
    const started = deferred<void>();
    const providerFactory = (): LLMProvider => ({
      async chat(req) {
        started.resolve();
        if (!req.signal) throw new Error('provider did not receive a run signal');
        return new Promise<LLMResponse>((_resolve, reject) => {
          req.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      },
    });
    const runtime = createInProcessMemberRuntime({
      providerFactory,
      model: 'default-model',
      pluginHost: makeHost([makeTool('read')]),
    });
    const target = member();
    await runtime.spawn(target);

    const turn = runtime.runTurn(target, message('hang'));
    await started.promise;
    runtime.cancel(target);

    const result = await turn;
    expect(result.outcome).toBe('cancelled');
    expect(result.content).toBeUndefined();
  });

  it('runTurn after dispose fails instead of running on a released runtime', async () => {
    const runtime = makeRuntime();
    const target = member();
    await runtime.spawn(target);
    await runtime.dispose(target);

    await expect(runtime.runTurn(target, message('late'))).rejects.toThrow(/not spawned/);
  });

  it('run failures propagate to the caller instead of being swallowed', async () => {
    const runtime = createInProcessMemberRuntime({
      providerFactory: () => ({
        async chat() {
          throw new Error('llm exploded');
        },
      }),
      model: 'default-model',
      pluginHost: makeHost([makeTool('read')]),
    });
    const target = member();
    await runtime.spawn(target);

    await expect(runtime.runTurn(target, message('boom'))).rejects.toThrow('llm exploded');
  });

  it('spawn passes role, parent, depth, model, tools, limits and context in the self card', async () => {
    const captured: AgentRuntimeOptions[] = [];
    const runtime = makeRuntime({
      model: 'default-model',
      contextMaxTokens: 12_000,
      depth: 2,
      limits: { toolCallsLimit: 5 },
      termination: { maxIterations: 3, maxRuntimeSeconds: 30 },
      runtimeFactory: capturingRuntimeFactory(captured),
    });
    const target = member({
      id: 'worker-1',
      session_id: 'session-1',
      name: 'worker',
      parent_id: 'main',
      model: 'member-model',
      system_prompt: 'You are a worker.',
    });

    await runtime.spawn(target);

    const options = captured[0];
    expect(options?.model).toBe('member-model');
    expect(options?.agentId).toBe('worker-1');
    expect(options?.systemPrompt).toBe('You are a worker.');
    expect(options?.selfCard).toEqual({
      role: 'worker',
      parent_id: 'main',
      depth: 2,
      model: 'member-model',
      tools: ['bash', 'read', 'edit'],
      limits: { toolCallsLimit: 5, maxIterations: 3, maxRuntimeSeconds: 30 },
      context: { max: 12_000 },
      how_to_ask: 'This is a non-interactive run; state blockers in your final text.',
    });
  });
});

/** 第一轮调用工具、第二轮把工具结果带进最终文本的 provider */
function toolThenEchoProvider(toolName: string): {
  providerFactory: () => LLMProvider;
} {
  let calls = 0;
  return {
    providerFactory: () => ({
      async chat(req) {
        calls += 1;
        if (calls === 1) {
          return {
            content: '',
            finish_reason: 'tool_calls',
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: toolName, arguments: '{}' },
              },
            ],
          };
        }
        const toolMessage = [...req.messages].reverse().find((entry) => entry.role === 'tool');
        return { content: `final:${toolMessage?.content ?? ''}`, finish_reason: 'stop' };
      },
    }),
  };
}

/** 记录 warn 的 logger（bridge 缺失/降级断言用） */
function warningLogger(): { warnings: string[]; logger: Logger } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => {
        warnings.push(message);
      },
      error: () => {},
    },
  };
}

describe('InProcessMemberRuntime permission bridge', () => {
  it('forwards permission requests with member context and resumes on the parent response', async () => {
    const parentEvents = new MemoryEventStream();
    const states: string[] = [];
    const { providerFactory } = toolThenEchoProvider('bash');
    const runtime = createInProcessMemberRuntime({
      providerFactory,
      model: 'default-model',
      pluginHost: makeHost([makeTool('bash', 'ask')]),
      permissionMode: 'bridge',
      parentEvents,
      onPermissionState: (memberId, sessionId, state) =>
        states.push(`${memberId}:${sessionId}:${state}`),
    });
    const target = member({ parent_id: 'main' });
    await runtime.spawn(target);

    const forwarded: RunEvent[] = [];
    parentEvents.subscribe((event) => {
      if (event.type !== 'tool.permission.request') return;
      forwarded.push(event);
      parentEvents.publish({
        type: 'tool.permission.response',
        run_id: event.run_id,
        data: {
          requestId: (event.data as Record<string, unknown>).requestId,
          decision: 'allow',
        },
        ts: Date.now(),
      });
    });

    const result = await runtime.runTurn(target, message('run bash'));

    expect(result.content).toBe('final:bash:ok');
    expect(forwarded).toHaveLength(1);
    const data = forwarded[0]?.data as Record<string, unknown>;
    expect(data.agent_id).toBe('m1');
    expect(data.session_id).toBe('m1');
    expect(data.parent_session_id).toBe('main');
    expect(data.request_id).toBe(data.requestId as string);
    expect(data.tool_call_id).toBe('call-1');
    expect(data.delegate_path).toEqual(['main', 'm1']);
    expect(data.tool).toBe('bash');
    expect(data.input).toEqual({});
    expect(data.source).toBe('runtime');
    expect(states).toEqual(['m1:m1:waiting', 'm1:m1:running']);
  });

  it('bridges ask_user questions to the parent and routes the answer back', async () => {
    const parentEvents = new MemoryEventStream();
    const askUser: ToolDefinition = {
      name: 'ask_user',
      description: 'ask the user',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, ctx) => {
        const requestId = 'ask-1';
        ctx.events.publish({
          type: 'ask.user.requested',
          run_id: ctx.run_id,
          data: { requestId, questions: [{ header: 'h', question: 'q' }] },
          ts: Date.now(),
        });
        const answered = (await ctx.events.waitFor('ask.user.answered', {
          requestId,
          timeout: 2_000,
        })) as { answers?: { answer: string }[] } | undefined;
        return `answered:${answered?.answers?.[0]?.answer ?? ''}`;
      },
    };
    const { providerFactory } = toolThenEchoProvider('ask_user');
    const runtime = createInProcessMemberRuntime({
      providerFactory,
      model: 'default-model',
      pluginHost: makeHost([askUser]),
      extraTools: ['ask_user'],
      permissionMode: 'bridge',
      parentEvents,
    });
    const target = member({ parent_id: 'main' });
    await runtime.spawn(target);

    const forwarded: RunEvent[] = [];
    parentEvents.subscribe((event) => {
      if (event.type !== 'ask.user.requested') return;
      forwarded.push(event);
      parentEvents.publish({
        type: 'ask.user.answered',
        run_id: event.run_id,
        data: { requestId: 'ask-1', answers: [{ header: 'h', question: 'q', answer: 'yes' }] },
        ts: Date.now(),
      });
    });

    const result = await runtime.runTurn(target, message('ask'));

    expect(result.content).toBe('final:answered:yes');
    const data = forwarded[0]?.data as Record<string, unknown>;
    expect(data.agent_id).toBe('m1');
    expect(data.parent_session_id).toBe('main');
    expect(data.request_id).toBe('ask-1');
    expect(data.delegate_path).toEqual(['main', 'm1']);
    expect(data.tool).toBe('ask_user');
    expect(data.input).toEqual([{ header: 'h', question: 'q' }]);
    expect(data.source).toBe('runtime');
  });

  it('bridge without parentEvents degrades to deny and logs a warning', async () => {
    const { warnings, logger } = warningLogger();
    const { providerFactory } = toolThenEchoProvider('bash');
    const runtime = createInProcessMemberRuntime({
      providerFactory,
      model: 'default-model',
      pluginHost: makeHost([makeTool('bash', 'ask')]),
      permissionMode: 'bridge',
      logger,
    });
    const target = member();
    await runtime.spawn(target);

    const result = await runtime.runTurn(target, message('run bash'));

    expect(warnings).toContain('agent.member.permission_bridge_unavailable');
    expect(warnings).toContain('agent.member.permission_ask_denied');
    expect(result.content).toContain('denied');
  });

  it('keeps the A3a deny behavior when bridge is off, even with parentEvents', async () => {
    const parentEvents = new MemoryEventStream();
    const forwarded: RunEvent[] = [];
    parentEvents.subscribe((event) => {
      forwarded.push(event);
    });
    const { providerFactory } = toolThenEchoProvider('bash');
    const runtime = createInProcessMemberRuntime({
      providerFactory,
      model: 'default-model',
      pluginHost: makeHost([makeTool('bash', 'ask')]),
      permissionMode: 'allow',
      parentEvents,
    });
    const target = member();
    await runtime.spawn(target);

    const result = await runtime.runTurn(target, message('run bash'));

    expect(result.content).toContain('denied');
    expect(forwarded).toHaveLength(0);
  });

  it('forces bridge for team members and drops agent-originated answers', async () => {
    const parentEvents = new MemoryEventStream();
    const { warnings, logger } = warningLogger();
    const { providerFactory } = toolThenEchoProvider('bash');
    const runtime = createInProcessMemberRuntime({
      providerFactory,
      model: 'default-model',
      pluginHost: makeHost([makeTool('bash', 'ask')]),
      // 全局 allow 被 team 成员覆盖：只有 bridge（人端）能应答。
      permissionMode: 'allow',
      parentEvents,
      logger,
    });
    const target = member({ parent_id: 'main', team_id: 'team-1' });
    await runtime.spawn(target);

    const forwarded: RunEvent[] = [];
    parentEvents.subscribe((event) => {
      if (event.type !== 'tool.permission.request') return;
      forwarded.push(event);
      const requestId = (event.data as Record<string, unknown>).requestId;
      parentEvents.publish({
        type: 'tool.permission.response',
        run_id: event.run_id,
        data: { requestId, decision: 'deny', answered_by: 'agent' },
        ts: Date.now(),
      });
      setTimeout(() => {
        parentEvents.publish({
          type: 'tool.permission.response',
          run_id: event.run_id,
          data: { requestId, decision: 'allow', answered_by: 'human', answered_via: 'tui' },
          ts: Date.now(),
        });
      }, 10);
    });

    const result = await runtime.runTurn(target, message('run bash'));

    // agent 的 deny 被丢弃；human 的 allow 才生效。
    expect(result.content).toBe('final:bash:ok');
    expect(forwarded).toHaveLength(1);
    const forwardedData = forwarded[0]?.data as Record<string, unknown> | undefined;
    expect(forwardedData?.team_id).toBe('team-1');
    expect(warnings).toContain('agent.member.permission_response_dropped');
  });

  it('fires team deny-after once with policy attribution', async () => {
    const parentEvents = new MemoryEventStream();
    const { providerFactory } = toolThenEchoProvider('bash');
    const runtime = createInProcessMemberRuntime({
      providerFactory,
      model: 'default-model',
      pluginHost: makeHost([makeTool('bash', 'ask')]),
      permissionMode: 'bridge',
      parentEvents,
      permissionPolicy: (teamId) =>
        teamId === 'team-1' ? { unattended: 'deny-after', denyAfterSeconds: 0.02 } : undefined,
    });
    const target = member({ team_id: 'team-1' });
    await runtime.spawn(target);

    const responses: RunEvent[] = [];
    parentEvents.subscribe((event) => {
      if (event.type === 'tool.permission.response') responses.push(event);
    });

    const result = await runtime.runTurn(target, message('run bash'));

    expect(result.content).toContain('denied');
    expect(responses).toHaveLength(1);
    expect(responses[0]?.data).toMatchObject({
      decision: 'deny',
      scope: 'once',
      answered_by: 'policy',
      answered_via: 'policy',
      policy: 'deny_after',
      reason: 'deny_after',
    });
    await Bun.sleep(40);
    expect(responses).toHaveLength(1);
  });

  it('publishes empty answers for ask deny-after', async () => {
    const parentEvents = new MemoryEventStream();
    const askUser: ToolDefinition = {
      name: 'ask_user',
      description: 'ask the user',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, ctx) => {
        const requestId = 'ask-1';
        ctx.events.publish({
          type: 'ask.user.requested',
          run_id: ctx.run_id,
          data: { requestId, questions: [{ header: 'h', question: 'q' }] },
          ts: Date.now(),
        });
        const answered = (await ctx.events.waitFor('ask.user.answered', {
          requestId,
          timeout: 2_000,
        })) as { answers?: { answer: string }[] } | undefined;
        return `answered:${answered?.answers?.[0]?.answer ?? ''}`;
      },
    };
    const { providerFactory } = toolThenEchoProvider('ask_user');
    const runtime = createInProcessMemberRuntime({
      providerFactory,
      model: 'default-model',
      pluginHost: makeHost([askUser]),
      extraTools: ['ask_user'],
      permissionMode: 'bridge',
      parentEvents,
      permissionPolicy: () => ({ unattended: 'deny-after', denyAfterSeconds: 0.02 }),
    });
    const target = member({ team_id: 'team-1' });
    await runtime.spawn(target);

    const answers: RunEvent[] = [];
    parentEvents.subscribe((event) => {
      if (event.type === 'ask.user.answered') answers.push(event);
    });

    const result = await runtime.runTurn(target, message('ask'));

    expect(result.content).toBe('final:answered:');
    expect(answers).toHaveLength(1);
    expect(answers[0]?.data).toMatchObject({
      answers: [],
      answered_by: 'policy',
      answered_via: 'policy',
      policy: 'deny_after',
    });
  });

  it('never schedules a deadline for hold', async () => {
    const parentEvents = new MemoryEventStream();
    const { providerFactory } = toolThenEchoProvider('bash');
    const runtime = createInProcessMemberRuntime({
      providerFactory,
      model: 'default-model',
      pluginHost: makeHost([makeTool('bash', 'ask')]),
      permissionMode: 'bridge',
      parentEvents,
      // 提供秒数也不算：unattended=hold 时不得建定时器。
      permissionPolicy: () => ({ unattended: 'hold', denyAfterSeconds: 0.01 }),
    });
    const target = member({ team_id: 'team-1' });
    await runtime.spawn(target);

    const policyResponses: RunEvent[] = [];
    parentEvents.subscribe((event) => {
      if (event.type === 'tool.permission.request') {
        const requestId = (event.data as Record<string, unknown>).requestId;
        setTimeout(() => {
          parentEvents.publish({
            type: 'tool.permission.response',
            run_id: event.run_id,
            data: { requestId, decision: 'allow' },
            ts: Date.now(),
          });
        }, 40);
        return;
      }
      if (event.type === 'tool.permission.response') {
        const data = event.data as Record<string, unknown>;
        if (data.answered_by === 'policy') policyResponses.push(event);
      }
    });

    const result = await runtime.runTurn(target, message('run bash'));

    expect(result.content).toBe('final:bash:ok');
    expect(policyResponses).toHaveLength(0);
  });
});
