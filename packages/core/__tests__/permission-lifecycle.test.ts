/**
 * 0.13 权限生命周期（DECISION-024 §2.1 / §2.3 + Addendum A）。
 *
 * 守卫：
 * - `waitFor` 绑定 `AbortSignal`：abort 立即结束等待并清理订阅；
 * - 缺省 / `timeout <= 0` 不设 timer：一直等到应答或 abort；
 * - 权限等待被取消抛 `PermissionAbortedError`，不得误报 `permission_timeout`；
 * - 只有显式正数超时才产生 `PermissionTimeoutError` 与 `deadline_at`；
 * - 请求事件补齐 session_id / tool_call_id / source（additive）；
 * - 正常应答行为保持不变。
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 观察 promise 是否已 settle（不改变其结果） */
function observe(promise: Promise<unknown>): { readonly settled: boolean } {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
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

  it('显式正数 timeout 仍以 Timed out 拒绝（行为不变）', async () => {
    const events = new MemoryEventStream();
    await expect(events.waitFor('never.event', { timeout: 20 })).rejects.toThrow('Timed out');
    expect(events.subscriberCount).toBe(0);
  });

  it('timeout 缺省 / <= 0 不设 timer：短窗口内不结束，abort 立即结束', async () => {
    const cases: Array<{ label: string; timeout?: number }> = [
      { label: 'undefined' },
      { label: '0', timeout: 0 },
      { label: 'negative', timeout: -1 },
    ];

    for (const testCase of cases) {
      const events = new MemoryEventStream();
      const controller = new AbortController();
      const pending = events.waitFor('never.event', {
        ...(testCase.timeout !== undefined ? { timeout: testCase.timeout } : {}),
        signal: controller.signal,
      });
      const state = observe(pending);

      await sleep(60);
      expect({ label: testCase.label, settled: state.settled }).toEqual({
        label: testCase.label,
        settled: false,
      });
      expect(events.subscriberCount).toBe(1);

      // abort 仍能立即结束无限等待，并清理订阅
      const started = performance.now();
      controller.abort('stop infinite wait');
      let caught: unknown;
      try {
        await pending;
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe('AbortError');
      expect(performance.now() - started).toBeLessThan(100);
      expect(events.subscriberCount).toBe(0);
    }
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

  it('默认配置不设超时：无应答时保持等待，abort 立即结束', async () => {
    const events = new MemoryEventStream();
    const policy = new PermissionPolicy(events, { default: 'ask' });
    const controller = new AbortController();
    const ctx = context(events, controller.signal);

    const pending = policy.authorize(guardedTool({ count: 0 }), {}, ctx);
    const state = observe(pending);

    await sleep(80);
    expect(state.settled).toBe(false);

    controller.abort('cancel infinite permission wait');
    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PermissionAbortedError);
    expect(caught).not.toBeInstanceOf(PermissionTimeoutError);
  });

  it('显式正数 timeoutMs 超时 → PermissionTimeoutError', async () => {
    const events = new MemoryEventStream();
    const policy = new PermissionPolicy(events, { default: 'ask', timeoutMs: 30 });
    const ctx = context(events, undefined);

    // 有界等待：若实现错误地无限等待，该守卫在 1s 后失败而不是挂住测试
    const outcome = await Promise.race([
      policy.authorize(guardedTool({ count: 0 }), {}, ctx).then(
        () => 'allowed' as const,
        (error: unknown) => error,
      ),
      sleep(1000).then(() => 'still-pending' as const),
    ]);

    expect(outcome).toBeInstanceOf(PermissionTimeoutError);
    expect((outcome as PermissionTimeoutError).code).toBe('permission_timeout');
  });

  it('signal 未 abort 时仍把超时映射为 PermissionTimeoutError（0.11.1 行为不变）', async () => {
    const events = new ImmediateTimeoutEventStream();
    // Addendum A：只有显式正数超时才存在 timeout 语义
    const policy = new PermissionPolicy(events, { default: 'ask', timeoutMs: 1 });
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
  it('携带 session_id / tool_call_id / source，默认无限等待不带 deadline_at，且正常应答仍生效', async () => {
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
    // Addendum A：默认不设超时 → 不承诺 deadline
    expect('deadline_at' in captured.data).toBe(false);
  });

  it('显式正数 timeoutMs 才带 deadline_at = ts + timeoutMs', async () => {
    const events = new MemoryEventStream();
    const policy = new PermissionPolicy(events, { default: 'ask', timeoutMs: 5000 });
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

    await policy.authorize(
      guardedTool({ count: 0 }),
      {},
      {
        run_id: 'run-deadline',
        messages: [],
        events,
      },
    );

    const captured = request;
    expect(captured).toBeDefined();
    if (!captured) throw new Error('tool.permission.request was not published');
    expect(captured.data.deadline_at).toBe(captured.eventTs + 5000);
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

  it('无应答时 run 保持等待（默认不超时），延迟取消仍立即结束', async () => {
    const calls = { count: 0 };
    const handlerCalls = { count: 0 };
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool(guardedTool(handlerCalls));

    const events = new MemoryEventStream();
    const controller = new AbortController();
    let requested = false;
    events.subscribe((event) => {
      if (event.type === 'tool.permission.request') requested = true;
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

    const running = runtime.run('hi', 'session-1', { signal: controller.signal });
    const state = observe(running);
    for (let i = 0; i < 50 && !requested; i += 1) await sleep(10);
    expect(requested).toBe(true);

    // Addendum A：默认无限等待 → 观察窗口内不结束
    await sleep(80);
    expect(state.settled).toBe(false);
    expect(handlerCalls.count).toBe(0);

    const started = performance.now();
    controller.abort('user cancel');
    let caught: unknown;
    try {
      await running;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PermissionAbortedError);
    expect(performance.now() - started).toBeLessThan(500);
    expect(events.getHistory().some((event) => event.type === 'run.cancelled')).toBe(true);
  });
});
