/**
 * 0.27 permission.neverAutoApprove（PLAN-0.27-swarm §2.8）。
 *
 * 守卫：
 * - exact 工具名命中（`read` / `agent`）：把任何 allow（含工具 checkPermission
 *   的显式 allow）降级为 ask；
 * - scoped `${tool.name}.${action}` 命中（`agent.close`）：只降级 auto 来源的 allow，
 *   显式工具 allow 保持（关自己的 contractor 不需要批准）；
 * - 显式 deny 保持拒绝；
 * - 无配置或无匹配时行为完全不变。
 */
import { describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '../src/events/event-stream';
import { PermissionPolicy } from '../src/runtime/permission-policy';
import type { RuntimePermissionConfig } from '../src/types/plugin';
import type { ToolContext, ToolDefinition } from '../src/types/tool';

function tool(name: string, checkPermission?: ToolDefinition['checkPermission']): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => 'ok',
    ...(checkPermission ? { checkPermission } : {}),
  };
}

/** 记录 authorize 是否触发确认；ask 时自动应答 allow 以免挂住 */
async function authorizeWithTrace(
  policy: PermissionPolicy,
  events: MemoryEventStream,
  target: ToolDefinition,
  args: unknown,
): Promise<{ requested: boolean }> {
  let requested = false;
  const stop = events.subscribe((event) => {
    if (event.type !== 'tool.permission.request') return;
    requested = true;
    events.publish({
      type: 'tool.permission.response',
      run_id: event.run_id,
      data: {
        requestId: (event.data as Record<string, unknown>).requestId,
        decision: 'allow',
      },
      ts: Date.now(),
    });
  });

  const ctx: ToolContext = { run_id: 'run-1', messages: [], events };
  try {
    await policy.authorize(target, args, ctx);
  } finally {
    stop();
  }
  return { requested };
}

function policyFor(events: MemoryEventStream, config: RuntimePermissionConfig): PermissionPolicy {
  return new PermissionPolicy(events, config);
}

describe('PermissionPolicy neverAutoApprove', () => {
  it('autoApprove 命中工具但 never 命中 tool.action → ask', async () => {
    const events = new MemoryEventStream();
    const policy = policyFor(events, {
      autoApprove: ['agent'],
      neverAutoApprove: ['agent.close'],
    });

    const { requested } = await authorizeWithTrace(policy, events, tool('agent'), {
      action: 'close',
    });
    expect(requested).toBe(true);
  });

  it('同一工具的其他 action 仍 allow', async () => {
    const events = new MemoryEventStream();
    const policy = policyFor(events, {
      autoApprove: ['agent'],
      neverAutoApprove: ['agent.close'],
    });

    const { requested } = await authorizeWithTrace(policy, events, tool('agent'), {
      action: 'status',
    });
    expect(requested).toBe(false);
  });

  it('scoped never + 工具显式 allow（关自己的 contractor）→ allow，不确认', async () => {
    const events = new MemoryEventStream();
    const policy = policyFor(events, {
      autoApprove: ['agent'],
      neverAutoApprove: ['agent.close'],
    });

    const { requested } = await authorizeWithTrace(
      policy,
      events,
      tool('agent', async () => 'allow'),
      { action: 'close' },
    );
    expect(requested).toBe(false);
  });

  it('scoped never + checkPermission ask 经 autoApprove 升级（peer close）→ ask', async () => {
    const events = new MemoryEventStream();
    const policy = policyFor(events, {
      autoApprove: ['agent'],
      neverAutoApprove: ['agent.close'],
    });

    const { requested } = await authorizeWithTrace(
      policy,
      events,
      tool('agent', async () => 'ask'),
      { action: 'close' },
    );
    expect(requested).toBe(true);
  });

  it('exact agent + 工具显式 allow → ask', async () => {
    const events = new MemoryEventStream();
    const policy = policyFor(events, {
      autoApprove: ['agent'],
      neverAutoApprove: ['agent'],
    });

    const { requested } = await authorizeWithTrace(
      policy,
      events,
      tool('agent', async () => 'allow'),
      { action: 'close' },
    );
    expect(requested).toBe(true);
  });

  it('read 类工具显式 allow + exact never → ask', async () => {
    const events = new MemoryEventStream();
    const policy = policyFor(events, {
      autoApprove: ['read'],
      neverAutoApprove: ['read'],
    });

    const { requested } = await authorizeWithTrace(
      policy,
      events,
      tool('read', async () => 'allow'),
      {},
    );
    expect(requested).toBe(true);
  });

  it('工具 checkPermission 显式 deny 仍拒绝', async () => {
    const events = new MemoryEventStream();
    const policy = policyFor(events, {
      autoApprove: ['agent'],
      neverAutoApprove: ['agent.close'],
    });
    const ctx: ToolContext = { run_id: 'run-1', messages: [], events };

    await expect(
      policy.authorize(
        tool('agent', async () => 'deny'),
        { action: 'close' },
        ctx,
      ),
    ).rejects.toThrow('denied by permission policy');
  });

  it('never 含工具名时，即使没有 checkPermission 也 ask', async () => {
    const events = new MemoryEventStream();
    const policy = policyFor(events, {
      autoApprove: ['shell'],
      neverAutoApprove: ['shell'],
    });

    const { requested } = await authorizeWithTrace(policy, events, tool('shell'), {});
    expect(requested).toBe(true);
  });

  it('无 never / 无匹配 → allow（行为不变）', async () => {
    for (const neverAutoApprove of [undefined, ['other.tool']]) {
      const events = new MemoryEventStream();
      const policy = policyFor(events, {
        autoApprove: ['agent'],
        ...(neverAutoApprove !== undefined ? { neverAutoApprove } : {}),
      });

      const { requested } = await authorizeWithTrace(policy, events, tool('agent'), {
        action: 'close',
      });
      expect(requested).toBe(false);
    }
  });
});
