/**
 * `runtime.notice` → BeforeLlm 注入（CONTRACT-hot-apply §3）。
 *
 * 热应用结果要进模型上下文：hook 读取 notice 总线里该 session **尚未消费**的通知，
 * 拼成一条 `[runtime] <summary>` 消息追加到上下文尾部并持久化。
 *
 * 每条通知的 `details`（例如 `peer-notices.ts` 的 `名字: kind (error_code)`）**跟着注入**，
 * 一条一行（`  · ` 前缀）：只给 summary 的话，模型看到「1 finished」却不知道是哪个成员。
 * 首行仍是单行摘要（Web 卡头是单行 ellipsis，拼进去只会被截断），细节行数总量受
 * `NOTICE_LINES_MAX` 约束，见该常量的注释。
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

import type { Hook, HookContext, Message, SessionEventLogPort } from '../packages/core/src/index';
import { HookType } from '../packages/core/src/index';
import {
  NOTICE_DETAILS_MAX,
  type RuntimeNotice,
  type RuntimeNoticeBus,
  type StoredNotice,
} from './runtime-notice';

/** 注册名（幂等注册用） */
export const RUNTIME_NOTICE_HOOK = 'runtime-notice';

/** 单轮最多注入几条（避免一次刷屏） */
export const NOTICE_INJECT_LIMIT = 5;

/**
 * details 行的线格式前缀：两个空格 + `·`。
 *
 * 为什么要前缀：Web 的 `env-notice.ts` 按**行首 token** 认 scope（`config:` / `peer:` …），
 * 若 details 行自己不带任何标记，某条 detail 恰好以 scope 词开头就会被误当成另一条通知。
 * 带一个 `·` 之后每条 detail 都落在 `context` 兜底里，卡头仍由首行 summary 决定。
 */
export const NOTICE_DETAIL_MARK = '  · ';

/**
 * 一条注入消息的**总行数**上限（含每条通知的 `[runtime] …` 首行）。
 *
 * 逐条上限（details ≤ `NOTICE_DETAILS_MAX` = 10，每行 ≤ `NOTICE_SUMMARY_MAX` = 200 字符）
 * 乘以单轮条数（`NOTICE_INJECT_LIMIT` = 5）的最坏形状是 55 行 ≈ 1.1 万字符写进上下文
 * 并持久化：这不是「几条提示」，是一整页。24 行 = 两条打满的 peer 通知（2 × 11 行）
 * 加两条只有摘要的通知 —— 覆盖「一轮就能看全」的真实情况，同时把最坏量级压到 ≈ 4800 字符。
 *
 * 首行**永远保留**：丢掉 summary 等于丢掉「发生了什么」；能被省掉的只有 details，
 * 被省掉的行数用末尾一行 `· +N more` 报出来（与 `peer-notices.ts` 的 details 截断同口径，
 * 静默丢行不行）。
 */
export const NOTICE_LINES_MAX = 24;

export interface RuntimeNoticeHookOptions {
  bus: RuntimeNoticeBus;
  /** 单轮注入上限；缺省 `NOTICE_INJECT_LIMIT` */
  limit?: number;
  /**
   * 会话事件日志端口：**注入那一刻**落一条 `runtime.notice.injected`。
   *
   * 为什么必须落：`runtime.notice` 是内存事件流（`MemoryEventStream`）上的广播，
   * `events.ndjson` 只由 `RunJournal`（run 内、带 session_id）写入 —— run 之外的
   * notice 从来不进盘。没有这条锚点，事后完全无法区分「没发」「发了没注入」
   * 「注入了模型没理」，只好去数内存里还剩几条（本项目的实际踩坑）。
   * 端口缺失（CLI 兜底装配 / 测试）时静默跳过，不阻断注入。
   */
  eventLog?: SessionEventLogPort;
}

/** 注入落盘的事件类型（`runtime.*` 命名风格，与 `runtime.notice` 同族）。 */
export const NOTICE_INJECTED_EVENT = 'runtime.notice.injected';

/** `formatNoticeLine` 的入参：总线的 `RuntimeNotice`，但只要求这几个字段。 */
export type FormattableNotice = Pick<RuntimeNotice, 'scope' | 'summary' | 'ok'> & {
  details?: readonly string[];
};

/**
 * 一条通知 → 多行文本：首行 `[runtime] <summary>`，之后每条 detail 各占一行。
 *
 * 首行保持一行摘要：Web 的卡头是单行 ellipsis，把 details 拼进去只会被截断；模型侧
 * 一行一条也更好读。details 不拼进首行是**刻意的**，不是遗漏。
 */
