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

/**
 * 通知作用域：与 `gateway.reload` 的 scope 同名（`update` / `peer` 留给其它来源）。
 *
 * - 热应用：`config` / `permission` / `tools` / `mcp`；
 * - 版本检查：`update`；
 * - 成员停下（`peer-notices.ts`）：`peer`，定向到父 session。
 */
export type RuntimeNoticeScope = 'config' | 'permission' | 'tools' | 'mcp' | 'update' | 'peer';

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
  /**
   * 定向：只注入该 session（缺省 = 所有 session 的下一轮都能看到）。
   *
   * 成员停下这种「只对某一个父级有意义」的通知必须定向，否则先跑起来的别的
   * session 会把它消费掉（游标按 session 各自推进）。
   */
  to?: string;
  /**
   * 结构化的补充信息，**不进契约 payload**（`broadcast` 只发 `{...notice}`），
   * 只供注入时落一条 `runtime.notice.injected` 事件用（事后诊断「谁停了」）。
   */
  meta?: RuntimeNoticeMeta;
}

/** 通知涉及的结构化信息（不进契约 §3 的 payload，只进注入事件）。 */
export interface RuntimeNoticeMeta {
  /** 成员停下：本次合并涉及的成员与结局（`name` + `kind`）。 */
  members?: { name: string; kind: string }[];
}

/** `publish` 的可选投递范围（总线内部语义，不进事件 payload）。 */
export interface RuntimeNoticeTarget {
  /** session id；只注入该 session。缺省 = 广播给所有 session 的下一轮。 */
  to?: string;
  /** 见 `StoredNotice.meta`。 */
  meta?: RuntimeNoticeMeta;
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

/** 裁剪 `meta`（防御调用方传半成品）：没有成员信息就整条丢掉，绝不落空对象。 */
function normalizeMeta(meta: RuntimeNoticeMeta | undefined): RuntimeNoticeMeta | undefined {
  const members = (meta?.members ?? []).filter(
    (member) => typeof member.name === 'string' && member.name !== '',
  );
  if (members.length === 0) return undefined;
  return {
    members: members.slice(0, NOTICE_DETAILS_MAX).map((member) => ({
      name: trimTo(member.name, NOTICE_SUMMARY_MAX),
      kind: trimTo(typeof member.kind === 'string' ? member.kind : '', NOTICE_SUMMARY_MAX),
    })),
  };
}

export interface RuntimeNoticeBus {
  /**
   * 入队 + 可选广播；返回入队后的通知 id。
   *
   * `target.to` 指定只注入该 session（成员停下这类定向通知）；不传 = 广播给所有
   * session 的下一轮（热应用 / 版本通知）。
   */
  publish(notice: RuntimeNotice, target?: RuntimeNoticeTarget): number;
  /**
   * 取出该 session 尚未消费的通知（最多 `limit` 条），并推进该 session 的游标。
   * 不传 sessionId 时用 `_` 作为匿名游标。定向给别的 session 的通知不取。
   */
  take(sessionId: string | undefined, limit?: number): RuntimeNotice[];
  /**
   * `take` 的完整版：同时返回 id / `meta`（定向注入那一刻要落事件，需要这两个）。
   *
   * 游标语义与 `take` 完全一致（两者共用同一实现），只是返回粒度更细。
   */
  takeStored(sessionId: string | undefined, limit?: number): StoredNotice[];
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
      });
    } catch {
      // 订阅者异常不影响热应用结果
    }
  };

  /**
   * 取该 session 未消费的通知（`take` / `takeStored` 的唯一实现，保证两者游标语义一致）。
   */
  const takeEntries = (sessionId: string | undefined, limit: number): StoredNotice[] => {
    const key = sessionId !== undefined && sessionId !== '' ? sessionId : '_';
    const cursor = cursors.get(key) ?? 0;
    // 定向给别的 session 的通知对本 session 不可见（它们各自的游标仍小于该 id，
    // 仍会在目标 session 的下一轮命中）。
    const pending = retained.filter(
      (entry) => entry.id > cursor && (entry.to === undefined || entry.to === key),
    );
    if (pending.length === 0) return [];
    const selected = pending.slice(0, Math.max(0, limit));
    // 游标只推进到**已取出**的最后一条：达到 limit 时剩下的留到下一轮。
    const last = selected[selected.length - 1];
    if (last !== undefined) {
      cursors.set(key, last.id);
      trimCursors(cursors);
    }
    return selected;
  };

  return {
    publish(input, target) {
      const notice = normalizeNotice(input);
      const ts = now();
      const id = nextId;
      nextId += 1;
      const to = target?.to;
      const meta = normalizeMeta(target?.meta);
      retained.push({
        id,
        notice,
        ts,
        ...(to !== undefined ? { to } : {}),
        ...(meta !== undefined ? { meta } : {}),
      });
      // 环形裁剪：只保留最近 N 条；同时把游标推进到裁剪后的最小 id 之前，
      // 避免游标落后于缓冲窗口时把旧通知反复当成「未读」。
      if (retained.length > MAX_RETAINED_NOTICES) {
        retained.splice(0, retained.length - MAX_RETAINED_NOTICES);
      }
      broadcast(notice, ts);
      return id;
    },

    take(sessionId, limit = 5) {
      return takeEntries(sessionId, limit).map((entry) => entry.notice);
    },

    takeStored(sessionId, limit = 5) {
      return takeEntries(sessionId, limit);
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
