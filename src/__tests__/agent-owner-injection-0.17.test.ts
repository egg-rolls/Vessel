/**
 * 0.17 A3c：owner 队列注入与权限 bridge 接线。
 *
 * 守：成员 turn 排空 owner 队列（成员继承父 hooks）、owner 被 pump 空跑、
 * 无消息时改写请求形状、关闭后 hook 继续注入、bridge 权限事件字段破坏现有
 * TUI 权限卡片、父级应答没有回灌成员。
 */

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createInProcessMemberRuntime,
  type MemberRuntimeMember,
} from '../../packages/agent/src/index';
import type {
  AgentRuntimeOptions,
  HookContext,
  LLMProvider,
  Logger,
  RunEvent,
  ToolDefinition,
} from '../../packages/core/src/index';
import { MemoryEventStream, MemoryPluginHost } from '../../packages/core/src/index';
import { asTuiEvent } from '../../packages/tui/src/types/events';
import {
  AGENT_OWNER_INJECTION_HOOK,
  createAgentOwnerInjector,
  type OwnerQueueMessage,
  ownerMessageToMessage,
} from '../agent-owner-injection';
import {
  type AgentServiceWiringOptions,
  buildMemberRuntimeOptions,
  createAgentServiceWiring,
} from '../agent-service-wiring';
import { parseArgs } from '../cli-args';

