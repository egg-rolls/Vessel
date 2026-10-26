import { describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  MemoryContextManager,
  MemoryEventStream,
  MemoryPluginHost,
  MemorySessionBackend,
  type Message,
} from '../../packages/core/src/index';
import { createRuntimeNoticeBus } from '../runtime-notice';
import { createRuntimeNoticeHook } from '../runtime-notice-hook';

/**
 * CONTRACT-hot-apply §3：notice 经 BeforeLlm 追加为 `vessel:notice` 上下文消息，
 * 不改 system 前缀，且同一条只注入一次（真实 AgentRuntime 端到端）。
 */
function provider(captured: Message[][]) {
  return {
    chat: async (req: { messages: Message[] }) => {
      captured.push(req.messages.map((message) => ({ ...message })));
      return { content: 'done', finish_reason: 'stop' as const };
    },
  };
}

async function makeRuntime(captured: Message[][], host: MemoryPluginHost) {
  return AgentRuntime.create({
    provider: provider(captured),
    model: 'test-model',
    context: new MemoryContextManager(),
    events: new MemoryEventStream(),
    pluginHost: host,
    session: new MemorySessionBackend(),
    limits: {},
    termination: { maxIterations: 1 },
    systemPrompt: 'BASE PROMPT',
  });
}

function systemMessage(messages: Message[] | undefined): string {
  const first = messages?.[0];
  return first?.role === 'system' ? (first.content ?? '') : '';
}

describe('runtime.notice → BeforeLlm（端到端）', () => {
  it('追加为 vessel:notice 消息，不改 system 前缀', async () => {
    const captured: Message[][] = [];
    const host = new MemoryPluginHost();
    const bus = createRuntimeNoticeBus();
    host.registerHook(createRuntimeNoticeHook({ bus }));
    const runtime = await makeRuntime(captured, host);

    bus.publish({ scope: 'permission', summary: 'permission: bash always ask', ok: true });
    await runtime.run('hi');

    // system 保持字节稳定：缓存前缀不被通知打断。
    expect(systemMessage(captured[0])).toBe('BASE PROMPT');
    const notice = captured[0]?.find((message) => message.name === 'vessel:notice');
    expect(notice?.content).toBe('[runtime] permission: bash always ask');
    expect(captured[0]?.filter((message) => message.role === 'user')).toHaveLength(2);

    await runtime.dispose();
  });

  it('第二轮不重复注入同一条通知', async () => {
    const captured: Message[][] = [];
    const host = new MemoryPluginHost();
    const bus = createRuntimeNoticeBus();
    host.registerHook(createRuntimeNoticeHook({ bus }));
    const runtime = await makeRuntime(captured, host);

    bus.publish({ scope: 'tools', summary: 'tools: +1 -0', ok: true });
    await runtime.run('first');
    await runtime.run('second');

    const notices = (messages: Message[] | undefined) =>
      messages?.filter((message) => message.name === 'vessel:notice') ?? [];
    expect(notices(captured[0])).toHaveLength(1);
    expect(notices(captured[1])).toHaveLength(1);
    expect(notices(captured[1])?.[0]?.content).toBe('[runtime] tools: +1 -0');

    await runtime.dispose();
  });

  it('新通知在第二轮追加', async () => {
    const captured: Message[][] = [];
    const host = new MemoryPluginHost();
    const bus = createRuntimeNoticeBus();
    host.registerHook(createRuntimeNoticeHook({ bus }));
    const runtime = await makeRuntime(captured, host);

    await runtime.run('first');
    bus.publish({ scope: 'mcp', summary: 'mcp: filesystem disabled', ok: true });
    await runtime.run('second');

    const firstNotices = captured[0]?.filter((message) => message.name === 'vessel:notice') ?? [];
    const secondNotices = captured[1]?.filter((message) => message.name === 'vessel:notice') ?? [];
    expect(firstNotices).toHaveLength(0);
    expect(secondNotices).toHaveLength(1);
    expect(secondNotices[0]?.content).toBe('[runtime] mcp: filesystem disabled');

    await runtime.dispose();
  });
});
