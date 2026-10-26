/**
 * `runtime.notice` → BeforeLlm 注入（CONTRACT-hot-apply §3）。
 *
 * 热应用结果要进模型上下文：hook 读取 notice 总线里该 session **尚未消费**的通知，
 * 拼成一行 `[runtime] <summary>`（多条按行拼接）放进 `additionalContext`。
 *
 * 与 doc-subscription 同一模式：
 * - 只写 `HookResult.additionalContext`，**不写 session 历史**（core 只把它作为本次请求
 *   的 system 上下文）；
 * - 同一条通知在一个 session 里只注入一次（总线按 session 游标推进，见 `runtime-notice.ts`）。
 *
 * 只在 asm 装配层注册一次：成员 runtime 复制父 `PluginHost.getHooks()`，因此成员 turn
 * 天然共用这个 hook；成员各自用自己的 `ctx.session_id` 取游标，不会互吞。
 *
 * @module vessel/runtime-notice-hook
 */

import type { Hook, HookResult } from '../packages/core/src/index';
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
    // biome-ignore lint/suspicious/noConfusingVoidType: Hook 契约保留 Promise<void> 以兼容既有实现
    async run(ctx): Promise<void | HookResult> {
      const notices = options.bus.take(ctx.session_id, limit);
      if (notices.length === 0) return;
      const text = notices.map(formatNoticeLine).join('\n');
      if (text === '') return;
      return { additionalContext: text };
    },
  };
}
