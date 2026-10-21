/**
 * 0.16 owner inbox → BeforeLlm 注入。
 *
 * 故障形态：同一成员回复在每个 LLM 迭代重复注入（上下文膨胀 / 重复执行），
 * 或读取失败被静默吞掉，父 agent 永远看不到回复也不知道失败。
 */

import { describe, expect, it } from 'bun:test';
import type {
  AgentMessage,
  EventStream,
  HookContext,
  Message,
} from '../../packages/core/src/index';
import {
  createOwnerReplyInjector,
  type ReplyInbox,
  replyToMessage,
} from '../agent-reply-injection';

function message(from: string, content: string, id = from + content): AgentMessage {
  return { id, from, to: 'owner', kind: 'result', content, ts: 1 };
}

function fakeInbox(
  inbox: AgentMessage[],
  options: { fail?: boolean } = {},
): ReplyInbox & { cursor: () => string | undefined } {
  let cursor: string | undefined;
  return {
    async inbox(_id: string, next?: string) {
      if (options.fail) throw new Error('inbox unavailable');
      const start = Number(next ?? 0);
      cursor = String(inbox.length);
      return { messages: inbox.slice(start), cursor };
    },
    cursor: () => cursor,
  } as ReplyInbox & { cursor: () => string | undefined };
}

function capturingEvents(): {
  events: EventStream;
  events_: Array<{ type: string; data: unknown }>;
} {
  const events_: Array<{ type: string; data: unknown }> = [];
  const events = {
    publish(event: { type: string; data: unknown }) {
      events_.push({ type: event.type, data: event.data });
    },
  } as unknown as EventStream;
  return { events, events_ };
}

describe('owner reply injection', () => {
  it('injects a member reply once and advances the cursor', async () => {
    const host = fakeInbox([message('worker', 'done')]);
    const injector = createOwnerReplyInjector({ host, ownerId: 'owner' });
    const ctx: HookContext = { run_id: 'run-1' };

    await injector.hook.run(ctx);
    const first = (ctx as { messages?: Message[] }).messages ?? [];
    expect(first).toEqual([replyToMessage({ from: 'worker', content: 'done' })]);

    await injector.hook.run(ctx);
    const second = (ctx as { messages?: Message[] }).messages ?? [];
    expect(second).toHaveLength(1);
  });

  it('injects only new replies on the next turn', async () => {
    const inbox = [message('a', 'one'), message('b', 'two')];
    const host = fakeInbox(inbox);
    const injector = createOwnerReplyInjector({ host, ownerId: 'owner' });
    const firstCtx: HookContext = { run_id: 'run-1' };
    await injector.hook.run(firstCtx);
    expect(((firstCtx as { messages?: Message[] }).messages ?? []).map((m) => m.content)).toEqual([
      '[agent a] one',
      '[agent b] two',
    ]);

    inbox.push(message('c', 'three'));
    const secondCtx: HookContext = { run_id: 'run-2' };
    await injector.hook.run(secondCtx);
    expect(((secondCtx as { messages?: Message[] }).messages ?? []).map((m) => m.content)).toEqual([
      '[agent c] three',
    ]);
  });

  it('does not echo the owner address back as a reply', async () => {
    const host = fakeInbox([message('owner', 'self')]);
    const injector = createOwnerReplyInjector({ host, ownerId: 'owner' });
    const ctx: HookContext = { run_id: 'run-1' };
    await injector.hook.run(ctx);
    expect((ctx as { messages?: Message[] }).messages).toBeUndefined();
  });

  it('records an event and keeps the turn alive when the inbox read fails', async () => {
    const { events, events_ } = capturingEvents();
    const injector = createOwnerReplyInjector({
      host: fakeInbox([], { fail: true }),
      ownerId: 'owner',
      events,
    });
    const ctx: HookContext = { run_id: 'run-1' };
    await expect(injector.hook.run(ctx)).resolves.toBeUndefined();
    expect(events_).toHaveLength(1);
    expect(events_[0]?.type).toBe('agent.reply.inject_failed');
  });

  it('carries followReplies in the injection event', async () => {
    const { events, events_ } = capturingEvents();
    const injector = createOwnerReplyInjector({
      host: fakeInbox([message('worker', 'done')]),
      ownerId: 'owner',
      events,
      followReplies: true,
    });
    await injector.hook.run({ run_id: 'run-1' });
    const first = events_[0];
    expect(first?.type).toBe('agent.reply.injected');
    const data = first?.data as { follow_replies?: boolean } | undefined;
    expect(data?.follow_replies).toBe(true);
  });
});
