/**
 * R4 适配层 parity：core Host ↔ 旧 RuntimeHost ↔ team 工具面。
 * 全部使用真实 core InProcessRuntimeHost / AgentRuntime，不 mock 运行时。
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
} from '@vessel-agent/core';
import { CoreHostAdapter, type TeamHostPort } from '../src/core-adapter';
import type { TeamMessage } from '../src/host';
import { createTeamPlugin } from '../src/index';

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

/** 构造消息 */
function message(
  from: string,
  to: string,
  kind: TeamMessage['kind'],
  content: string,
): TeamMessage {
  return { id: `${from}-${to}-${content}`, from, to, kind, content, ts: Date.now() };
}

/** 拖住直到被 abort 的 provider */
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

/** 工具上下文 */
function makeContext(): ToolContext {
  return { run_id: 'team-adapter-test', messages: [], events: new MemoryEventStream() };
}

/** 从 host 取工具 */
function toolOf(host: MemoryPluginHost, name: string): ToolDefinition {
  const tool = host.getTool(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
}

/** 对任意 port 跑同一套行为，断言 0.1 输出形状 */
async function exercisePort(port: TeamHostPort, events: MemoryEventStream): Promise<void> {
  const spawned = await port.spawn({
    id: 'worker',
    name: 'worker',
    provider: new MemoryLLMProvider(),
    model: 'm',
    pluginHost: new MemoryPluginHost(),
  });
  // 0.1 输出字段：不含 currentRunId
  expect(Object.keys(spawned).sort()).toEqual(['id', 'name', 'state', 'toolNames']);
  expect(spawned).toMatchObject({ id: 'worker', name: 'worker', state: 'idle', toolNames: [] });

  await port.send(message('owner', 'worker', 'message', 'hi'));
  const page = await port.inbox('worker');
  expect(page.messages).toHaveLength(1);
  expect(page.messages[0]?.content).toBe('hi');
  expect(page.messages[0]?.reply_to).toBeUndefined();
  const empty = await port.inbox('worker', page.cursor);
  expect(empty.messages).toHaveLength(0);

  const task = message('owner', 'worker', 'task', 'hello');
  await port.send(task);
  const resultPage = await waitFor(async () => {
    const current = await port.inbox('owner');
    return current.messages.length > 0 ? current : undefined;
  });
  expect(resultPage.messages[0]).toMatchObject({
    kind: 'result',
    from: 'worker',
    to: 'owner',
    content: 'Echo: hello',
    reply_to: task.id,
  });

  const idle = await waitFor(async () => {
    const status = (await port.status('worker')) as { state: string };
    return status.state === 'idle' ? status : undefined;
  });
  expect(idle.state).toBe('idle');

  const list = (await port.status()) as Array<{ id: string }>;
  expect(list.map((status) => status.id)).toEqual(['worker']);

  expect(events.getHistory().some((event) => event.type === 'team.member.spawned')).toBe(true);
  expect(events.getHistory().some((event) => event.type === 'team.message.sent')).toBe(true);
  expect(events.getHistory().some((event) => event.type === 'team.run.started')).toBe(true);
  expect(events.getHistory().some((event) => event.type === 'team.run.completed')).toBe(true);
  expect(events.getHistory().some((event) => event.type === 'team.message.received')).toBe(true);
}

describe('R4 适配层 parity', () => {
  it('CoreHostAdapter：spawn/send/inbox/status/事件与 0.1 输出一致', async () => {
    const events = new MemoryEventStream();
    const host = new CoreInProcessRuntimeHost();
    const port = new CoreHostAdapter(host, { events });
    await exercisePort(port, events);
    await port.close();
  });

  it('owner 不是成员也能收结果（core 非成员邮箱）', async () => {
    const events = new MemoryEventStream();
    const port = new CoreHostAdapter(new CoreInProcessRuntimeHost(), { events });
    await port.spawn({
      id: 'worker',
      provider: new MemoryLLMProvider(),
      model: 'm',
      pluginHost: new MemoryPluginHost(),
    });
    await port.send(message('owner', 'worker', 'task', 'hello'));

    const inbox = await waitFor(async () => {
      const page = await port.inbox('owner');
      return page.messages.length > 0 ? page : undefined;
    });
    expect(inbox.messages[0]?.kind).toBe('result');
    await port.close();
  });

  it('未知成员保持 0.1 错误文本；未知 inbox 返回空页', async () => {
    const port = new CoreHostAdapter(new CoreInProcessRuntimeHost());
    await expect(port.send(message('owner', 'missing', 'message', 'x'))).rejects.toThrow(
      /unknown team member/,
    );
    await expect(port.cancel('missing')).rejects.toThrow(/unknown team member/);
    await expect(port.status('missing')).rejects.toThrow(/unknown team member/);
    expect((await port.inbox('never-sent')).messages).toEqual([]);
    await port.close();
  });

  it('取消传播：abort 成员 run，状态 cancelled，结果回投 Error', async () => {
    const port = new CoreHostAdapter(new CoreInProcessRuntimeHost());
    await port.spawn({
      id: 'slow',
      provider: abortableProvider,
      model: 'm',
      pluginHost: new MemoryPluginHost(),
    });
    await port.send(message('owner', 'slow', 'task', 'never finish'));

    await waitFor(async () => {
      const status = (await port.status('slow')) as { state: string };
      return status.state === 'running' ? true : undefined;
    });
    await port.cancel('slow');

    const cancelled = await waitFor(async () => {
      const status = (await port.status('slow')) as { state: string };
      return status.state === 'cancelled' ? status : undefined;
    });
    expect(cancelled.state).toBe('cancelled');

    const inbox = await waitFor(async () => {
      const page = await port.inbox('owner');
      return page.messages.length > 0 ? page : undefined;
    });
    expect(inbox.messages[0]?.content).toContain('Error');
    await port.close();
  });
});

/** 延迟返回的 provider：用于制造 running/queued 状态 */
function delayedProvider(delayMs: number): LLMProvider {
  return {
    async chat(req) {
      const user = [...req.messages].reverse().find((item) => item.role === 'user');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { content: `done:${user?.content ?? ''}`, finish_reason: 'stop' };
    },
  };
}

describe('R2 Scheduler 队列语义', () => {
  it('同一成员第二个 task 排队，并按 FIFO 在首个完成后执行', async () => {
    const port = new CoreHostAdapter(
      new CoreInProcessRuntimeHost({
        schedulerOptions: { maxConcurrency: 1, maxQueueSize: 10 },
      }),
    );
    await port.spawn({
      id: 'worker',
      provider: delayedProvider(30),
      model: 'm',
      pluginHost: new MemoryPluginHost(),
    });

    const first = message('owner', 'worker', 'task', 'first');
    const second = message('owner', 'worker', 'task', 'second');
    await port.send(first);
    await port.send(second);

    const inbox = await waitFor(async () => {
      const page = await port.inbox('owner');
      return page.messages.length >= 2 ? page : undefined;
    });
    expect(inbox.messages.map((item) => item.content)).toEqual(['done:first', 'done:second']);
    expect(inbox.messages[0]?.reply_to).toBe(first.id);
    expect(inbox.messages[1]?.reply_to).toBe(second.id);

    const idle = await waitFor(async () => {
      const status = (await port.status('worker')) as { state: string };
      return status.state === 'idle' ? status : undefined;
    });
    expect(idle.state).toBe('idle');
    await port.close();
  });

  it('队列满时 task 返回 Error 结果，不静默丢弃', async () => {
    const port = new CoreHostAdapter(
      new CoreInProcessRuntimeHost({
        schedulerOptions: { maxConcurrency: 1, maxQueueSize: 1 },
      }),
    );
    await port.spawn({
      id: 'worker',
      provider: delayedProvider(80),
      model: 'm',
      pluginHost: new MemoryPluginHost(),
    });

    await port.send(message('owner', 'worker', 'task', 'one'));
    await port.send(message('owner', 'worker', 'task', 'two'));
    await port.send(message('owner', 'worker', 'task', 'three'));

    const inbox = await waitFor(async () => {
      const page = await port.inbox('owner');
      return page.messages.length >= 3 ? page : undefined;
    }, 5000);
    expect(inbox.messages.some((item) => item.content.includes('queue is full'))).toBe(true);
    await port.close();
  });
});

describe('R4 生命周期与事件（F7/F8）', () => {
  it('F7 注入的共享 Host 不会被 close；只关闭本适配器的成员', async () => {
    const shared = new CoreInProcessRuntimeHost();
    const port = new CoreHostAdapter(shared, { ownsHost: false });
    await port.spawn({
      id: 'member',
      provider: new MemoryLLMProvider(),
      model: 'm',
      pluginHost: new MemoryPluginHost(),
    });

    expect(shared.get('member')).toBeDefined();
    await port.close();
    // 成员被关闭，但 Host 仍可用
    expect(shared.get('member')).toBeUndefined();
    const owner = await shared.spawn({
      id: 'owner2',
      provider: new MemoryLLMProvider(),
      model: 'm',
      pluginHost: new MemoryPluginHost(),
    });
    expect(owner.id).toBe('owner2');
    await shared.close();
  });

  it('F7 自己创建的 Host 在 close 时关闭', async () => {
    const own = new CoreInProcessRuntimeHost();
    const port = new CoreHostAdapter(own, { ownsHost: true });
    await port.close();
    await expect(
      own.spawn({
        id: 'late',
        provider: new MemoryLLMProvider(),
        model: 'm',
        pluginHost: new MemoryPluginHost(),
      }),
    ).rejects.toThrow(/closed/);
  });

  it('F8 team.* 同时进入 Host 聚合流与 legacy 事件流', async () => {
    const legacy = new MemoryEventStream();
    const coreHost = new CoreInProcessRuntimeHost();
    const port = new CoreHostAdapter(coreHost, { events: legacy, ownsHost: true });
    await port.spawn({
      id: 'worker',
      provider: new MemoryLLMProvider(),
      model: 'm',
      pluginHost: new MemoryPluginHost(),
    });

    const inLegacy = legacy.getHistory().some((event) => event.type === 'team.member.spawned');
    const inHost = coreHost.events
      .getHistory()
      .some((event) => event.type === 'team.member.spawned');
    expect(inLegacy).toBe(true);
    expect(inHost).toBe(true);
    await port.close();
  });

  it('F8 legacy 事件流就是 Host 聚合流时不重复发布', async () => {
    const coreHost = new CoreInProcessRuntimeHost();
    const port = new CoreHostAdapter(coreHost, { events: coreHost.events, ownsHost: true });
    await port.spawn({
      id: 'worker',
      provider: new MemoryLLMProvider(),
      model: 'm',
      pluginHost: new MemoryPluginHost(),
    });

    const count = coreHost.events
      .getHistory()
      .filter((event) => event.type === 'team.member.spawned').length;
    expect(count).toBe(1);
    await port.close();
  });

  it('结果回投失败发 team.transport.error，不抛进成员 run', async () => {
    const coreHost = new CoreInProcessRuntimeHost();
    const port = new CoreHostAdapter(coreHost, {
      deliverResult: async () => {
        throw Object.assign(new Error('wire down'), { code: 'peer_unreachable' });
      },
    });
    await port.spawn({
      id: 'worker',
      provider: new MemoryLLMProvider(),
      model: 'm',
      pluginHost: new MemoryPluginHost(),
    });
    const task = message('owner', 'worker', 'task', 'hello');
    await port.send(task);

    const event = await waitFor(async () => {
      return coreHost.events.getHistory().find((item) => item.type === 'team.transport.error');
    });
    expect(event.data).toMatchObject({
      code: 'peer_unreachable',
      replyTo: task.id,
      from: 'worker',
      to: 'owner',
    });
    expect((await port.status('worker')) as { state: string }).toMatchObject({ state: 'idle' });
    await port.close();
  });
});

describe('R4 工具面快照', () => {
  it('agent + 5 个 legacy 工具名/必填项/属性保持不变', () => {
    const host = new MemoryPluginHost();
    createTeamPlugin({
      providerFactory: () => new MemoryLLMProvider(),
      model: 'm',
      host: new CoreInProcessRuntimeHost(),
    }).install(host);

    const snapshot = host.listTools().map((tool) => ({
      name: tool.name,
      required: tool.inputSchema.required,
      properties: Object.keys(tool.inputSchema.properties as Record<string, unknown>).sort(),
    }));
    expect(snapshot).toEqual([
      { name: 'team_spawn', required: [], properties: ['model', 'name', 'node', 'systemPrompt'] },
      {
        name: 'team_send',
        required: ['to', 'content'],
        properties: ['content', 'kind', 'node', 'to'],
      },
      { name: 'team_inbox', required: [], properties: ['cursor', 'member', 'node'] },
      { name: 'team_status', required: [], properties: ['member', 'node'] },
      { name: 'team_cancel', required: ['member'], properties: ['member', 'node'] },
      {
        name: 'agent',
        required: ['action'],
        properties: [
          'action',
          'content',
          'member',
          'model',
          'name',
          'system_prompt',
          'to',
          'visibility',
        ],
      },
    ]);
  });

  it('工具输出保持 0.1 字段（spawn / send / inbox）', async () => {
    const host = new MemoryPluginHost();
    createTeamPlugin({
      providerFactory: () => new MemoryLLMProvider(),
      model: 'm',
      host: new CoreInProcessRuntimeHost(),
    }).install(host);

    const spawnRaw = await toolOf(host, 'team_spawn').handler({ name: 'w' }, makeContext());
    const spawned = JSON.parse(spawnRaw) as Record<string, unknown>;
    expect(Object.keys(spawned).sort()).toEqual(['id', 'name', 'state', 'toolNames']);

    const sendRaw = await toolOf(host, 'team_send').handler(
      { to: spawned.id, content: 'hi' },
      makeContext(),
    );
    expect(JSON.parse(sendRaw)).toEqual({ ok: true, to: spawned.id, kind: 'message' });

    const inboxRaw = await toolOf(host, 'team_inbox').handler(
      { member: spawned.id },
      makeContext(),
    );
    const page = JSON.parse(inboxRaw) as { messages: Array<Record<string, unknown>> };
    expect(page.messages[0] && Object.keys(page.messages[0]).sort()).toEqual([
      'content',
      'from',
      'id',
      'kind',
      'to',
      'ts',
    ]);
  });
});
