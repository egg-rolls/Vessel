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
 * CONTRACT-hot-apply §3：notice 经 BeforeLlm 注入模型上下文，
 * **不写 session 历史**，且同一条只注入一次（真实 AgentRuntime 端到端）。
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
  it('注入为 system 上下文的一行 [runtime]，不进对话消息', async () => {
    const captured: Message[][] = [];
    const host = new MemoryPluginHost();
    const bus = createRuntimeNoticeBus();
    host.registerHook(createRuntimeNoticeHook({ bus }));
    const runtime = await makeRuntime(captured, host);

    bus.publish({ scope: 'permission', summary: 'permission: bash always ask', ok: true });
    await runtime.run('hi');

    expect(systemMessage(captured[0])).toBe('BASE PROMPT\n\n[runtime] permission: bash always ask');
    // 历史里没有这条通知：只有 user 消息。
    expect(captured[0]?.filter((message) => message.role === 'user')).toHaveLength(1);

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

    expect(systemMessage(captured[0])).toContain('[runtime] tools: +1 -0');
    expect(systemMessage(captured[1])).not.toContain('[runtime] tools: +1 -0');

    await runtime.dispose();
  });

  it('新通知在第二轮注入', async () => {
    const captured: Message[][] = [];
    const host = new MemoryPluginHost();
    const bus = createRuntimeNoticeBus();
    host.registerHook(createRuntimeNoticeHook({ bus }));
    const runtime = await makeRuntime(captured, host);

    await runtime.run('first');
    bus.publish({ scope: 'mcp', summary: 'mcp: filesystem disabled', ok: true });
    await runtime.run('second');

    expect(systemMessage(captured[0])).not.toContain('[runtime]');
    expect(systemMessage(captured[1])).toContain('[runtime] mcp: filesystem disabled');

    await runtime.dispose();
  });
});
