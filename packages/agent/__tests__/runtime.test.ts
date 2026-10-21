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
  MemoryPluginHost,
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

  it('member runtime hides agent, team_* and delegate_task even when explicitly allowed', async () => {
    const captured: AgentRuntimeOptions[] = [];
    const names = ['bash', 'read', 'edit', 'agent', 'team_spawn', 'delegate_task', 'ask_user'];
    const runtime = makeRuntime({
      pluginHost: makeHost(names.map((name) => makeTool(name))),
      extraTools: ['agent', 'team_spawn', 'delegate_task', 'ask_user'],
      runtimeFactory: capturingRuntimeFactory(captured),
    });
    await runtime.spawn(member());

    const toolNames = (captured[0]?.pluginHost?.listTools() ?? []).map((tool) => tool.name).sort();
    expect(toolNames).toEqual(['ask_user', 'bash', 'edit', 'read']);
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
