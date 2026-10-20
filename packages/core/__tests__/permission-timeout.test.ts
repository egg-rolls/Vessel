/**
 * 0.11.1 权限超时致命化（DECISION-022 §2.2）。
 *
 * `waitFor('tool.permission.response')` 超时抛 `PermissionTimeoutError`，
 * run 以 `run.failed`（reason `permission_timeout`）结束；
 * 不得把超时当作普通工具错误回给模型（否则模型会重试同一工具）。
 */
import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { PermissionTimeoutError } from '../src/runtime/permission-policy';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import type { LLMResponse, Message } from '../src/types/provider';
import type { ToolDefinition } from '../src/types/tool';

/** 立即以超时拒绝的 EventStream：避免测试真的等 120s（waitFor 唯一拒绝原因即超时） */
class ImmediateTimeoutEventStream extends MemoryEventStream {
  override waitFor(name: string): Promise<unknown> {
    return Promise.reject(new Error(`Timed out after 1ms waiting for event "${name}"`));
  }
}

/** 第一次返回 tool_calls，之后返回 stop（若真的发生第二次调用即可观测） */
function toolCallProvider(toolName: string, calls: { count: number; requests: Message[][] }) {
  return {
    chat: async (req: { messages: Message[] }): Promise<LLMResponse> => {
      calls.count++;
      calls.requests.push(req.messages);
      if (calls.count === 1) {
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
      return { content: 'done', finish_reason: 'stop' };
    },
  };
}

describe('权限超时致命化', () => {
  it('超时 → run.failed(permission_timeout)，模型不收到工具错误、工具不执行', async () => {
    const calls = { count: 0, requests: [] as Message[][] };
    const handlerCalls = { count: 0 };
    const tool: ToolDefinition = {
      name: 'dangerous',
      description: 'requires permission',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        handlerCalls.count++;
        return 'should not run';
      },
    };

    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool(tool);
    const events = new ImmediateTimeoutEventStream();
    const context = new MemoryContextManager();

    const runtime = await AgentRuntime.create({
      provider: toolCallProvider('dangerous', calls),
      model: 'm',
      pluginHost,
      context,
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      permission: { default: 'ask' },
    });

    let caught: unknown;
    try {
      await runtime.run('hi');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PermissionTimeoutError);
    expect((caught as PermissionTimeoutError).code).toBe('permission_timeout');

    // 致命：provider 只被调用一次，模型没有拿到工具错误，也没有机会重试
    expect(calls.count).toBe(1);
    expect(context.messages.some((m) => m.role === 'tool')).toBe(false);
    expect(handlerCalls.count).toBe(0);

    const failed = events.getHistory().find((event) => event.type === 'run.failed');
    expect(failed).toBeDefined();
    expect(failed?.data).toMatchObject({
      reason: 'permission_timeout',
      error: expect.stringContaining('timed out'),
    });
  });

  it('用户 allow 后工具正常执行（超时改造不影响既有允许路径）', async () => {
    const calls = { count: 0, requests: [] as Message[][] };
    const handlerCalls = { count: 0 };
    const tool: ToolDefinition = {
      name: 'dangerous',
      description: 'requires permission',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        handlerCalls.count++;
        return 'ok';
      },
    };

    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool(tool);
    const events = new MemoryEventStream();
    events.subscribe((event) => {
      if (event.type === 'tool.permission.request') {
        events.publish({
          type: 'tool.permission.response',
          run_id: event.run_id,
          data: {
            requestId: (event.data as { requestId: string }).requestId,
            decision: 'allow',
          },
          ts: Date.now(),
        });
      }
    });
    const context = new MemoryContextManager();

    const runtime = await AgentRuntime.create({
      provider: toolCallProvider('dangerous', calls),
      model: 'm',
      pluginHost,
      context,
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      permission: { default: 'ask' },
    });

    expect(await runtime.run('hi')).toBe('done');
    expect(handlerCalls.count).toBe(1);
    expect(calls.count).toBe(2);
    expect(events.getHistory().some((event) => event.type === 'run.failed')).toBe(false);
  });
});