function message(overrides: Partial<OwnerQueueMessage> = {}): OwnerQueueMessage {
  return {
    id: 'msg-1',
    from: 'member-1',
    to: 'main',
    content: 'done',
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

function hookContext(overrides: Partial<HookContext> = {}): HookContext {
  return { run_id: 'run-1', session_id: 'session-parent', ...overrides };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-owner-injection-'));
}

function wiringOptions(
  pluginHost: MemoryPluginHost,
  dataDir: string,
  overrides: Partial<AgentServiceWiringOptions> = {},
): AgentServiceWiringOptions {
  return {
    tenantId: 'default',
    dataDir,
    sessionId: 'session-parent',
    pluginHost,
    providerFactory: () => ({}) as LLMProvider,
    model: 'mock-model',
    ...overrides,
  };
}

/** 不跑真实 provider 的成员 runtime；只回显输入或执行测试自定义逻辑 */
function fakeRuntimeFactory(
  onRun?: (options: AgentRuntimeOptions, input: string) => Promise<string>,
): NonNullable<AgentServiceWiringOptions['runtimeFactory']> {
  return async (options) => ({
    events: options.events,
    pluginHost: options.pluginHost ?? new MemoryPluginHost(),
    async run(input) {
      const text = typeof input === 'string' ? input : input.content;
      return onRun ? onRun(options, text) : `echo:${text}`;
    },
    async dispose() {},
  });
}

async function waitForState(
  service: { list(filter: { viewer: string }): Promise<Array<{ id: string; state: string }>> },
  memberId: string,
  state: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const members = await service.list({ viewer: 'main' });
    if (members.find((member) => member.id === memberId)?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const members = await service.list({ viewer: 'main' });
  throw new Error(
    `member ${memberId} did not reach ${state}: ${JSON.stringify(members.map((m) => [m.id, m.state]))}`,
  );
}

function cleanup(dataDir: string): void {
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

describe('agent owner injection 0.17', () => {
  it('maps owner queue messages to user messages with agent name and ts', () => {
    expect(ownerMessageToMessage(message())).toEqual({
      role: 'user',
      name: 'agent:member-1',
      content: 'done',
      timestamp: 1_700_000_000_000,
    });
  });

  it('drains takeMessages once and appends to ctx.messages', async () => {
    const pending = [message(), message({ id: 'msg-2', from: 'member-2', content: 'pong' })];
    const calls: string[] = [];
    const injector = createAgentOwnerInjector({
      ownerId: 'main',
      source: {
        takeMessages(memberId) {
          calls.push(memberId);
          return pending.splice(0);
        },
      },
    });

    const ctx = hookContext();
    await injector.hook.run(ctx);

    expect(calls).toEqual(['main']);
    expect(ctx.messages?.map((entry) => entry.name)).toEqual(['agent:member-1', 'agent:member-2']);
    expect(ctx.messages?.map((entry) => entry.content)).toEqual(['done', 'pong']);

    // 排空后同一 run 的下一轮不再注入
    const next = hookContext();
    await injector.hook.run(next);
    expect(calls).toEqual(['main', 'main']);
    expect(next.messages).toBeUndefined();
  });

  it('keeps an existing ctx.messages reference unchanged when no messages', async () => {
    const injector = createAgentOwnerInjector({
      ownerId: 'main',
      source: { takeMessages: () => [] },
    });
    const existing = [{ role: 'user' as const, content: 'keep' }];
    const ctx = hookContext({ messages: existing });

    await injector.hook.run(ctx);

    expect(ctx.messages).toBe(existing);
    expect(ctx.messages).toHaveLength(1);
  });

  it('isolates takeMessages failures and publishes inject_failed', async () => {
    const events = new MemoryEventStream();
    const published: RunEvent[] = [];
    events.subscribe((event) => {
      published.push(event);
    });
    const injector = createAgentOwnerInjector({
      ownerId: 'main',
      events,
      source: {
        takeMessages() {
          throw new Error('queue unavailable');
        },
      },
    });
    const ctx = hookContext();

    await injector.hook.run(ctx);

    expect(ctx.messages).toBeUndefined();
    expect(published.map((event) => event.type)).toContain('agent.reply.inject_failed');
  });

  it('member sessions (including retired bodies) do not drain the owner queue', async () => {
    let called = 0;
    const fakeService = {
      takeMessages() {
        called += 1;
        return [message()];
      },
      // wiring 直接委托 service.isMemberBody；已退役 Body 也必须算成员 Body。
      isMemberBody(sessionId: string) {
        return sessionId === 'retired-body';
      },
    };
    const injector = createAgentOwnerInjector({
      ownerId: 'main',
      source: fakeService,
      isMemberSession: (sessionId) =>
        sessionId !== undefined && fakeService.isMemberBody(sessionId),
    });

    const ctx = hookContext({ session_id: 'retired-body' });
    await injector.hook.run(ctx);

    expect(called).toBe(0);
    expect(ctx.messages).toBeUndefined();
  });

  it('identity check failure does not drain the owner queue (fail-closed)', async () => {
    const events = new MemoryEventStream();
    const published: RunEvent[] = [];
    events.subscribe((event) => {
      published.push(event);
    });
    let called = 0;
    const injector = createAgentOwnerInjector({
      ownerId: 'main',
      events,
      source: {
        takeMessages() {
          called += 1;
          return [message()];
        },
      },
      isMemberSession: () => {
        throw new Error('identity unavailable');
      },
    });

    const ctx = hookContext({ session_id: 'member-session' });
    await injector.hook.run(ctx);

    expect(called).toBe(0);
    expect(ctx.messages).toBeUndefined();
    const skipped = published.find((event) => event.type === 'agent.reply.inject_skipped');
    expect(skipped?.data).toMatchObject({
      owner_id: 'main',
      reason: 'identity_check_failed',
      error: 'identity unavailable',
    });
  });

  it('dispose stops injection and is idempotent', async () => {
    let called = 0;
    const injector = createAgentOwnerInjector({
      ownerId: 'main',
      source: {
        takeMessages() {
          called += 1;
          return [message()];
        },
      },
    });
    injector.dispose();
    injector.dispose();

    const ctx = hookContext();
    await injector.hook.run(ctx);

    expect(called).toBe(0);
    expect(ctx.messages).toBeUndefined();
  });

  it('passes permissionMode, parentEvents and onPermissionState to member runtime options', () => {
    const pluginHost = new MemoryPluginHost();
    const events = new MemoryEventStream();
    const states: string[] = [];
    const bridge = buildMemberRuntimeOptions(
      wiringOptions(pluginHost, '/tmp/unused', {
        permissionMode: 'bridge',
        parentEvents: events,
      }),
      (memberId, sessionId, state) => states.push(`${memberId}:${sessionId}:${state}`),
    );
    expect(bridge.permissionMode).toBe('bridge');
    expect(bridge.parentEvents).toBe(events);
    bridge.onPermissionState?.('m1', 'body-1', 'waiting');
    expect(states).toEqual(['m1:body-1:waiting']);

    const headless = buildMemberRuntimeOptions(
      wiringOptions(pluginHost, '/tmp/unused', { permissionMode: 'allow' }),
    );
    expect(headless.permissionMode).toBe('allow');
    expect('parentEvents' in headless).toBe(false);
    expect('onPermissionState' in headless).toBe(false);
    expect('onMemberEvent' in headless).toBe(false);
    expect('permission' in headless).toBe(false);
  });

  it('member permission auto-approves agent (deduped) and forwards onMemberEvent', () => {
    const pluginHost = new MemoryPluginHost();
    const memberEvents: string[] = [];
    const built = buildMemberRuntimeOptions(
      wiringOptions(pluginHost, '/tmp/unused', {
        permission: {
          default: 'ask',
          autoApprove: ['read', 'agent'],
          neverAutoApprove: ['agent.close'],
        },
      }),
      undefined,
      (memberId, sessionId, event) => {
        memberEvents.push(`${memberId}:${sessionId}:${event.type}`);
      },
    );
    expect(built.permission?.autoApprove).toEqual(['read', 'agent']);
    expect(built.permission?.neverAutoApprove).toEqual(['agent.close']);
    built.onMemberEvent?.('m1', 'm1', {
      type: 'agent.limit.warning',
      run_id: 'r1',
      data: {},
      ts: 1,
    });
    expect(memberEvents).toEqual(['m1:m1:agent.limit.warning']);
  });

  it('registers the hook once per host and stops it on wiring dispose', async () => {
    const pluginHost = new MemoryPluginHost();
    const dataDir = tmpDir();
    try {
      const first = await createAgentServiceWiring(wiringOptions(pluginHost, dataDir));
      const named = () =>
        pluginHost.getHooks().filter((hook) => hook.name === AGENT_OWNER_INJECTION_HOOK);
      expect(named()).toHaveLength(1);

      // 同一宿主重复装配不得再注册一个同名 hook
      const second = await createAgentServiceWiring(wiringOptions(pluginHost, dataDir));
      expect(named()).toHaveLength(1);

      first.injector.dispose();
      second.injector.dispose();
      expect(named()).toHaveLength(1);
    } finally {
      cleanup(dataDir);
    }
  });

  it('wires ownerId into the service default owner', async () => {
    const pluginHost = new MemoryPluginHost();
    const owneredDir = tmpDir();
    const defaultDir = tmpDir();
    try {
      const ownered = await createAgentServiceWiring(
        wiringOptions(pluginHost, owneredDir, { ownerId: 'boss' }),
      );
      const contractor = await ownered.service.create({ kind: 'contractor' });
      const legacy = await ownered.service.create({});
      expect(contractor.owner).toBe('boss');
      expect(legacy.owner).toBe('boss');
      expect(ownered.owner.id).toBe('boss');
      ownered.injector.dispose();

      const defaults = await createAgentServiceWiring(wiringOptions(pluginHost, defaultDir));
      expect((await defaults.service.create({})).owner).toBe('main');
      defaults.injector.dispose();
    } finally {
      cleanup(owneredDir);
      cleanup(defaultDir);
    }
  });

  it('end-to-end: member final text queues to owner and injects once', async () => {
    const pluginHost = new MemoryPluginHost();
    const dataDir = tmpDir();
    try {
      const wiring = await createAgentServiceWiring(
        wiringOptions(pluginHost, dataDir, {
          runtimeFactory: fakeRuntimeFactory((_options, input) =>
            Promise.resolve(`reply:${input}`),
          ),
        }),
      );
      const member = await wiring.service.create({ name: 'worker', parentId: 'main' });
      await wiring.service.send({ to: member.id, content: 'hello' });
      await waitForState(wiring.service, member.id, 'completed');

      // owner 是 external owner：pump 不消费，状态保持 idle，消息留在队列。
      const owner = (await wiring.service.list({ viewer: 'main' })).find(
        (entry) => entry.id === 'main',
      );
      expect(owner?.state).toBe('idle');

      const hook = pluginHost.getHooks().find((entry) => entry.name === AGENT_OWNER_INJECTION_HOOK);
      if (!hook) throw new Error('owner injection hook missing');

      const ctx = hookContext();
      await hook.run(ctx);
      expect(ctx.messages).toEqual([
        {
          role: 'user',
          name: `agent:${member.id}`,
          content: 'reply:hello',
          timestamp: expect.any(Number),
        },
      ]);

      // 每轮只排空一次：下一轮不再注入同一回复
      const next = hookContext();
      await hook.run(next);
      expect(next.messages).toBeUndefined();
      expect(await wiring.service.takeMessages('main')).toEqual([]);
      wiring.injector.dispose();
    } finally {
      cleanup(dataDir);
    }
  });

  it('end-to-end: private member sessions keep the owner queue until the parent session drains it', async () => {
    const pluginHost = new MemoryPluginHost();
    const dataDir = tmpDir();
    try {
      const wiring = await createAgentServiceWiring(
        wiringOptions(pluginHost, dataDir, {
          runtimeFactory: fakeRuntimeFactory((_options, input) => Promise.resolve(`echo:${input}`)),
        }),
      );
      // 默认 visibility 是 private：旧实现用无 viewer 的 list() 会把它们全过滤掉。
      const first = await wiring.service.create({ name: 'a', parentId: 'main' });
      const second = await wiring.service.create({ name: 'b', parentId: 'main' });
      await wiring.service.send({ to: first.id, content: 'first' });
      await wiring.service.send({ to: second.id, content: 'second' });
      await waitForState(wiring.service, first.id, 'completed');
      await waitForState(wiring.service, second.id, 'completed');

      const hook = pluginHost.getHooks().find((entry) => entry.name === AGENT_OWNER_INJECTION_HOOK);
      if (!hook) throw new Error('owner injection hook missing');

      // 成员 turn（session_id === 成员 id）不得排空 owner 队列。
      for (const member of [first, second]) {
        const memberCtx = hookContext({ session_id: member.id });
        await hook.run(memberCtx);
        expect(memberCtx.messages).toBeUndefined();
      }

      // 父 turn 一次排空两条，来源与内容各自对应、不串线。
      const parentCtx = hookContext();
      await hook.run(parentCtx);
      const injected = parentCtx.messages ?? [];
      expect(injected).toHaveLength(2);
      expect(Object.fromEntries(injected.map((entry) => [entry.name, entry.content]))).toEqual({
        [`agent:${first.id}`]: 'echo:first',
        [`agent:${second.id}`]: 'echo:second',
      });
      expect(await wiring.service.takeMessages('main')).toEqual([]);
      wiring.injector.dispose();
    } finally {
      cleanup(dataDir);
    }
  });

  it('end-to-end: bridge request reaches parentEvents and the response resumes the member', async () => {
    const pluginHost = new MemoryPluginHost();
    const parentEvents = new MemoryEventStream();
    const dataDir = tmpDir();
    const requests: RunEvent[] = [];

    parentEvents.subscribe((event) => {
      if (event.type !== 'tool.permission.request') return;
      requests.push(event);
      const data = event.data as Record<string, unknown>;
      parentEvents.publish({
        type: 'tool.permission.response',
        run_id: event.run_id,
        data: { requestId: data.requestId, decision: 'allow' },
        ts: Date.now(),
      });
    });

    const runtimeFactory = fakeRuntimeFactory(async (options, _input) => {
      // 先注册等待，再发请求：父级应答可能同步回灌。
      const decided = options.events.waitFor('tool.permission.response', {
        requestId: 'req-1',
        timeout: 2_000,
      });
      options.events.publish({
        type: 'tool.permission.request',
        run_id: 'member-run-1',
        data: { requestId: 'req-1', tool: 'bash', input: { command: 'ls' } },
        ts: Date.now(),
      });
      const answer = (await decided) as { decision?: string } | undefined;
      return `decision:${answer?.decision ?? 'none'}`;
    });

    try {
      const wiring = await createAgentServiceWiring(
        wiringOptions(pluginHost, dataDir, {
          permissionMode: 'bridge',
          parentEvents,
          runtimeFactory,
        }),
      );
      const member = await wiring.service.create({ name: 'worker', parentId: 'main' });
      await wiring.service.send({ to: member.id, content: 'run' });
      await waitForState(wiring.service, member.id, 'completed');

      expect(requests).toHaveLength(1);
      const data = requests[0]?.data as Record<string, unknown>;
      expect(data.agent_id).toBe(member.id);
      expect(data.session_id).toBe(member.id);
      expect(data.parent_session_id).toBe('main');
      expect(data.delegate_path).toEqual(['main', member.id]);
      expect(data.tool).toBe('bash');
      expect(data.request_id).toBe('req-1');

      // 成员收到父级应答并完成；最终文本进入 owner 队列
      const replies = await wiring.service.takeMessages('main');
      expect(replies).toHaveLength(1);
      expect(replies[0]?.content).toBe('decision:allow');
      wiring.injector.dispose();
    } finally {
      cleanup(dataDir);
    }
  });

  it('bridge without parentEvents degrades to deny (wiring options)', async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (entry) => {
        warnings.push(entry);
      },
      error: () => {},
    };
    const askTool: ToolDefinition = {
      name: 'bash',
      description: 'run a command',
      inputSchema: { type: 'object', properties: {} },
      checkPermission: async () => 'ask',
      handler: async () => 'ok',
    };
    const host = new MemoryPluginHost();
    host.registerTool(askTool);

    let calls = 0;
    const provider: LLMProvider = {
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
                function: { name: 'bash', arguments: '{}' },
              },
            ],
          };
        }
        const toolMessage = [...req.messages].reverse().find((entry) => entry.role === 'tool');
        return { content: `final:${toolMessage?.content ?? ''}`, finish_reason: 'stop' };
      },
    };

    // wiring 未传 parentEvents：bridge 无法转发，ask 必须按 deny 收口而不是挂起。
    const memberRuntime = createInProcessMemberRuntime(
      buildMemberRuntimeOptions(
        wiringOptions(host, '/tmp/unused', {
          permissionMode: 'bridge',
          providerFactory: () => provider,
          logger,
        }),
      ),
    );
    const member: MemberRuntimeMember = {
      id: 'm1',
      session_id: 'm1',
      owner: 'main',
      parent_id: 'main',
      visibility: 'private',
    };
    await memberRuntime.spawn(member);
    const result = await memberRuntime.runTurn(member, {
      id: 'msg-1',
      from: 'main',
      to: 'm1',
      content: 'run',
      ts: 1,
    });

    expect(warnings).toContain('agent.member.permission_bridge_unavailable');
    expect(warnings).toContain('agent.member.permission_ask_denied');
    expect(result.content).toContain('denied');
    await memberRuntime.dispose(member);
  });

  it('bridge permission request keeps existing TUI card fields', () => {
    const event: RunEvent = {
      type: 'tool.permission.request',
      run_id: 'member-1',
      ts: 1_700_000_000_000,
      data: {
        requestId: 'req-1',
        tool: 'bash',
        input: { command: 'ls' },
        // A3c additive 字段：现有权限卡片不读取，但必须原样透传
        agent_id: 'member-1',
        session_id: 'member-1',
        tool_call_id: 'call-1',
        delegate_path: ['main', 'member-1'],
      },
    };

    const tuiEvent = asTuiEvent(event);
    expect(tuiEvent.type).toBe('tool.permission.request');
    if (tuiEvent.type !== 'tool.permission.request') throw new Error('unexpected event type');
    expect(tuiEvent.data.requestId).toBe('req-1');
    expect(tuiEvent.data.tool).toBe('bash');
    expect(tuiEvent.data.input).toEqual({ command: 'ls' });
    const additive = tuiEvent.data as unknown as Record<string, unknown>;
    expect(additive.agent_id).toBe('member-1');
    expect(additive.session_id).toBe('member-1');
    expect(additive.tool_call_id).toBe('call-1');
    expect(additive.delegate_path).toEqual(['main', 'member-1']);
  });
});

describe('agent rotate CLI parsing 0.19', () => {
  function parsed(argv: string[]) {
    const result = parseArgs(argv);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    return result.args;
  }

  function error(argv: string[]): string {
    const result = parseArgs(argv);
    if (result.ok) throw new Error('expected parse failure');
    return result.error;
  }

  it('parses <to>, --startup and --json', () => {
    expect(
      parsed(['agent', 'rotate', 'worker', '--startup', 'take over', '--json']).agentCommand,
    ).toEqual({
      kind: 'rotate',
      json: true,
      to: 'worker',
      startupPrompt: 'take over',
    });
  });

  it('requires <to> and non-empty --startup, rejects unknown flags', () => {
    expect(error(['agent', 'rotate', '--startup', 'x'])).toContain('requires <to>');
    expect(error(['agent', 'rotate', 'worker'])).toContain('--startup');
    expect(error(['agent', 'rotate', 'worker', '--startup', ''])).toContain('--startup');
    expect(error(['agent', 'rotate', 'worker', '--startup', 'x', '--bogus'])).toContain(
      'Unknown argument',
    );
    expect(error(['agent', 'rotate', 'worker', '--startup', 'x', '--handoff', 'h.md'])).toContain(
      'Unknown argument',
    );
  });
});
