/**
 * 待处理条带的排序与折叠（纯函数，无 React / DOM）。
 *
 * 口径（与 main 的裁决一致）：
 * - `held` 在前、按 ts 升序；其余（unread）按 ts 升序 —— 只做「谁在等」的稳定排序，
 *   不假装能拖拽换序（队列是内存态，拖了刷新就还原）。
 * - 条带只展示前 `PREVIEW_COUNT` 条摘要，其余折叠成「还有 N 条」。
 * - **同源重复折叠**：相邻两条 `from` 相同、状态相同、且正文互为前缀或一条包含另一条
 *   时并成一组（组头显示一条摘要 + 「N 条」，可展开看全部）。这是**纯展示**折叠：
 *   `ordered` 仍是逐条的真实 inbox 条目，数据不删、inbox 语义不变。
 */
import type { AgentInboxEntry } from '../../gateway/types';

/** 条带里默认展示的摘要条数（其余折叠）。 */
export const PREVIEW_COUNT = 3;

/** held 在前（ts 升序），其余按 ts 升序；同 ts 用 message_id 兜底保证稳定。 */
export function orderPendingEntries(entries: readonly AgentInboxEntry[]): AgentInboxEntry[] {
  return [...entries].sort((a, b) => {
    const aHeld = a.status === 'held';
    const bHeld = b.status === 'held';
    if (aHeld !== bHeld) return aHeld ? -1 : 1;
    if (a.ts !== b.ts) return a.ts - b.ts;
    return a.message_id < b.message_id ? -1 : a.message_id > b.message_id ? 1 : 0;
  });
}

export interface PendingStripView {
  /** 排序后的完整列表（点开「全部」时用）。 */
  ordered: AgentInboxEntry[];
  /** 前 `PREVIEW_COUNT` 组（同源重复并成一组；组内 >= 2 时前端显示「N 条」）。 */
  preview: PendingStripGroup[];
  /** 折叠掉的条数（按**条目**计，不含预览里的那些）。 */
  hidden: number;
  /** 总条数（= ordered.length，供「待处理 · N」）。 */
  total: number;
}

/** 一组同源待处理项（只影响展示；组内条目仍是真实 inbox 条目）。 */
export interface PendingStripGroup {
  /** 组稳定 key：首条 message_id（=`ordered` 里同一位置）。 */
  key: string;
  /** 组头（摘要 / from / status 都从它取）。 */
  head: AgentInboxEntry;
  /** 组内条目，顺序与 `ordered` 一致；长度 >= 1。 */
  entries: AgentInboxEntry[];
}

/**
 * 相邻两条是否「同源重复」：`from` 与状态都相同，且正文互为前缀或一条包含另一条。
 *
 * 状态也要求相同：条带按状态各给一个前缀标签（已排队 / 未读），把 held 与 unread
 * 折进同一行会让组头那个标签变成假信息。
 */
export function sameSourcePrefix(a: AgentInboxEntry, b: AgentInboxEntry): boolean {
  if (a.from !== b.from || a.status !== b.status) return false;
  const left = a.summary.trim();
  const right = b.summary.trim();
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  // 前缀是「包含」的特例，一个 includes 就够（互为前缀 ⇔ 短的被长的包含）。
  return longer.includes(shorter);
}

/** 排序后的条目 → 相邻同源重复并组（连续同类会继续并进同一组）。 */
export function groupPendingEntries(ordered: readonly AgentInboxEntry[]): PendingStripGroup[] {
  const groups: PendingStripGroup[] = [];
  let current: PendingStripGroup | undefined;
  let last: AgentInboxEntry | undefined;
  for (const entry of ordered) {
    if (current !== undefined && last !== undefined && sameSourcePrefix(last, entry)) {
      current.entries.push(entry);
      last = entry;
      continue;
    }
    current = {
      key: entry.message_id,
      head: entry,
      entries: [entry],
    };
    groups.push(current);
    last = entry;
  }
  return groups;
}

/** 排序 + 折叠视图；空列表时 total = 0（调用方据此不渲染条带）。 */
export function pendingStripView(
  entries: readonly AgentInboxEntry[],
  previewCount = PREVIEW_COUNT,
): PendingStripView {
  const ordered = orderPendingEntries(entries);
  const preview = groupPendingEntries(ordered).slice(0, previewCount);
  const shownEntries = preview.reduce((sum, group) => sum + group.entries.length, 0);
  return {
    ordered,
    preview,
    hidden: Math.max(0, ordered.length - shownEntries),
    total: ordered.length,
  };
}
