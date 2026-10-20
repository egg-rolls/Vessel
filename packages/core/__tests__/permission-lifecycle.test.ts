/**
 * 0.13 权限生命周期（DECISION-024 §2.1 / §2.3）。
 *
 * 守卫：
 * - `waitFor` 绑定 `AbortSignal`：abort 立即结束等待并清理订阅，不等满超时；
 * - 权限等待被取消抛 `PermissionAbortedError`，不得误报 `permission_timeout`；
 * - 请求事件补齐 session_id / tool_call_id / deadline_at / source（additive）；
 * - 正常应答、超时致命行为保持不变。
 */
import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import {
  PermissionAbortedError,
  PermissionPolicy,
  PermissionTimeoutError,
} from '../src/runtime/permission-policy';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import type { LLMResponse, Message } from '../src/types/provider';
import type { ToolContext, ToolDefinition } from '../src/types/tool';

/** 权限判定用工具；handler 被调用即代表放行 */
function guardedTool(handlerCalls: { count: number }): ToolDefinition {
  return {
    name: 'guarded',
    description: 'requires permission',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      handlerCalls.count++;
      return 'guarded result';
    },
  };
}

/** 第一次返回指定 tool call，之后返回 stop（若发生第二次调用即可观测） */
function toolCallProvider(toolName: string, toolCallId: string, calls: { count: number }) {
  return {
    chat: async (_req: { messages: Message[] }): Promise<LLMResponse> => {
      calls.count++;
      if (calls.count === 1) {
        return {
          content: '',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              id: toolCallId,
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

/** 立即以超时拒绝的 EventStream：验证超时分类不受 signal 支持影响 */
class ImmediateTimeoutEventStream extends MemoryEventStream {
  override waitFor(name: string): Promise<unknown> {
    return Promise.reject(new Error(`Timed out after 1ms waiting for event "${name}"`));
  }
}

describe('waitFor 的取消语义', () => {
  it('已中止的 signal 立即拒绝，且不建立订阅', async () => {
    const events = new MemoryEventStream();
    const controller = new AbortController();
    controller.abort('cancelled before wait');

    const started = performance.now();
    let caught: unknown;
    try {
      await events.waitFor('never.event', { timeout: 60_000, signal: controller.signal });
    } catch (error) {
      caught = error;
    }
    const elapsed = performance.now() - started;

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('AbortError');
    expect((caught as Error).message).toBe('cancelled before wait');
    expect(elapsed).toBeLessThan(100);
    expect(events.subscriberCount).toBe(0);
  });

  it('等待中 abort 毫秒级结束，并清理订阅 / timer', async () => {
    const events = new MemoryEventStream();
    const controller = new AbortController();
    const pending = events.waitFor('never.event', {
      timeout: 60_000,
      signal: controller.signal,
    });
    expect(events.subscriberCount).toBe(1);

    const started = performance.now();
    controller.abort('user cancel');
    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    const elapsed = performance.now() - started;

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('AbortError');
    expect(elapsed).toBeLessThan(100);
    expect(events.subscriberCount).toBe(0);
  });

  it('无 signal 时超时错误仍是 Timed out（行为不变）', async () => {
    const events = new MemoryEventStream();
    await expect(events.waitFor('never.event', { timeout: 20 })).rejects.toThrow('Timed out');
    expect(events.subscriberCount).toBe(0);
  });
});

describe('PermissionPolicy 的取消与超时分类', () => {
  function context(events: MemoryEventStream, signal: AbortSignal | undefined): ToolContext {
    return {
      run_id: 'run-1',
      session_id: 'session-1',
      tool_call_id: 'call-1',
      messages: [],
      events,
      ...(signal ? { signal } : {}),
    };
  }

  it('权限等待中 abort → 立即抛 PermissionAbortedError，不是 permission_timeout', async () => {
    const events = new MemoryEventStream();
    const policy = new PermissionPolicy(events, { default: 'ask' });
    const controller = new AbortController();
    const ctx = context(events, controller.signal);

    events.subscribe((event) => {
      if (event.type === 'tool.permission.request') controller.abort('cancel during permission');
    });
    const subscribers = events.subscriberCount;

    const started = performance.now();
    let caught: unknown;
    try {
      await policy.authorize(guardedTool({ count: 0 }), {}, ctx);
    } catch (error) {
      caught = error;
    }
    const elapsed = performance.now() - started;

    expect(caught).toBeInstanceOf(PermissionAbortedError);
    expect(caught).not.toBeInstanceOf(PermissionTimeoutError);
    expect((caught as PermissionAbortedError).code).toBe('permission_cancelled');
    expect((caught as Error).name).toBe('AbortError');
    expect(elapsed).toBeLessThan(500);
    // 测试自身的订阅仍在；waitFor 的临时订阅已清理
    expect(events.subscriberCount).toBe(subscribers);
  });

  it('signal 未 abort 时仍抛 PermissionTimeoutError（0.11.1 行为不变）', async () => {
    const events = new ImmediateTimeoutEventStream();
    const policy = new PermissionPolicy(events, { default: 'ask' });
    const controller = new AbortController();

    let caught: unknown;
    try {
      await policy.authorize(guardedTool({ count: 0 }), {}, context(events, controller.signal));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PermissionTimeoutError);
    expect((caught as PermissionTimeoutError).code).toBe('permission_timeout');
  });
});

describe('tool.permission.request 关联字段', () => {
  it('携带 session_id / tool_call_id / deadline_at / source，且正常应答仍生效', async () => {
    const calls = { count: 0 };
    const handlerCalls = { count: 0 };
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool(guardedTool(handlerCalls));

    const events = new MemoryEventStream();
    let request: { eventTs: number; data: Record<string, unknown> } | undefined;
    events.subscribe((event) => {
      if (event.type !== 'tool.permission.request') return;
      request = { eventTs: event.ts, data: event.data as Record<string, unknown> };
      events.publish({
        type: 'tool.permission.response',
        run_id: event.run_id,
        data: { requestId: request.data.requestId, decision: 'allow' },
        ts: Date.now(),
      });
    });

    const runtime = await AgentRuntime.create({
      provider: toolCallProvider('guarded', 'call-42', calls),
      model: 'm',
      pluginHost,
      context: new MemoryContextManager(),
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      permission: { default: 'ask' },
    });

    expect(await runtime.run('hi', 'session-42')).toBe('done');
    expect(handlerCalls.count).toBe(1);

    const captured = request;
    expect(captured).toBeDefined();
    if (!captured) throw new Error('tool.permission.request was not published');
    expect(captured.data).toMatchObject({
      tool: 'guarded',
      input: {},
      session_id: 'session-42',
      tool_call_id: 'call-42',
      source: 'runtime',
    });
    expect(typeof captured.data.requestId).toBe('string');
    expect(captured.data.deadline_at).toBe(captured.eventTs + 120_000);
  });
});

describe('runtime 级取消', () => {
  it('权限等待中取消 run：快速结束且不误报 permission_timeout', async () => {
    const calls = { count: 0 };
    const handlerCalls = { count: 0 };
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool(guardedTool(handlerCalls));

    const events = new MemoryEventStream();
    const controller = new AbortController();
    events.subscribe((event) => {
      if (event.type === 'tool.permission.request') controller.abort('user cancel');
    });

    const runtime = await AgentRuntime.create({
      provider: toolCallProvider('guarded', 'call-1', calls),
      model: 'm',
      pluginHost,
      context: new MemoryContextManager(),
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      permission: { default: 'ask' },
    });

    const started = performance.now();
    let caught: unknown;
    try {
      await runtime.run('hi', 'session-1', { signal: controller.signal });
    } catch (error) {
      caught = error;
    }
    const elapsed = performance.now() - started;

    expect(caught).toBeInstanceOf(PermissionAbortedError);
    expect(caught).not.toBeInstanceOf(PermissionTimeoutError);
    expect(elapsed).toBeLessThan(1000);

    // 取消不是工具失败，也不是模型可重试的错误
    expect(handlerCalls.count).toBe(0);
    expect(calls.count).toBe(1);

    const history = events.getHistory();
    expect(history.some((event) => event.type === 'run.cancelled')).toBe(true);
    expect(
      history.some(
        (event) =>
          event.type === 'run.failed' &&
          (event.data as Record<string, unknown>).reason === 'permission_timeout',
      ),
    ).toBe(false);
    expect(history.some((event) => event.type === 'tool.call.failed')).toBe(false);
  });
});
