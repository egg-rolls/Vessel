/**
 * BeforeLlm 消息注入（0.16 E5）
 *
 * 守卫的故障：
 * - 成员回复没有进入请求 / 上下文 → 父 turn 永远看不到回复；
 * - 同一批注入消息在每次 LLM 迭代重复写入 → 上下文膨胀且模型看到重复回复；
 * - 未设置 messages 时请求形状发生变化 → 默认行为回归；
 * - 注入顺序或 tool 配对被破坏 → Provider 收到非法序列。
 */
import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemorySessionBackend } from '../src/session/session-backend';
import { type HookContext, HookType } from '../src/types/hook';
import type { Plugin } from '../src/types/plugin';
import type { ChatRequest, LLMProvider, LLMResponse, Message } from '../src/types/provider';

/** 按调用顺序返回预设响应，并记录每次请求 */
class SequenceProvider implements LLMProvider {
  readonly requests: ChatRequest[] = [];

  constructor(private readonly responses: LLMResponse[]) {}

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const index = Math.min(this.requests.length - 1, this.responses.length - 1);
    return this.responses[index] as LLMResponse;
  }
}

const TOOL_CALL_RESPONSE: LLMResponse = {
  content: '',
  finish_reason: 'tool_calls',
  tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
};

const FINAL_RESPONSE: LLMResponse = { content: 'done', finish_reason: 'stop' };

/** 注册 BeforeLlm hook + noop 工具 */
function injectorPlugin(batch: () => Message[] | undefined): Plugin {
  return {
    name: 'before-llm-injector',
    install: (host) => {
      host.registerTool({
        name: 'noop',
        description: 'noop',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => 'tool-ok',
      });
      host.registerHook({
        name: 'inject-messages',
        type: HookType.BeforeLlm,
        run: async (ctx: HookContext) => {
          const messages = batch();
          if (messages) ctx.messages = messages;
        },
      });
    },
  };
}

async function buildRuntime(opts: {
  plugins?: Plugin[];
  responses: LLMResponse[];
  systemPrompt?: string;
}) {
  const provider = new SequenceProvider(opts.responses);
  const context = new MemoryContextManager();
  const runtime = await AgentRuntime.create({
    provider,
    model: 'test',
    context,
    events: new MemoryEventStream(),
    limits: { requestLimit: 10, toolCallsLimit: 5 },
    termination: { maxIterations: 10 },
    session: new MemorySessionBackend(),
    plugins: opts.plugins ?? [],
    ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
  });
  return { runtime, provider, context };
}

/** [role, content] 序列，便于断言请求形状与顺序 */
function shape(messages: readonly Message[]): Array<[string, string]> {
  return messages.map((m) => [m.role, m.content]);
}

const REPLY: Message = {
  role: 'user',
  content: 'MEMBER-REPLY',
  name: 'member-a',
  timestamp: 1_700_000_000_000,
};

describe('BeforeLlm 消息注入（0.16 E5）', () => {
  it('注入消息进入本次请求且写入上下文', async () => {
    const { runtime, provider, context } = await buildRuntime({
      systemPrompt: 'BASE-SYSTEM',
      responses: [FINAL_RESPONSE],
      plugins: [injectorPlugin(() => [REPLY])],
    });
    await runtime.run('hi');

    const request = provider.requests[0]?.messages ?? [];
    expect(shape(request)).toEqual([
      ['system', 'BASE-SYSTEM'],
      ['user', 'hi'],
      ['user', 'MEMBER-REPLY'],
    ]);
    expect(context.messages.filter((m) => m.content === 'MEMBER-REPLY')).toHaveLength(1);
  });

  it('同一批消息在后续 LLM 迭代不重复注入', async () => {
    const { runtime, provider, context } = await buildRuntime({
      systemPrompt: 'BASE-SYSTEM',
      responses: [TOOL_CALL_RESPONSE, FINAL_RESPONSE],
      // 每次 hook 都返回新建对象，只能靠 name / timestamp 去重
      plugins: [injectorPlugin(() => [{ ...REPLY }])],
    });
    await runtime.run('hi');

    expect(provider.requests).toHaveLength(2);
    const first = provider.requests[0]?.messages ?? [];
    const second = provider.requests[1]?.messages ?? [];
    expect(first.filter((m) => m.content === 'MEMBER-REPLY')).toHaveLength(1);
    expect(second.filter((m) => m.content === 'MEMBER-REPLY')).toHaveLength(1);
    expect(context.messages.filter((m) => m.content === 'MEMBER-REPLY')).toHaveLength(1);
  });

  it('hook 不设置 messages 时请求与无注入基线一致', async () => {
    const base = await buildRuntime({
      systemPrompt: 'BASE-SYSTEM',
      responses: [FINAL_RESPONSE],
    });
    const withHook = await buildRuntime({
      systemPrompt: 'BASE-SYSTEM',
      responses: [FINAL_RESPONSE],
      plugins: [injectorPlugin(() => undefined)],
    });

    await base.runtime.run('hi');
    await withHook.runtime.run('hi');

    expect(shape(withHook.provider.requests[0]?.messages ?? [])).toEqual(
      shape(base.provider.requests[0]?.messages ?? []),
    );
    expect(shape(withHook.provider.requests[0]?.messages ?? [])).toEqual([
      ['system', 'BASE-SYSTEM'],
      ['user', 'hi'],
    ]);
  });

  it('注入顺序保持 hook 返回顺序，且不切断 tool 配对', async () => {
    const batch: Message[] = [
      { role: 'user', content: 'REPLY-1', name: 'member-a', timestamp: 1 },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'injected_call', type: 'function', function: { name: 'noop', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'injected_call', content: 'INJECTED-TOOL-RESULT' },
    ];
    const { runtime, provider } = await buildRuntime({
      systemPrompt: 'BASE-SYSTEM',
      responses: [FINAL_RESPONSE],
      plugins: [injectorPlugin(() => batch)],
    });
    await runtime.run('hi');

    const request = provider.requests[0]?.messages ?? [];
    expect(shape(request)).toEqual([
      ['system', 'BASE-SYSTEM'],
      ['user', 'hi'],
      ['user', 'REPLY-1'],
      ['assistant', ''],
      ['tool', 'INJECTED-TOOL-RESULT'],
    ]);
    expect(request[3]?.tool_calls?.[0]?.id).toBe('injected_call');
    expect(request[4]?.tool_call_id).toBe('injected_call');
  });
});
