/**
 * 父 turn 的成员回复注入（0.16 Phase A）。
 *
 * owner inbox 里的成员回复在 BeforeLlm 排空，映射为 `role:'user'` 消息后写入
 * `ctx.messages`（core E5）。游标由本模块持有，避免同一回复跨轮重复注入。
 * core 尚未合并 E5 时写入的 `ctx.messages` 不会被请求组装消费——注入逻辑保持幂等。
 *
 * @module vessel/agent-reply-injection
 */

import type { EventStream, Hook, Message, RuntimeHost } from '../packages/core/src/index';
import { HookType } from '../packages/core/src/index';

/** 只需要宿主收件箱读能力，便于测试注入 fake。 */
export type ReplyInbox = Pick<RuntimeHost, 'inbox'>;

export interface OwnerReplyInjectionOptions {
  host: ReplyInbox;
  ownerId: string;
  events?: EventStream;
  tenantId?: string;
  /** 是否允许成员回复触发父级新一轮（由 core / 外壳消费） */
  followReplies?: boolean;
  now?: () => number;
}

export interface InjectedReply {
  id: string;
  from: string;
  kind: string;
  message: Message;
}

/** 成员回复 → 模型消息：角色固定 user，名称标注来源成员。 */
export function replyToMessage(reply: { from: string; content: string }): Message {
  return {
    role: 'user',
    name: `agent:${reply.from}`,
    content: `[agent ${reply.from}] ${reply.content}`,
  };
}

export interface OwnerReplyInjector {
  /** 注册到 PluginHost 的 BeforeLlm hook */
  hook: Hook;
  /** 排空未消费回复（推进游标）；失败返回空数组并发布事件 */
  drain(): Promise<InjectedReply[]>;
  /** 当前游标（诊断 / 测试） */
  cursor(): string | undefined;
}

export function createOwnerReplyInjector(options: OwnerReplyInjectionOptions): OwnerReplyInjector {
  let cursor: string | undefined;
  const now = options.now ?? Date.now;

  const publish = (type: string, runId: string, data: Record<string, unknown>): void => {
    if (!options.events) return;
    try {
      options.events.publish({
        type,
        run_id: runId,
        data,
        ts: now(),
        ...(options.tenantId !== undefined ? { tenant_id: options.tenantId } : {}),
      });
    } catch {
      // 事件订阅者异常不影响父 turn
    }
  };

  const drain = async (): Promise<InjectedReply[]> => {
    let page: Awaited<ReturnType<ReplyInbox['inbox']>>;
    try {
      page = await options.host.inbox(options.ownerId, cursor);
    } catch (error) {
      publish('agent.reply.inject_failed', options.ownerId, {
        owner_id: options.ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    cursor = page.cursor;
    return page.messages
      .filter((reply) => reply.from !== options.ownerId)
      .map((reply) => ({
        id: reply.id,
        from: reply.from,
        kind: reply.kind,
        message: replyToMessage(reply),
      }));
  };

  const hook: Hook = {
    name: 'agent-reply-injection',
    type: HookType.BeforeLlm,
    async run(ctx) {
      const replies = await drain();
      if (replies.length === 0) return;
      const existing = Array.isArray(ctx.messages) ? (ctx.messages as Message[]) : [];
      ctx.messages = [...existing, ...replies.map((reply) => reply.message)];
      publish('agent.reply.injected', ctx.run_id, {
        owner_id: options.ownerId,
        count: replies.length,
        message_ids: replies.map((reply) => reply.id),
        follow_replies: options.followReplies === true,
      });
    },
  };

  return {
    hook,
    drain,
    cursor: () => cursor,
  };
}
