import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import { PromptPrefixChangedError, PromptPrefixGuard } from '../src/runtime/prompt-prefix-guard';
import type { ChatRequest, LLMProvider, LLMResponse, Message } from '../src/types/provider';

const ORIGINAL_STRICT = process.env.VESSEL_STRICT_PREFIX;

afterEach(() => {
  if (ORIGINAL_STRICT === undefined) delete process.env.VESSEL_STRICT_PREFIX;
  else process.env.VESSEL_STRICT_PREFIX = ORIGINAL_STRICT;
});

function msg(content: string, role: Message['role'] = 'user'): Message {
  return { role, content };
}

function prefixEvents(events: MemoryEventStream) {
  return events.getHistory().filter((event) => event.type === 'prompt.prefix_changed');
}

describe('PromptPrefixGuard', () => {
  it('accepts an append-only message sequence', () => {
    const events = new MemoryEventStream();
    const guard = new PromptPrefixGuard(events);

    const base = [msg('one'), msg('two', 'assistant')];
    expect(guard.check({ sessionId: 's', system: 'SYS', tools: '[]', messages: base })).toEqual({
      ok: true,
      systemChanged: false,
      toolsChanged: false,
    });

    expect(
      guard.check({
        sessionId: 's',
        system: 'SYS',
        tools: '[]',
        messages: [...base, msg('three')],
      }),
    ).toEqual({ ok: true, systemChanged: false, toolsChanged: false });
    expect(prefixEvents(events)).toHaveLength(0);
  });

  it('reports + emits when a middle message is rewritten', () => {
    const events = new MemoryEventStream();
    const guard = new PromptPrefixGuard(events);
    guard.check({
      sessionId: 's',
      system: 'SYS',
      tools: '[]',
      messages: [msg('one'), msg('two'), msg('three')],
    });

    const result = guard.check({
      sessionId: 's',
      system: 'SYS',
      tools: '[]',
      messages: [msg('one'), msg('REWRITTEN'), msg('three')],
    });

    expect(result.ok).toBe(false);
    expect(result.divergedAt).toBe(1);
    const [event] = prefixEvents(events);
    expect(event?.data).toMatchObject({
      session_id: 's',
      diverged_at: 1,
      system_changed: false,
      tools_changed: false,
    });
  });

  it('throws in strict mode (VESSEL_STRICT_PREFIX=1)', () => {
    process.env.VESSEL_STRICT_PREFIX = '1';
    const guard = new PromptPrefixGuard();
    guard.check({ sessionId: 's', system: 'SYS', tools: '[]', messages: [msg('one')] });

    expect(() =>
      guard.check({ sessionId: 's', system: 'SYS', tools: '[]', messages: [msg('two')] }),
    ).toThrow(PromptPrefixChangedError);
  });

  it('allows a rewrite with reason compaction without emitting', () => {
    const events = new MemoryEventStream();
    const guard = new PromptPrefixGuard(events);
    guard.check({
      sessionId: 's',
      system: 'SYS',
      tools: '[]',
      messages: [msg('one'), msg('two'), msg('three')],
    });

    const result = guard.check({
      sessionId: 's',
      system: 'SYS',
      tools: '[]',
      messages: [
        msg('one'),
        { role: 'system', content: 'SUMMARY', compaction_summary: true },
        msg('three'),
      ],
      reason: 'compaction',
    });

    expect(result.ok).toBe(true);
    expect(result.divergedAt).toBe(1);
    expect(prefixEvents(events)).toHaveLength(0);
  });

  it('emits for a system change without a message rewrite', () => {
    const events = new MemoryEventStream();
    const guard = new PromptPrefixGuard(events);
    const messages = [msg('one')];
    guard.check({ sessionId: 's', system: 'SYS', tools: '[]', messages });

    const result = guard.check({ sessionId: 's', system: 'SYS-V2', tools: '[]', messages });

    expect(result.ok).toBe(true);
    expect(result.systemChanged).toBe(true);
    expect(result.toolsChanged).toBe(false);
    expect(prefixEvents(events)[0]?.data).toMatchObject({
      session_id: 's',
      system_changed: true,
      tools_changed: false,
    });
  });

  it('emits for a tools change', () => {
    const events = new MemoryEventStream();
    const guard = new PromptPrefixGuard(events);
    const messages = [msg('one')];
    guard.check({ sessionId: 's', system: 'SYS', tools: '[]', messages });

    const result = guard.check({
      sessionId: 's',
      system: 'SYS',
      tools: '[{"name":"read"}]',
      messages,
    });

    expect(result.ok).toBe(true);
    expect(result.toolsChanged).toBe(true);
    expect(prefixEvents(events)[0]?.data).toMatchObject({ tools_changed: true });
  });

  it('reports a truncated tail as divergence', () => {
    const events = new MemoryEventStream();
    const guard = new PromptPrefixGuard(events);
    guard.check({ sessionId: 's', system: 'SYS', tools: '[]', messages: [msg('one'), msg('two')] });

    const result = guard.check({
      sessionId: 's',
      system: 'SYS',
      tools: '[]',
      messages: [msg('one')],
    });

    expect(result.ok).toBe(false);
    expect(result.divergedAt).toBe(1);
    expect(prefixEvents(events)).toHaveLength(1);
  });
});

/** 第一轮调用工具、第二轮结束，用于在一个 run 内产生两次请求 */
function toolThenStop(toolName: string): LLMProvider {
  let requests = 0;
  return {
    chat: async (_req: ChatRequest): Promise<LLMResponse> => {
      requests += 1;
      if (requests === 1) {
        return {
          content: '',
          finish_reason: 'tool_calls',
          tool_calls: [
            { id: 'call-1', type: 'function', function: { name: toolName, arguments: '{}' } },
          ],
        };
      }
      return { content: 'done', finish_reason: 'stop' };
    },
  };
}

describe('PromptPrefixGuard + compaction', () => {
  it('does not flag an automatic compaction during a run', async () => {
    const events = new MemoryEventStream();
    const host = new MemoryPluginHost();
    host.registerTool({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'ok',
    });
    const runtime = await AgentRuntime.create({
      provider: toolThenStop('noop'),
      model: 'test-model',
      pluginHost: host,
      // 极小的预算让 second iteration 的 autoCompactAsync 真正移除一条消息；
      // 配 summarizer 关闭 add() 里的同步占位压缩，走 runtime 的显式压缩路径。
      context: new MemoryContextManager({
        maxTokens: 1,
        compactThreshold: 0.1,
        summarizer: async () => 'SUMMARY',
      }),
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      systemPrompt: 'BASE',
    });

    const response = await runtime.run('hi');

    expect(response).toBe('done');
    expect(events.getHistory().filter((event) => event.type === 'context.compacted')).toHaveLength(
      1,
    );
    expect(prefixEvents(events)).toHaveLength(0);
  });
});
