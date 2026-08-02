/**
 * BeforeLlm hook 注入消费测试（ADR-018）
 *
 * 验证 BeforeLlm hook 写入 ctx.system_prompt 的内容会进入 LLM 请求的 system 消息，
 * 且不污染 ContextManager 持久化的消息。
 */
import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemorySessionBackend } from '../src/session/session-backend';
import { MemoryToolRegistry } from '../src/tools/tool-registry';
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

/** 注入 ctx.system_prompt 的插件（模拟 skills-loader / memory-project） */
function injectPlugin(prefix: string): Plugin {
  return {
    name: `test-inject-${prefix}`,
    install: (host) => {
      host.registerHook({
        name: `inject-${prefix}`,
        type: HookType.BeforeLlm,
        run: async (ctx: HookContext) => {
          const ext = ctx as HookContext & { system_prompt?: string };
          ext.system_prompt = `${prefix}\n${ext.system_prompt ?? ''}`;
          return ctx;
        },
      });
    },
  };
}

async function buildRuntime(opts: { systemPrompt?: string; plugins: Plugin[] }) {
  const provider = new CapturingProvider();
  const context = new MemoryContextManager();
  const runtime = await AgentRuntime.create({
    provider,
    model: 'test',
    tools: new MemoryToolRegistry(),
    context,
    events: new MemoryEventStream(),
    limits: { requestLimit: 10, toolCallsLimit: 5 },
    termination: { maxIterations: 10 },
    session: new MemorySessionBackend(),
    plugins: opts.plugins,
    systemPrompt: opts.systemPrompt,
  });
  return { runtime, provider, context };
}

describe('BeforeLlm hook 注入消费（ADR-018）', () => {
  it('hook 注入内容进入 LLM 请求的 system 消息，含基底 systemPrompt', async () => {
    const { runtime, provider } = await buildRuntime({
      systemPrompt: 'BASE-SYSTEM',
      plugins: [injectPlugin('INJECTED')],
    });
    await runtime.run('hi');

    const sysMsg = provider.receivedMessages.find((m) => m.role === 'system');
    expect(sysMsg).toBeDefined();
    expect(sysMsg?.content).toContain('INJECTED');
    expect(sysMsg?.content).toContain('BASE-SYSTEM');
  });

  it('无基底 systemPrompt 时，hook 注入前置一条 system 消息', async () => {
    const { runtime, provider } = await buildRuntime({
      plugins: [injectPlugin('INJECTED')],
    });
    await runtime.run('hi');

    const sysMsg = provider.receivedMessages.find((m) => m.role === 'system');
    expect(sysMsg).toBeDefined();
    expect(sysMsg?.content).toContain('INJECTED');
  });

  it('注入不污染 ContextManager 持久化的消息', async () => {
    const { runtime, provider, context } = await buildRuntime({
      systemPrompt: 'BASE-SYSTEM',
      plugins: [injectPlugin('INJECTED')],
    });
    await runtime.run('hi');

    // 请求侧有注入
    expect(provider.receivedMessages.find((m) => m.role === 'system')?.content).toContain(
      'INJECTED',
    );
    // 持久化侧仍是纯基底
    const persisted = context.messages.find((m) => m.role === 'system');
    expect(persisted?.content).toBe('BASE-SYSTEM');
    expect(persisted?.content).not.toContain('INJECTED');
  });

  it('多个 hook 链式 prepend，都进入请求', async () => {
    const { runtime, provider } = await buildRuntime({
      systemPrompt: 'BASE',
      plugins: [injectPlugin('FIRST'), injectPlugin('SECOND')],
    });
    await runtime.run('hi');

    const sys = provider.receivedMessages.find((m) => m.role === 'system')?.content ?? '';
    expect(sys).toContain('FIRST');
    expect(sys).toContain('SECOND');
    expect(sys).toContain('BASE');
  });

  it('无注入 hook 时，system 消息仍是基底（回归）', async () => {
    const { runtime, provider } = await buildRuntime({
      systemPrompt: 'BASE-SYSTEM',
      plugins: [],
    });
    await runtime.run('hi');

    const sysMsg = provider.receivedMessages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toBe('BASE-SYSTEM');
  });
});
