/**
 * 0.14 P0：结构化错误 envelope（DECISION-025 §1.2）。
 *
 * - 纯函数覆盖权限 / 工具 / provider / internal 的稳定分类；
 * - 事件接线（run.failed / tool.call.failed）保留原 error 文本并追加 additive 字段。
 */
import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { LimitExceededError } from '../src/limits/limit-error';
import { ProviderHttpError } from '../src/provider/errors';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { toErrorEnvelope } from '../src/runtime/error-envelope';
import { PermissionAbortedError, PermissionTimeoutError } from '../src/runtime/permission-policy';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import type { LLMResponse, Message } from '../src/types/provider';
import { RunAlreadyRunningError, RunResumeError } from '../src/types/run-store';
import type { ToolDefinition } from '../src/types/tool';

describe('toErrorEnvelope', () => {
  it('classifies permission timeout and abort', () => {
    expect(toErrorEnvelope(new PermissionTimeoutError())).toEqual({
      error_code: 'permission_timeout',
      category: 'permission',
      phase: 'permission',
      retryable: false,
    });

    expect(toErrorEnvelope(new PermissionAbortedError('user'))).toEqual({
      error_code: 'permission_cancelled',
      category: 'permission',
      phase: 'permission',
      retryable: false,
    });
  });

  it('classifies permission denial as a permission error', () => {
    expect(
      toErrorEnvelope(new Error('Tool "bash" execution denied by permission policy')),
    ).toMatchObject({
      error_code: 'permission_denied',
      category: 'permission',
      phase: 'permission',
      retryable: false,
    });
  });

  it('classifies provider HTTP errors and keeps the status', () => {
    expect(toErrorEnvelope(new Error('OpenAI API error: 401 - bad key'))).toMatchObject({
      error_code: 'provider_auth',
      category: 'provider',
      phase: 'llm',
      retryable: false,
      http_status: 401,
    });

    expect(
      toErrorEnvelope(new Error('Anthropic API error: 429 - slow down'), { phase: 'llm' }),
    ).toMatchObject({
      error_code: 'provider_rate_limit',
      category: 'provider',
      retryable: true,
      http_status: 429,
    });

    expect(
      toErrorEnvelope(new Error('HTTP 503 - upstream unavailable'), { phase: 'llm' }),
    ).toMatchObject({
      error_code: 'provider_unavailable',
      category: 'provider',
      retryable: true,
      http_status: 503,
    });
  });

  it('classifies provider network and context overflow', () => {
    expect(
      toErrorEnvelope(new Error('fetch failed: ECONNREFUSED'), { phase: 'llm' }),
    ).toMatchObject({
      error_code: 'provider_network',
      category: 'provider',
      retryable: true,
    });

    expect(
      toErrorEnvelope(new Error('OpenAI API error: 400 - maximum context length exceeded'), {
        phase: 'llm',
      }),
    ).toMatchObject({
      error_code: 'provider_context_overflow',
      category: 'provider',
      retryable: false,
      http_status: 400,
    });
  });

  it('classifies tool failures by message', () => {
    expect(
      toErrorEnvelope(new Error('Tool "bash" timed out after 50ms'), { phase: 'tool' }),
    ).toMatchObject({
      error_code: 'tool_timeout',
      category: 'tool',
      phase: 'tool',
      retryable: true,
    });

    expect(toErrorEnvelope(new Error('Tool "missing" not found'), { phase: 'tool' })).toMatchObject(
      { error_code: 'tool_not_found', category: 'tool' },
    );

    expect(
      toErrorEnvelope(new Error('Invalid JSON in tool arguments: Unexpected token'), {
        phase: 'tool',
      }),
    ).toMatchObject({ error_code: 'tool_invalid_arguments', category: 'tool' });

    expect(
      toErrorEnvelope(new Error('Tool call blocked by hook: denied'), { phase: 'tool' }),
    ).toMatchObject({ error_code: 'tool_blocked', category: 'tool' });

    expect(toErrorEnvelope(new Error('boom'), { phase: 'tool' })).toMatchObject({
      error_code: 'tool_error',
      category: 'tool',
      retryable: false,
    });
  });

  it('classifies run lifecycle errors', () => {
    expect(toErrorEnvelope(new RunAlreadyRunningError('r1'))).toMatchObject({
      error_code: 'run_already_running',
      category: 'internal',
      phase: 'input',
      retryable: true,
    });

    expect(
      toErrorEnvelope(new RunResumeError('run_not_resumable', 'r1', 'completed')),
    ).toMatchObject({
      error_code: 'run_not_resumable',
      category: 'internal',
      phase: 'input',
      retryable: false,
    });

    expect(toErrorEnvelope(new Error('run_checkpoint_failed: disk full'))).toMatchObject({
      error_code: 'checkpoint_failed',
      category: 'internal',
      phase: 'checkpoint',
      retryable: true,
    });
  });

  it('maps limit_blocked to internal/run and passes the block through as details', () => {
    const block = {
      scope: 'run' as const,
      key: 'input_tokens_limit' as const,
      current: 100235,
      max: 100000,
      source: 'limits.inputTokensLimit',
      hint: 'Increase limits.inputTokensLimit or compact the conversation history.',
      retryable: false as const,
    };

    expect(toErrorEnvelope(new LimitExceededError(block), { phase: 'llm' })).toEqual({
      error_code: 'limit_blocked',
      category: 'internal',
      phase: 'run',
      retryable: false,
      details: { ...block },
    });
  });

  it('reads http_status from ProviderHttpError instead of the message fallback', () => {
    expect(
      toErrorEnvelope(new ProviderHttpError('OpenAI', 429, 'slow down', 2000), { phase: 'llm' }),
    ).toMatchObject({
      error_code: 'provider_rate_limit',
      category: 'provider',
      phase: 'llm',
      retryable: true,
      http_status: 429,
    });
  });

  it('honors explicit category/details and omits empty details', () => {
    const error = new Error('socket closed');
    expect(
      toErrorEnvelope(error, {
        category: 'gateway',
        details: { request_id: 'req-1' },
      }),
    ).toEqual({
      error_code: 'gateway_error',
      category: 'gateway',
      phase: 'run',
      retryable: false,
      details: { request_id: 'req-1' },
    });

    expect(toErrorEnvelope(error, { category: 'gateway', details: {} })).not.toHaveProperty(
      'details',
    );
  });
});

