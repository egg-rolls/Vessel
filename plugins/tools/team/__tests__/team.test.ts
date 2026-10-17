/**
 * team 原型测试：RuntimeHost 最小形状 + 5 个工具。
 * 全部进程内、不联网；跨进程 transport 不在 0.1.0 范围。
 */

import { describe, expect, it } from 'bun:test';
import {
  InProcessRuntimeHost as CoreInProcessRuntimeHost,
  type LLMProvider,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  type ToolContext,
  type ToolDefinition,
} from '@vessel/core';
import { CoreHostAdapter } from '../src/core-adapter';
import type { TeamMessage } from '../src/host';
import { createTeamPlugin, disabledTeamPlugin } from '../src/index';

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

/** 拖住直到被 abort 的 provider（用于取消测试） */
const abortableProvider: LLMProvider = {
  chat(req) {
    return new Promise((_resolve, reject) => {
      if (req.signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      req.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  },
};

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

  it('createTeamPlugin 注册 5 个团队工具', () => {
    const host = teamHost({
      providerFactory: () => new MemoryLLMProvider(),
      model: 'test-model',
    });
    expect(
      host
        .listTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['team_cancel', 'team_inbox', 'team_send', 'team_spawn', 'team_status']);
  });
});

describe('core Host 端口', () => {
  it('spawn / send task / inbox 结果回收 / status', async () => {
    const events = new MemoryEventStream();
    const host = new CoreHostAdapter(new CoreInProcessRuntimeHost(), { events });
    const provider = new MemoryLLMProvider();
    const workerHost = new MemoryPluginHost();

    await host.spawn({ id: 'worker', provider, model: 'm', pluginHost: workerHost });
    await host.send(message('owner', 'worker', 'task', 'hello'));

    const page = await waitFor(async () => {
      const current = await host.inbox('owner');
      return current.messages.length > 0 ? current : undefined;
    });
    expect(page.messages[0]?.kind).toBe('result');
    expect(page.messages[0]?.from).toBe('worker');
    expect(page.messages[0]?.content).toBe('Echo: hello');

    const finalStatus = await waitFor(async () => {
      const status = (await host.status('worker')) as { state: string };
      return status.state === 'idle' ? status : undefined;
    });
    expect(finalStatus.state).toBe('idle');
    expect(events.getHistory().some((e) => e.type === 'team.member.spawned')).toBe(true);
    expect(events.getHistory().some((e) => e.type === 'team.run.completed')).toBe(true);
  });

  it('inbox cursor 只返回新消息', async () => {
    const host = new CoreHostAdapter(new CoreInProcessRuntimeHost());
    await host.spawn({
      id: 'worker',
      provider: new MemoryLLMProvider(),
      model: 'm',
      pluginHost: new MemoryPluginHost(),
    });
    await host.send(message('owner', 'worker', 'message', 'one'));

    const first = await host.inbox('worker');
    expect(first.messages).toHaveLength(1);
    const second = await host.inbox('worker', first.cursor);
    expect(second.messages).toHaveLength(0);
  });

  it('cancel 中断正在运行的任务', async () => {
    const host = new CoreHostAdapter(new CoreInProcessRuntimeHost());
    await host.spawn({
      id: 'slow',
      provider: abortableProvider,
      model: 'm',
      pluginHost: new MemoryPluginHost(),
    });
    await host.send(message('owner', 'slow', 'task', 'never finish'));

    await waitFor(async () => {
      const state = (await host.status('slow')) as { state: string };
      return state.state === 'running' ? true : undefined;
    });
    await host.cancel('slow');

    const cancelled = await waitFor(async () => {
      const state = (await host.status('slow')) as { state: string };
      return state.state === 'cancelled' ? state : undefined;
    });
    expect(cancelled.state).toBe('cancelled');
  });

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

  it('cancel 工具返回 cancelled', async () => {
    const host = teamHost({
      providerFactory: () => new MemoryLLMProvider(),
      model: 'test-model',
    });
    const spawnRaw = await toolOf(host, 'team_spawn').handler({}, makeContext());
    const spawned = JSON.parse(spawnRaw) as { id: string };
    const result = await toolOf(host, 'team_cancel').handler({ member: spawned.id }, makeContext());
    expect(result).toContain('cancelled');
  });
});
