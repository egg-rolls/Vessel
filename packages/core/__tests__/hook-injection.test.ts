/**
 * BeforeLlm hook 注入消费测试（ADR-018）
 *
 * 验证 BeforeLlm hook 写入 ctx.systemPrompt 的内容会进入 LLM 请求的 system 消息，
 * 且不污染 ContextManager 持久化的消息。
 */
import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import { MemorySessionBackend } from '../src/session/session-backend';
import { GuardrailStage } from '../src/types/guardrail';
import { type HookContext, HookType } from '../src/types/hook';
import type { Plugin } from '../src/types/plugin';
import type { ChatRequest, LLMProvider, LLMResponse, Message } from '../src/types/provider';

/** 捕获 req.messages 的 Provider */
class CapturingProvider implements LLMProvider {
  receivedMessages: Message[] = [];
  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.receivedMessages = req.messages;
    return {
      content: 'ok',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
}

/** 注入 ctx.systemPrompt 的插件（模拟 skills / memory 注入） */
function injectPlugin(prefix: string): Plugin {
  return {
    name: `test-inject-${prefix}`,
    install: (host) => {
      host.registerHook({
        name: `inject-${prefix}`,
        type: HookType.BeforeLlm,
        run: async (ctx: HookContext) => {
          ctx.systemPrompt = `${prefix}\n${ctx.systemPrompt ?? ''}`;
        },
      });
    },
  };
}

async function buildRuntime(opts: { systemPrompt?: string; plugins: Plugin[] }) {
  const provider = new CapturingProvider();
  const context = new MemoryContextManager();
  const events = new MemoryEventStream();
  const runtime = await AgentRuntime.create({
    provider,
    model: 'test',
    context,
    events,
    limits: { requestLimit: 10, toolCallsLimit: 5 },
    termination: { maxIterations: 10 },
    session: new MemorySessionBackend(),
    plugins: opts.plugins,
    systemPrompt: opts.systemPrompt,
  });
  return { runtime, provider, context, events };
}

function ignoredEvents(events: MemoryEventStream) {
  return events.getHistory().filter((event) => event.type === 'hook.system_prompt_ignored');
}

describe('BeforeLlm systemPrompt 冻结（CONTRACT-prefix-invariant）', () => {
  it('hook 写 ctx.systemPrompt 被忽略，请求 system 仍是基底', async () => {
    const { runtime, provider, events } = await buildRuntime({
      systemPrompt: 'BASE-SYSTEM',
      plugins: [injectPlugin('INJECTED')],
    });
    await runtime.run('hi');

    const sysMsg = provider.receivedMessages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toBe('BASE-SYSTEM');
    expect(sysMsg?.content).not.toContain('INJECTED');
    expect(ignoredEvents(events)).toHaveLength(1);
  });

  it('多个 hook 每 run 只报告一次被忽略', async () => {
    const { runtime, events } = await buildRuntime({
      systemPrompt: 'BASE',
      plugins: [injectPlugin('FIRST'), injectPlugin('SECOND')],
    });
    await runtime.run('hi');
    expect(ignoredEvents(events)).toHaveLength(1);

    // 下一次 run 重新计一次（每 run 一次，而非进程一次）。
    await runtime.run('again');
    expect(ignoredEvents(events)).toHaveLength(2);
  });

  it('无基底 systemPrompt 时，hook 写 systemPrompt 也不产生 system 消息', async () => {
    const { runtime, provider, events } = await buildRuntime({
      plugins: [injectPlugin('INJECTED')],
    });
    await runtime.run('hi');

    expect(provider.receivedMessages.some((m) => m.role === 'system')).toBe(false);
    expect(ignoredEvents(events)).toHaveLength(1);
  });

  it('hook 可读取基底 systemPrompt', async () => {
    const seen: Array<string | undefined> = [];
    const { runtime } = await buildRuntime({
      systemPrompt: 'BASE-SYSTEM',
      plugins: [
        {
          name: 'reader',
          install: (host) => {
            host.registerHook({
              name: 'reader',
              type: HookType.BeforeLlm,
              run: async (ctx: HookContext) => {
                seen.push(ctx.systemPrompt);
              },
            });
          },
        },
      ],
    });
    await runtime.run('hi');

    expect(seen).toEqual(['BASE-SYSTEM']);
  });

  it('无写入 hook 时，system 消息仍是基底（回归）', async () => {
    const { runtime, provider, events } = await buildRuntime({
      systemPrompt: 'BASE-SYSTEM',
      plugins: [],
    });
    await runtime.run('hi');

    const sysMsg = provider.receivedMessages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toBe('BASE-SYSTEM');
    expect(ignoredEvents(events)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OnError hook 集成测试（Issue #70）
// ---------------------------------------------------------------------------

/** 注册 OnError hook 并记录调用 */
function onErrorSpyPlugin(calls: Array<{ error: string; phase: string }>): Plugin {
  return {
    name: 'onerror-spy',
    install: (host) => {
      host.registerHook({
        name: 'spy-onerror',
        type: HookType.OnError,
        run: async (ctx: HookContext) => {
          calls.push({
            error: String(ctx.error ?? ''),
            phase: String(ctx.phase ?? ''),
          });
        },
      });
    },
  };
}

describe('OnError hook 触发（Issue #70）', () => {
  it('工具抛出异常时触发 OnError hook', async () => {
    const calls: Array<{ error: string; phase: string }> = [];
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool({
      name: 'broken_tool',
      description: 'always throws',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('tool exploded');
      },
    });

    let callCount = 0;
    const provider: LLMProvider = {
      async chat(_req: ChatRequest): Promise<LLMResponse> {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            finish_reason: 'tool_calls',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'broken_tool', arguments: '{}' },
              },
            ],
          };
        }
        return { content: 'done after error', finish_reason: 'stop' };
      },
    };

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test',
      pluginHost,
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      session: new MemorySessionBackend(),
      plugins: [onErrorSpyPlugin(calls)],
    });

    await runtime.run('use broken tool');

    expect(calls.length).toBe(1);
    expect(calls[0]?.error).toContain('tool exploded');
    expect(calls[0]?.phase).toBe('tool_execution');
  });

  it('Guardrail 阻断输入时触发 OnError hook', async () => {
    const calls: Array<{ error: string; phase: string }> = [];

    const provider: LLMProvider = {
      async chat(_req: ChatRequest): Promise<LLMResponse> {
        return { content: 'ok', finish_reason: 'stop' };
      },
    };

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test',
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      session: new MemorySessionBackend(),
      plugins: [
        onErrorSpyPlugin(calls),
        {
          name: 'blocker',
          install: (host) => {
            host.registerGuardrail({
              name: 'block-all',
              stage: GuardrailStage.Input,
              check: async () => ({ allowed: false, reason: 'blocked by test' }),
            });
          },
        } as Plugin,
      ],
    });

    await expect(runtime.run('bad input')).rejects.toThrow('blocked by test');

    expect(calls.length).toBe(1);
    expect(calls[0]?.error).toContain('blocked by test');
    expect(calls[0]?.phase).toBe('run');
  });
});

