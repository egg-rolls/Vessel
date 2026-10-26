/**
 * 运行期通知总线（CONTRACT-hot-apply §3）。
 *
 * 热应用（config / permission / tools / mcp）的结果要让**人**和**模型**都知道：
 * - 人：`runtime.notice` 事件走现有事件流（Web / TUI 只消费事件，不需要新 RPC）；
 * - 模型：BeforeLlm hook 把最近未消费的通知追加为 `vessel:notice` 上下文消息
 *   （见 `runtime-notice-hook.ts`），**持久化在会话尾部**；不改 system 前缀，
 *   避免每轮让整段提示词缓存失效。
 *
 * 事件名是开放字符串（AGENTS.md），不新增常量表；形状按契约冻结：
 * `{ scope, summary, details?, ok }`。
 *
 * 消费语义按 **session 游标**（不是全局排空）：成员 runtime 与父 runtime 共用同一份
 * hook，若父 turn 排空队列，成员就再也看不到。每个 session 各自记录已读到的通知 id，
 * 因此同一条通知在每个 session 里只注入一次，且不会互相吞掉。
 *
 * @module vessel/runtime-notice
 */

import type { EventStream } from '../packages/core/src/index';

/** 通知作用域：与 `gateway.reload` 的 scope 同名（`update` 留给其它来源）。 */
export type RuntimeNoticeScope = 'config' | 'permission' | 'tools' | 'mcp' | 'update';

/** 契约 §3 的 `runtime.notice` data 形状。 */
export interface RuntimeNotice {
  scope: string;
  /** 一行、人类可读、≤200 字符 */
  summary: string;
  /** 可选，逐条差异，最多 10 行 */
  details?: string[];
  /** false = 未生效（校验失败 / applier 报错） */
  ok: boolean;
}

/** summary 的硬上限（契约 §3）。 */
export const NOTICE_SUMMARY_MAX = 200;
/** details 的硬上限（契约 §3）。 */
export const NOTICE_DETAILS_MAX = 10;
/** 保留的通知条数上限（防止长时间运行的进程无界增长）。 */
const MAX_RETAINED_NOTICES = 50;
/** 记录游标的 session 上限（超出按最旧丢弃）。 */
const MAX_TRACKED_SESSIONS = 200;

/** 一条已入队的通知（id 单调递增，供 session 游标比较）。 */
export interface StoredNotice {
  id: number;
  notice: RuntimeNotice;
  ts: number;
}

export interface RuntimeNoticeBusOptions {
  /** 可选事件出口：同时把 `runtime.notice` 广播给订阅者 */
  events?: EventStream;
  /** 事件里的 run_id；缺省 `runtime`（热应用不属于某次 run） */
  runId?: string;
  tenantId?: string;
  now?: () => number;
}

/** 把任意输入裁剪成契约形状（防御 applier / 调用方传半成品）。 */
export function normalizeNotice(input: RuntimeNotice): RuntimeNotice {
  const summary = trimTo(input.summary, NOTICE_SUMMARY_MAX);
  const details = (input.details ?? [])
    .filter((line): line is string => typeof line === 'string' && line.trim() !== '')
    .slice(0, NOTICE_DETAILS_MAX)
    .map((line) => trimTo(line, NOTICE_SUMMARY_MAX));
  return {
    scope: input.scope,
    summary,
    ...(details.length > 0 ? { details } : {}),
    ok: input.ok,
  };
}

function trimTo(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface RuntimeNoticeBus {
  /** 入队 + 可选广播；返回入队后的通知 id。 */
  publish(notice: RuntimeNotice): number;
  /**
   * 取出该 session 尚未消费的通知（最多 `limit` 条），并推进该 session 的游标。
   * 不传 sessionId 时用 `_` 作为匿名游标。
   */
  take(sessionId: string | undefined, limit?: number): RuntimeNotice[];
  /** 已入队通知的只读快照（诊断 / 测试） */
  recent(): StoredNotice[];
}

export function createRuntimeNoticeBus(options: RuntimeNoticeBusOptions = {}): RuntimeNoticeBus {
  const now = options.now ?? Date.now;
  const retained: StoredNotice[] = [];
  /** sessionId → 已消费到的通知 id */
  const cursors = new Map<string, number>();
  let nextId = 1;

  const broadcast = (notice: RuntimeNotice, ts: number): void => {
    const events = options.events;
    if (events === undefined) return;
    try {
      events.publish({
        type: 'runtime.notice',
        run_id: options.runId ?? 'runtime',
        data: { ...notice },
        ts,
        ...(options.tenantId !== undefined ? { tenant_id: options.tenantId } : {}),
      });
    } catch {
      // 订阅者异常不影响热应用结果
    }
  };

  return {
    publish(input) {
      const notice = normalizeNotice(input);
      const ts = now();
      const id = nextId;
      nextId += 1;
      retained.push({ id, notice, ts });
      // 环形裁剪：只保留最近 N 条；同时把游标推进到裁剪后的最小 id 之前，
      // 避免游标落后于缓冲窗口时把旧通知反复当成「未读」。
      if (retained.length > MAX_RETAINED_NOTICES) {
        retained.splice(0, retained.length - MAX_RETAINED_NOTICES);
      }
      broadcast(notice, ts);
      return id;
    },

    take(sessionId, limit = 5) {
      const key = sessionId !== undefined && sessionId !== '' ? sessionId : '_';
      const cursor = cursors.get(key) ?? 0;
      const pending = retained.filter((entry) => entry.id > cursor);
      if (pending.length === 0) return [];
      const selected = pending.slice(0, Math.max(0, limit));
      // 游标只推进到**已取出**的最后一条：达到 limit 时剩下的留到下一轮。
      const last = selected[selected.length - 1];
      if (last !== undefined) {
        cursors.set(key, last.id);
        trimCursors(cursors);
      }
      return selected.map((entry) => entry.notice);
    },

    recent() {
      return retained.slice();
    },
  };
}

/** session 游标表上界：超出的按插入顺序（最旧）丢弃，最坏只影响一次重复注入。 */
function trimCursors(cursors: Map<string, number>): void {
  while (cursors.size > MAX_TRACKED_SESSIONS) {
    const oldest = cursors.keys().next();
    if (oldest.done === true) return;
    cursors.delete(oldest.value);
  }
}