export function formatNoticeLine(notice: FormattableNotice): string {
  // summary / details 已由总线裁剪到 200 字符与 10 条；这里只加作用域与结果标记。
  // peer 通知的 `ok: false` 表示「有成员失败」，不是「热应用没生效」，不加该前缀。
  const applied = notice.ok || notice.scope === 'peer';
  const head = applied
    ? `[runtime] ${notice.summary}`
    : `[runtime] (not applied) ${notice.summary}`;
  const details = (notice.details ?? []).slice(0, NOTICE_DETAILS_MAX);
  if (details.length === 0) return head;
  return [head, ...details.map((line) => `${NOTICE_DETAIL_MARK}${line}`)].join('\n');
}

/**
 * 多条通知 → 一条注入正文（总行数受 `NOTICE_LINES_MAX` 约束）。
 *
 * 只在 hook 里用；导出是为了让「预算怎么花」可被单独读到（纯函数，无状态）。
 */
export function formatNotices(notices: readonly FormattableNotice[]): string {
  const lines: string[] = [];
  let dropped = 0;
  for (const notice of notices) {
    const [head = '', ...details] = formatNoticeLine(notice).split('\n');
    // 首行永远保留（见 NOTICE_LINES_MAX）。
    lines.push(head);
    for (const detail of details) {
      if (lines.length >= NOTICE_LINES_MAX) {
        dropped += 1;
        continue;
      }
      lines.push(detail);
    }
  }
  if (dropped > 0) {
    const last = lines[lines.length - 1];
    // 预算已满且最后一行就是 details：用省略行顶替它（行数不超上限，被顶掉的那一行
    // 也算「没显示出来的明细」，所以计数 +1）；否则（首行把预算吃满的极端场景）直接
    // 追加一行，宁可超一行也不静默丢。
    if (
      lines.length >= NOTICE_LINES_MAX &&
      last !== undefined &&
      last.startsWith(NOTICE_DETAIL_MARK)
    ) {
      lines[lines.length - 1] = `${NOTICE_DETAIL_MARK}+${dropped + 1} more`;
    } else {
      lines.push(`${NOTICE_DETAIL_MARK}+${dropped} more`);
    }
  }
  return lines.join('\n');
}

export function createRuntimeNoticeHook(options: RuntimeNoticeHookOptions): Hook {
  const limit = options.limit ?? NOTICE_INJECT_LIMIT;
  return {
    name: RUNTIME_NOTICE_HOOK,
    type: HookType.BeforeLlm,
    async run(ctx): Promise<void> {
      const stored = options.bus.takeStored(ctx.session_id, limit);
      if (stored.length === 0) return;
      const text = formatNotices(stored.map((entry) => entry.notice));
      if (text === '') return;
      const message: Message = {
        role: 'user',
        name: 'vessel:notice',
        content: text,
        timestamp: Date.now(),
      };
      ctx.messages = [...(ctx.messages ?? []), message];
      // 顺序固定：先挂消息（模型的输入已经在手），再 best-effort 落事件。
      await recordInjection(options.eventLog, ctx, stored);
    },
  };
}

/**
 * 注入事件：`{scope, count, members, notice_ids}` 进 `data`，`session_id` / `run_id`
 * 落在事件信封（`events.ndjson` 的顶层字段，与其它事件同口径）。
 *
 * `scope` 取本次注入涉及的 scope；多条不同就记 `mixed`（注入正文本来就是多条拼一条）。
 * 事件日志任何异常都吞掉：诊断信息不该反过来打断用户这一轮。
 */
async function recordInjection(
  eventLog: SessionEventLogPort | undefined,
  ctx: HookContext,
  stored: readonly StoredNotice[],
): Promise<void> {
  if (eventLog === undefined) return;
  const sessionId = ctx.session_id;
  if (sessionId === undefined || sessionId === '') return;
  const scopes = [...new Set(stored.map((entry) => entry.notice.scope))];
  const members = stored.flatMap((entry) => entry.meta?.members ?? []);
  try {
    await eventLog.append({
      session_id: sessionId,
      run_id: ctx.run_id,
      type: NOTICE_INJECTED_EVENT,
      ts: Date.now(),
      data: {
        scope: scopes.length === 1 ? scopes[0] : 'mixed',
        count: stored.length,
        members,
        notice_ids: stored.map((entry) => entry.id),
      },
    });
  } catch {
    // best-effort：注入已经生效，落事件失败不该冒泡到这一轮。
  }
}
