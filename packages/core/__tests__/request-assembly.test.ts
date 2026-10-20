import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import type { Message } from '../src/types/provider';
import type { ToolCall } from '../src/types/tool';

/** 捕获每次 LLM 请求的 messages，并返回 stop 响应 */
async function createCapturingRuntime(context: MemoryContextManager, systemPrompt?: string) {
  const captured: Message[][] = [];
  const provider = {
    chat: async (req: { messages: Message[] }) => {
      captured.push(req.messages);
      return { content: 'ok', finish_reason: 'stop' as const };
    },
  };
  const runtime = await AgentRuntime.create({
    provider,
    model: 'test-model',
    pluginHost: new MemoryPluginHost(),
    context,
    events: new MemoryEventStream(),
    limits: { requestLimit: 10, toolCallsLimit: 5 },
    termination: { maxIterations: 10 },
    systemPrompt,
  });
  return { runtime, captured };
}

/** 构造一条带 tool_calls 的 assistant 消息 */
function assistantWithCalls(content: string, ids: string[]): Message {
  const toolCalls: ToolCall[] = ids.map((id) => ({
    id,
    type: 'function',
    function: { name: 'noop', arguments: '{}' },
  }));
  return { role: 'assistant', content, tool_calls: toolCalls };
}

describe('请求消息组装归一化（C-03）', () => {
  it('上下文缺少 system 时补回基底 systemPrompt', async () => {
    const context = new MemoryContextManager();
    context.add({ role: 'user', content: 'previous' });

    const { runtime, captured } = await createCapturingRuntime(context, 'BASE');
    await runtime.run('next');

    expect(captured[0]?.[0]).toEqual({ role: 'system', content: 'BASE' });
  });

  it('丢弃没有对应 tool_call 的孤儿 role:tool 消息', async () => {
    const context = new MemoryContextManager();
    context.add({ role: 'tool', tool_call_id: 'ghost', content: 'orphan' });
    context.add({ role: 'user', content: 'previous' });

    const { runtime, captured } = await createCapturingRuntime(context);
    await runtime.run('next');

    // 请求里不应出现孤儿 tool 消息
    expect(captured[0]?.some((m) => m.role === 'tool')).toBe(false);
    // 持久化记录保持不变（R3：只改请求输出）
    expect(context.messages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('assistant(tool_calls) 无结果时降级为普通 assistant 文本', async () => {
    const context = new MemoryContextManager();
    context.add(assistantWithCalls('partial', ['c1']));
    context.add({ role: 'user', content: 'previous' });

    const { runtime, captured } = await createCapturingRuntime(context);
    await runtime.run('next');

    const assistant = captured[0]?.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('partial');
    expect(assistant?.tool_calls).toBeUndefined();
    expect(captured[0]?.some((m) => m.role === 'tool')).toBe(false);
  });

  it('tool_calls 只拿到部分结果时整轮降级，丢弃部分 tool 结果', async () => {
    const context = new MemoryContextManager();
    context.add(assistantWithCalls('partial', ['c1', 'c2']));
    context.add({ role: 'tool', tool_call_id: 'c1', content: 'r1' });
    context.add({ role: 'user', content: 'previous' });

    const { runtime, captured } = await createCapturingRuntime(context);
    await runtime.run('next');

    const assistant = captured[0]?.find((m) => m.role === 'assistant');
    expect(assistant?.tool_calls).toBeUndefined();
    expect(captured[0]?.some((m) => m.role === 'tool')).toBe(false);
  });

  it('compact 之后仍不发送孤儿 tool 消息', async () => {
    const context = new MemoryContextManager();
    context.add({ role: 'system', content: 'S' });
    for (let i = 0; i < 6; i++) {
      context.add(assistantWithCalls('', [`c${i}`]));
      context.add({ role: 'tool', tool_call_id: `c${i}`, content: `r${i}` });
      context.add({ role: 'user', content: `u${i}` });
    }

    const removed = context.compact();
    expect(removed).toBeGreaterThan(0);

    const { runtime, captured } = await createCapturingRuntime(context, 'S');
    await runtime.run('next');

    const messages = captured[0] ?? [];
    const calledIds = new Set<string>();
    for (const message of messages) {
      if (message.role === 'assistant' && message.tool_calls) {
        for (const call of message.tool_calls) calledIds.add(call.id);
      }
      if (message.role === 'tool') {
        expect(calledIds.has(message.tool_call_id ?? '')).toBe(true);
      }
    }
  });

  it('完整的 assistant(tool_calls) + tool 结果保持原样', async () => {
    const context = new MemoryContextManager();
    context.add(assistantWithCalls('', ['c1']));
    context.add({ role: 'tool', tool_call_id: 'c1', content: 'r1' });
    context.add({ role: 'user', content: 'previous' });

    const { runtime, captured } = await createCapturingRuntime(context);
    await runtime.run('next');

    const toolMessages = captured[0]?.filter((m) => m.role === 'tool') ?? [];
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toBe('r1');
    const assistant = captured[0]?.find((m) => m.role === 'assistant');
    expect(assistant?.tool_calls?.[0]?.id).toBe('c1');
  });
});
