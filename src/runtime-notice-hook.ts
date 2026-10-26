/**
 * `runtime.notice` → BeforeLlm 注入（CONTRACT-hot-apply §3）。
 *
 * 热应用结果要进模型上下文：hook 读取 notice 总线里该 session **尚未消费**的通知，
 * 拼成一条 `[runtime] <summary>` 消息追加到上下文尾部并持久化。
 *
 * 为什么不写 system：
 * - system 是提示词前缀，只要它变，整段历史缓存全部失效；每轮重新计费远贵于多留
 *   几十个 token；
 * - 写成 `role=user` + `name='vessel:source'/'vessel:notice'` 的尾部消息后，前缀稳定，
 *   后续轮次按缓存读价计费；UI 侧按 name 前缀过滤，不污染人类可读的聊天记录。
 *
 * 同一条通知在一个 session 里只注入一次（总线按 session 游标推进，见 `runtime-notice.ts`）。
 * 只在 asm 装配层注册一次：成员 runtime 复制父 `PluginHost.getHooks()`，因此成员 turn
 * 天然共用这个 hook；成员各自用自己的 `ctx.session_id` 取游标，不会互吞。
 *
 * @module vessel/runtime-notice-hook
 */

import type { Hook, Message } from '../packages/core/src/index';
import { HookType } from '../packages/core/src/index';
import type { RuntimeNoticeBus } from './runtime-notice';

/** 注册名（幂等注册用） */
export const RUNTIME_NOTICE_HOOK = 'runtime-notice';

/** 单轮最多注入几条（避免一次刷屏） */
export const NOTICE_INJECT_LIMIT = 5;

export interface RuntimeNoticeHookOptions {
  bus: RuntimeNoticeBus;
  /** 单轮注入上限；缺省 `NOTICE_INJECT_LIMIT` */
  limit?: number;
}

/** 一条通知 → 一行文本：成功/失败都给明确前缀，模型才知道到底生没生效。 */
export function formatNoticeLine(notice: { scope: string; summary: string; ok: boolean }): string {
  // summary 已由总线裁剪到 200 字符；这里只加作用域与结果标记。
  return notice.ok ? `[runtime] ${notice.summary}` : `[runtime] (not applied) ${notice.summary}`;
}

export function createRuntimeNoticeHook(options: RuntimeNoticeHookOptions): Hook {
  const limit = options.limit ?? NOTICE_INJECT_LIMIT;
  return {
    name: RUNTIME_NOTICE_HOOK,
    type: HookType.BeforeLlm,
    async run(ctx): Promise<void> {
      const notices = options.bus.take(ctx.session_id, limit);
      if (notices.length === 0) return;
      const text = notices.map(formatNoticeLine).join('\n');
      if (text === '') return;
      const message: Message = {
        role: 'user',
        name: 'vessel:notice',
        content: text,
        timestamp: Date.now(),
      };
      ctx.messages = [...(ctx.messages ?? []), message];
    },
  };
}
