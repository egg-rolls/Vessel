/**
 * 待处理条带的排序与折叠（纯函数，无 React / DOM）。
 *
 * 口径（与 main 的裁决一致）：
 * - `held` 在前、按 ts 升序；其余（unread）按 ts 升序 —— 只做「谁在等」的稳定排序，
 *   不假装能拖拽换序（队列是内存态，拖了刷新就还原）。
 * - 条带只展示前 `PREVIEW_COUNT` 条摘要，其余折叠成「还有 N 条」。
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
  /** 前 `PREVIEW_COUNT` 条。 */
  preview: AgentInboxEntry[];
  /** 折叠掉的条数。 */
  hidden: number;
  /** 总条数（= ordered.length，供「待处理 · N」）。 */
  total: number;
}

/** 排序 + 折叠视图；空列表时 total = 0（调用方据此不渲染条带）。 */
export function pendingStripView(
  entries: readonly AgentInboxEntry[],
  previewCount = PREVIEW_COUNT,
): PendingStripView {
  const ordered = orderPendingEntries(entries);
  return {
    ordered,
    preview: ordered.slice(0, previewCount),
    hidden: Math.max(0, ordered.length - previewCount),
    total: ordered.length,
  };
}
