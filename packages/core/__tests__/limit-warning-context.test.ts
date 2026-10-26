/**
 * 80% 预算预警的模型可见性：除 `agent.limit.warning` 事件外，还要在首次命中时
 * 追加一条持久化 `role: user` / `name: 'vessel:limit'` 尾部消息；每个 run 每个 key 一次。
 */

import { describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  type ChatRequest,
  type LLMProvider,
  type LLMResponse,
  MemoryContextManager,
  MemoryEventStream,
  MemoryPluginHost,
  MemorySessionBackend,
  type RunEvent,
} from '../src/index';

const SYSTEM_PROMPT = 'BASE-SYSTEM';

/**
 * 前两次返回 tool_calls，第三次 stop。
 * 第一次响应计入 80 个 input token（100 上限的 80%），随后的循环在组装第二次请求前
 * 触发预警；第二次响应不再增加 token，避免第三轮先撞硬上限。
 */
class LimitWarningProvider implements LLMProvider {
  readonly requests: ChatRequest[] = [];

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const call = this.requests.length;
    const usage =
      call === 1
        ? { prompt_tokens: 80, completion_tokens: 0, total_tokens: 80 }
        : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    if (call <= 2) {
      return {
        content: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          { id: `call-${call}`, type: 'function', function: { name: 'noop', arguments: '{}' } },
        ],
        usage,
      };
    }
    return { content: 'done', finish_reason: 'stop', usage };
  }
}

function noopHost(): MemoryPluginHost {
  const host = new MemoryPluginHost();
  host.registerTool({
    name: 'noop',
    description: 'noop',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => 'ok',
  });
  return host;
}

function systemContent(request: ChatRequest | undefined): string | undefined {
  return request?.messages.find((message) => message.role === 'system')?.content;
}

function limitMessages(request: ChatRequest | undefined) {
  return (request?.messages ?? []).filter((message) => message.name === 'vessel:limit');
}

describe('limit warning becomes a model-visible tail message', () => {
  it('appends one vessel:limit user message at 80% without touching system', async () => {
    const provider = new LimitWarningProvider();
    const events = new MemoryEventStream();
    const warnings: RunEvent[] = [];
    const blocked: RunEvent[] = [];
    events.subscribe((event) => {
      if (event.type === 'agent.limit.warning') warnings.push(event);
      if (event.type === 'limit.blocked') blocked.push(event);
    });

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      systemPrompt: SYSTEM_PROMPT,
      context: new MemoryContextManager({ autoCompact: false }),
      events,
      pluginHost: noopHost(),
      session: new MemorySessionBackend(),
      limits: { inputTokensLimit: 100 },
      termination: { maxIterations: 20 },
    });

    await expect(runtime.run('go')).resolves.toBe('done');

    // 事件保持不变，且只发一次。
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.data).toMatchObject({
      scope: 'run',
      key: 'input_tokens_limit',
      current: 80,
      max: 100,
      source: 'limits.inputTokensLimit',
      threshold: 0.8,
    });
    expect(blocked).toHaveLength(0);

    expect(provider.requests).toHaveLength(3);
    // 第一次请求在 80% 命中前组装，因此看不到预警消息。
    expect(limitMessages(provider.requests[0])).toHaveLength(0);

    // 后续每轮请求都能看到这条已持久化的尾部消息，且只有一条。
    for (const request of provider.requests.slice(1)) {
      const messages = limitMessages(request);
      expect(messages).toHaveLength(1);
      const message = messages[0];
      expect(message?.role).toBe('user');
      expect(message?.content).toBe(
        '[runtime] input_tokens_limit: 80/100 (80%) — Increase limits.inputTokensLimit or compact the conversation history.',
      );
    }

    // system 始终是原基底，未被预警消息改写。
    for (const request of provider.requests) {
      expect(systemContent(request)).toBe(SYSTEM_PROMPT);
    }
  });
});