describe('Hook 阶段触发顺序（C-09）', () => {
  it('BeforeLlm / AfterLlm / BeforeTool / AfterTool 按顺序触发', async () => {
    const order: string[] = [];

    const provider: LLMProvider = {
      async chat(_req: ChatRequest): Promise<LLMResponse> {
        if (order.filter((label) => label === 'before_llm').length === 1) {
          return {
            content: '',
            finish_reason: 'tool_calls',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'noop', arguments: '{}' },
              },
            ],
          };
        }
        return { content: 'done', finish_reason: 'stop' };
      },
    };

    const hookPlugin: Plugin = {
      name: 'stage-order',
      install: (host) => {
        const stages: Array<[HookType, string]> = [
          [HookType.BeforeLlm, 'before_llm'],
          [HookType.AfterLlm, 'after_llm'],
          [HookType.BeforeTool, 'before_tool'],
          [HookType.AfterTool, 'after_tool'],
        ];
        for (const [type, label] of stages) {
          host.registerHook({
            name: label,
            type,
            run: async () => {
              order.push(label);
            },
          });
        }
        host.registerTool({
          name: 'noop',
          description: 'noop',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => 'ok',
        });
      },
    };

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test',
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      plugins: [hookPlugin],
    });

    await runtime.run('hi');

    expect(order).toEqual([
      'before_llm',
      'after_llm',
      'before_tool',
      'after_tool',
      'before_llm',
      'after_llm',
    ]);
  });
});
