/**
 * 工具自带 `checkPermission` 返回 `ask` 时的统一提问路径。
 *
 * 守卫：
 * - autoApprove / remember-always 命中时直接放行，不发 `tool.permission.request`；
 * - 未命中时只发一次请求；
 * - neverAutoApprove 把 auto 来源的放行降级回 ask；
 * - 工具显式的 allow / deny 不被 auto 策略改写；
 * - 等待时长累计到 `pausedMs`（供 max_runtime 扣除）。
 */
import { describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '../src/events/event-stream';
import { PermissionPolicy } from '../src/runtime/permission-policy';
import type { RuntimePermissionConfig } from '../src/types/plugin';
import type { ToolContext, ToolDefinition } from '../src/types/tool';

function tool(checkPermission: ToolDefinition['checkPermission']): ToolDefinition {
  return {
    name: 'guarded',
    description: 'guarded',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => 'ok',
    ...(checkPermission ? { checkPermission } : {}),
  };
}

interface Trace {
  requests: unknown[];
  error: unknown;
}

/** 用真实策略跑一次 authorize；请求一到就按 allow 应答（可选 remember）。 */
async function authorize(
  target: ToolDefinition,
  config?: RuntimePermissionConfig,
  remember = false,
): Promise<Trace> {
  const events = new MemoryEventStream();
  const requests: unknown[] = [];
  const policy = new PermissionPolicy(events, config);
  events.subscribe((event) => {
    if (event.type !== 'tool.permission.request') return;
    requests.push(event);
    events.publish({
      type: 'tool.permission.response',
      run_id: event.run_id,
      data: {
        requestId: (event.data as Record<string, unknown>).requestId,
        decision: 'allow',
        ...(remember ? { remember: true } : {}),
      },
      ts: Date.now(),
    });
  });
  const ctx: ToolContext = { run_id: 'run-1', messages: [], events };
  let error: unknown;
  try {
    await policy.authorize(target, {}, ctx);
  } catch (caught) {
    error = caught;
  }
  return { requests, error };
}

describe('tool checkPermission ask', () => {
  it('autoApprove 命中时不发请求', async () => {
    const { requests, error } = await authorize(tool(async () => 'ask'), {
      autoApprove: ['guarded'],
    });
    expect(error).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it('未配置 autoApprove 时只发一次请求', async () => {
    const { requests, error } = await authorize(tool(async () => 'ask'));
    expect(error).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it('neverAutoApprove 命中时即使 autoApprove 也 ask', async () => {
    const { requests, error } = await authorize(tool(async () => 'ask'), {
      autoApprove: ['guarded'],
      neverAutoApprove: ['guarded'],
    });
    expect(error).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it('工具显式 allow 不受 neverAutoApprove 影响', async () => {
    const { requests, error } = await authorize(tool(async () => 'allow'), {
      neverAutoApprove: ['guarded'],
    });
    expect(error).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it('工具显式 deny 即使 autoApprove 也拒绝', async () => {
    const { requests, error } = await authorize(tool(async () => 'deny'), {
      autoApprove: ['guarded'],
    });
    expect((error as Error).message).toContain('denied by permission policy');
    expect(requests).toHaveLength(0);
  });

  it('remember（always）后同一工具不再发请求', async () => {
    const events = new MemoryEventStream();
    const requests: unknown[] = [];
    const policy = new PermissionPolicy(events, { autoApprove: [] });
    events.subscribe((event) => {
      if (event.type !== 'tool.permission.request') return;
      requests.push(event);
      events.publish({
        type: 'tool.permission.response',
        run_id: event.run_id,
        data: {
          requestId: (event.data as Record<string, unknown>).requestId,
          decision: 'allow',
          remember: true,
        },
        ts: Date.now(),
      });
    });
    const ctx: ToolContext = { run_id: 'run-1', messages: [], events };
    const target = tool(async () => 'ask');

    await policy.authorize(target, {}, ctx);
    await policy.authorize(target, {}, ctx);
    expect(requests).toHaveLength(1);
  });

  it('等待授权的时间累计到 pausedMs，可由 resetPausedMs 清零', async () => {
    const events = new MemoryEventStream();
    const policy = new PermissionPolicy(events, { default: 'ask' });
    events.subscribe((event) => {
      if (event.type !== 'tool.permission.request') return;
      setTimeout(() => {
        events.publish({
          type: 'tool.permission.response',
          run_id: event.run_id,
          data: {
            requestId: (event.data as Record<string, unknown>).requestId,
            decision: 'allow',
          },
          ts: Date.now(),
        });
      }, 50);
    });

    await policy.authorize(tool(async () => 'ask'), {}, {
      run_id: 'run-1',
      messages: [],
      events,
    });
    expect(policy.pausedMs).toBeGreaterThanOrEqual(40);

    policy.resetPausedMs();
    expect(policy.pausedMs).toBe(0);
  });
});
