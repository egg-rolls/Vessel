import { describe, expect, it } from 'bun:test';
import { type HookContext, MemoryEventStream } from '../../packages/core/src/index';
import {
  createRuntimeNoticeBus,
  NOTICE_DETAILS_MAX,
  NOTICE_SUMMARY_MAX,
  normalizeNotice,
} from '../runtime-notice';
import {
  createRuntimeNoticeHook,
  formatNoticeLine,
  RUNTIME_NOTICE_HOOK,
} from '../runtime-notice-hook';

describe('createRuntimeNoticeBus', () => {
  it('广播 runtime.notice 事件：形状是契约 §3 的四个字段', () => {
    const events = new MemoryEventStream();
    const published: Array<{ type: string; data: Record<string, unknown> }> = [];
    events.subscribe((event) => {
      published.push({ type: event.type, data: event.data });
    });

    const bus = createRuntimeNoticeBus({ events, tenantId: 'default', now: () => 123 });
    bus.publish({ scope: 'tools', summary: 'tools: +1 -0', ok: true });

    expect(published).toHaveLength(1);
    expect(published[0]?.type).toBe('runtime.notice');
    expect(published[0]?.data).toEqual({ scope: 'tools', summary: 'tools: +1 -0', ok: true });
  });

  it('summary 截到 200 字符、details 最多 10 行', () => {
    const bus = createRuntimeNoticeBus();
    bus.publish({
      scope: 'config',
      summary: 'x'.repeat(500),
      details: Array.from({ length: 20 }, (_, index) => `line ${index}`),
      ok: false,
    });
    const [notice] = bus.take(undefined);
    expect(notice?.summary.length).toBe(NOTICE_SUMMARY_MAX);
    expect(notice?.details).toHaveLength(NOTICE_DETAILS_MAX);
  });

  it('同一 session 只消费一次（游标推进）', () => {
    const bus = createRuntimeNoticeBus();
    bus.publish({ scope: 'config', summary: 'first', ok: true });
    bus.publish({ scope: 'tools', summary: 'second', ok: true });

    expect(bus.take('s1').map((notice) => notice.summary)).toEqual(['first', 'second']);
    expect(bus.take('s1')).toEqual([]);

    bus.publish({ scope: 'mcp', summary: 'third', ok: true });
    expect(bus.take('s1').map((notice) => notice.summary)).toEqual(['third']);
  });

  it('不同 session 各自消费，互不吞掉（成员 + 父 runtime 共用 hook）', () => {
    const bus = createRuntimeNoticeBus();
    bus.publish({ scope: 'permission', summary: 'bash always ask', ok: true });

    expect(bus.take('owner-session').map((notice) => notice.summary)).toEqual(['bash always ask']);
    // 成员 session 仍能看到同一条（但各自只注入一次）。
    expect(bus.take('member-session').map((notice) => notice.summary)).toEqual(['bash always ask']);
    expect(bus.take('member-session')).toEqual([]);
  });

  it('take 支持 limit', () => {
    const bus = createRuntimeNoticeBus();
    for (let index = 0; index < 5; index += 1) {
      bus.publish({ scope: 'config', summary: `n${index}`, ok: true });
    }
    expect(bus.take('s', 2).map((notice) => notice.summary)).toEqual(['n0', 'n1']);
    // 游标推进到已取出的最后一条之后
    expect(bus.take('s', 10).map((notice) => notice.summary)).toEqual(['n2', 'n3', 'n4']);
  });

  it('无 events 时不广播也不报错', () => {
    const bus = createRuntimeNoticeBus();
    expect(() => bus.publish({ scope: 'config', summary: 'x', ok: true })).not.toThrow();
  });
});

describe('normalizeNotice', () => {
  it('折叠空白、去空 detail、保留 ok', () => {
    expect(
      normalizeNotice({
        scope: 'config',
        summary: '  a \n b  ',
        details: ['ok', '   ', 'fine'],
        ok: false,
      }),
    ).toEqual({ scope: 'config', summary: 'a b', details: ['ok', 'fine'], ok: false });
  });
});

describe('runtime notice hook', () => {
  it('把未消费的通知追加为 vessel:notice 上下文消息，一行一条', async () => {
    const bus = createRuntimeNoticeBus();
    bus.publish({ scope: 'permission', summary: 'permission: bash always ask', ok: true });
    bus.publish({ scope: 'tools', summary: 'tools: +2 -1', ok: true });

    const hook = createRuntimeNoticeHook({ bus });
    expect(hook.name).toBe(RUNTIME_NOTICE_HOOK);
    const ctx: HookContext = { run_id: 'r1', session_id: 's1' };
    expect(await hook.run(ctx)).toBeUndefined();
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages?.[0]).toMatchObject({
      role: 'user',
      name: 'vessel:notice',
      content: '[runtime] permission: bash always ask\n[runtime] tools: +2 -1',
    });
    expect(typeof ctx.messages?.[0]?.timestamp).toBe('number');
  });

  it('同一条通知不会重复注入（只注入一次）', async () => {
    const bus = createRuntimeNoticeBus();
    bus.publish({ scope: 'config', summary: 'config applied', ok: true });
    const hook = createRuntimeNoticeHook({ bus });

    const first: HookContext = { run_id: 'r1', session_id: 's1' };
    const second: HookContext = { run_id: 'r2', session_id: 's1' };
    await hook.run(first);
    await hook.run(second);
    expect(first.messages).toHaveLength(1);
    expect(second.messages).toBeUndefined();
  });

  it('写成可持久化的上下文消息，而不是 additionalContext', async () => {
    const bus = createRuntimeNoticeBus();
    bus.publish({ scope: 'config', summary: 'config applied', ok: true });
    const hook = createRuntimeNoticeHook({ bus });
    const ctx: HookContext = { run_id: 'r1', session_id: 's1' };
    expect(await hook.run(ctx)).toBeUndefined();
    expect(ctx.messages?.[0]?.name).toBe('vessel:notice');
    expect(ctx.systemPrompt).toBeUndefined();
  });

  it('失败的通知带明确前缀', async () => {
    const bus = createRuntimeNoticeBus();
    bus.publish({ scope: 'config', summary: 'config not applied: bad yaml', ok: false });
    const hook = createRuntimeNoticeHook({ bus });
    const ctx: HookContext = { run_id: 'r1', session_id: 's1' };
    await hook.run(ctx);
    expect(ctx.messages?.[0]?.content).toBe('[runtime] (not applied) config not applied: bad yaml');
  });

  it('没有通知时不干预', async () => {
    const bus = createRuntimeNoticeBus();
    const ctx: HookContext = { run_id: 'r1', session_id: 's' };
    await createRuntimeNoticeHook({ bus }).run(ctx);
    expect(ctx.messages).toBeUndefined();
  });
});

describe('formatNoticeLine', () => {
  it('ok / not ok 两态', () => {
    expect(formatNoticeLine({ scope: 'tools', summary: 'tools: +1 -0', ok: true })).toBe(
      '[runtime] tools: +1 -0',
    );
    expect(formatNoticeLine({ scope: 'tools', summary: 'boom', ok: false })).toBe(
      '[runtime] (not applied) boom',
    );
  });
});