/** 第一次返回 tool_calls，之后返回 stop */
function toolCallThenStopProvider(toolName: string) {
  let calls = 0;
  return {
    chat: async (req: { messages: Message[] }): Promise<LLMResponse> => {
      calls += 1;
      if (calls === 1) {
        return {
          content: '',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: toolName, arguments: '{}' },
            },
          ],
        };
      }
      const last = req.messages[req.messages.length - 1];
      expect(last?.role).toBe('tool');
      return { content: 'done', finish_reason: 'stop' };
    },
  };
}

describe('错误 envelope 事件接线', () => {
  it('run.failed 追加 envelope，保留原 error 文本', async () => {
    const events = new MemoryEventStream();
    const runtime = await AgentRuntime.create({
      provider: {
        chat: async () => {
          throw new Error('OpenAI API error: 429 - rate limited');
        },
      },
      model: 'm',
      pluginHost: new MemoryPluginHost(),
      context: new MemoryContextManager(),
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    await expect(runtime.run('hi')).rejects.toThrow('429');
    const failed = events.getHistory().find((event) => event.type === 'run.failed');
    expect(failed?.data).toMatchObject({
      error: 'OpenAI API error: 429 - rate limited',
      error_code: 'provider_rate_limit',
      category: 'provider',
      phase: 'llm',
      retryable: true,
      http_status: 429,
    });
  });

  it('tool.call.failed 追加 tool envelope 与 tool_name details', async () => {
    const events = new MemoryEventStream();
    const pluginHost = new MemoryPluginHost();
    const tool: ToolDefinition = {
      name: 'broken',
      description: 'always fails',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('boom');
      },
    };
    pluginHost.registerTool(tool);

    const runtime = await AgentRuntime.create({
      provider: toolCallThenStopProvider('broken'),
      model: 'm',
      pluginHost,
      context: new MemoryContextManager(),
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    await runtime.run('hi');
    const failed = events.getHistory().find((event) => event.type === 'tool.call.failed');
    expect(failed?.data).toMatchObject({
      tool_name: 'broken',
      error: 'boom',
      error_code: 'tool_error',
      category: 'tool',
      phase: 'tool',
      retryable: false,
      details: { tool_name: 'broken' },
    });
  });
});
