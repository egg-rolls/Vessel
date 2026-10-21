/**
 * 0.17 A3c：owner 队列注入与权限事件接线。
 *
 * 守：成员 turn 排空 owner 队列（成员继承父 hooks）、无消息时改写请求形状、
 * 关闭后 hook 继续注入、bridge 权限事件字段破坏现有 TUI 权限卡片。
 */

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HookContext, LLMProvider, RunEvent } from '../../packages/core/src/index';
import { MemoryEventStream, MemoryPluginHost } from '../../packages/core/src/index';
import { asTuiEvent } from '../../packages/tui/src/types/events';
import {
  AGENT_OWNER_INJECTION_HOOK,
  createAgentOwnerInjector,
  createOwnerMessageSource,
  type OwnerQueueMessage,
  ownerMessageToMessage,
} from '../agent-owner-injection';
import {
  type AgentServiceWiringOptions,
  buildMemberRuntimeOptions,
  createAgentServiceWiring,
} from '../agent-service-wiring';

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

  it('member sessions do not drain the owner queue', async () => {
    let called = 0;
    const injector = createAgentOwnerInjector({
      ownerId: 'main',
      source: {
        takeMessages() {
          called += 1;
          return [message()];
        },
      },
      isMemberSession: (sessionId) => sessionId === 'member-session',
    });

    const ctx = hookContext({ session_id: 'member-session' });
    await injector.hook.run(ctx);

    expect(called).toBe(0);
    expect(ctx.messages).toBeUndefined();
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

  it('owner message source tolerates a service without takeMessages (agent track not merged)', async () => {
    const source = createOwnerMessageSource({});
    expect(await source.takeMessages('main')).toEqual([]);

    const service = {
      items: [message()],
      takeMessages(this: { items: OwnerQueueMessage[] }) {
        return this.items.splice(0);
      },
    };
    const bound = createOwnerMessageSource(service);
    expect(await bound.takeMessages('main')).toHaveLength(1);
    expect(await bound.takeMessages('main')).toEqual([]);
  });

  it('passes permissionMode and parentEvents through member runtime options', () => {
    const pluginHost = new MemoryPluginHost();
    const events = new MemoryEventStream();
    const bridge = buildMemberRuntimeOptions(
      wiringOptions(pluginHost, '/tmp/unused', {
        permissionMode: 'bridge',
        parentEvents: events,
      }),
    );
    expect(bridge.permissionMode).toBe('bridge');
    expect(bridge.parentEvents).toBe(events);

    const headless = buildMemberRuntimeOptions(
      wiringOptions(pluginHost, '/tmp/unused', { permissionMode: 'allow' }),
    );
    expect(headless.permissionMode).toBe('allow');
    expect('parentEvents' in headless).toBe(false);
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
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
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

  it('falls back to a no-op source when the wired service has no owner inbox', async () => {
    const pluginHost = new MemoryPluginHost();
    const dataDir = tmpDir();
    try {
      const wiring = await createAgentServiceWiring(wiringOptions(pluginHost, dataDir));
      const ctx = hookContext();
      await wiring.injector.hook.run(ctx);
      expect(ctx.messages).toBeUndefined();
      wiring.injector.dispose();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
