/**
 * 权限等待暂停 max_runtime 计时（ADR-084 Errata）。
 *
 * 人工确认不是机器执行时间：等待 `tool.permission.response` 的时长从 elapsed 中扣除。
 * 守卫：maxRuntimeSeconds=1 的 run 在权限等待 2s 后仍能完成，不触发 limit.blocked。
 */
import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import type { LLMResponse, Message } from '../src/types/provider';
import type { ToolDefinition } from '../src/types/tool';

const PERMISSION_WAIT_MS = 2000;

/** 第一次返回 tool_calls，之后返回 stop。 */
function toolCallProvider(calls: { count: number }) {
  return {
    chat: async (_req: { messages: Message[] }): Promise<LLMResponse> => {
      calls.count++;
      if (calls.count === 1) {
        return {
          content: '',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'slow-approval', arguments: '{}' },
            },
          ],
        };
      }
      return { content: 'done', finish_reason: 'stop' };
    },
  };
}

describe('权限等待不计入 max_runtime', () => {
  it('等待 2s 后不消耗 2s 预算，run 正常完成', async () => {
    const calls = { count: 0 };
    const handlerCalls = { count: 0 };
    const tool: ToolDefinition = {
      name: 'slow-approval',
      description: 'waits for a human before running',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        handlerCalls.count++;
        return 'tool ok';
      },
    };

    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool(tool);

    const events = new MemoryEventStream();
    let requested = false;
    events.subscribe((event) => {
      if (event.type !== 'tool.permission.request') return;
      requested = true;
      const requestId = (event.data as Record<string, unknown>).requestId;
      // 模拟用户 2s 后才确认；maxRuntimeSeconds=1 时旧实现会在下一轮误判超时。
      setTimeout(() => {
        events.publish({
          type: 'tool.permission.response',
          run_id: event.run_id,
          data: { requestId, decision: 'allow' },
          ts: Date.now(),
        });
      }, PERMISSION_WAIT_MS);
    });

    const runtime = await AgentRuntime.create({
      provider: toolCallProvider(calls),
      model: 'm',
      pluginHost,
      context: new MemoryContextManager(),
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10, maxRuntimeSeconds: 1 },
      permission: { default: 'ask' },
    });

    const started = Date.now();
    expect(await runtime.run('hi')).toBe('done');
    expect(Date.now() - started).toBeGreaterThanOrEqual(PERMISSION_WAIT_MS);

    expect(requested).toBe(true);
    expect(handlerCalls.count).toBe(1);
    expect(calls.count).toBe(2);
    const history = events.getHistory();
    expect(history.some((event) => event.type === 'limit.blocked')).toBe(false);
    expect(history.some((event) => event.type === 'run.failed')).toBe(false);
  }, 10_000);
});
