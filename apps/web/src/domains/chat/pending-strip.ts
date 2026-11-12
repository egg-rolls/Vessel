/**
 * 待处理条带的排序与折叠（纯函数，无 React / DOM）。
 *
 * **数据来源是「本会话自己的排队提交」**（`useChatTranscript.visibleQueued`，已按
 * `item.sessionId === selectedId` 过滤），不再是 `agents.inbox`：inbox 是 agent 维度、
 * 条目里没有 session_id —— 既会把「父 agent 发给子成员的消息」串进这条带子，也没法在
 * 切会话时按会话过滤（详见 PendingStrip.tsx 头注释）。
 *
 * 口径（与 main 的裁决一致）：
 * - `held` 在前、按 ts 升序；其余（unread）按 ts 升序 —— 只做「谁在等」的稳定排序，
 *   不假装能拖拽换序（队列是内存态，拖了刷新就还原）。
 * - 条带只展示前 `PREVIEW_COUNT` 组，其余折叠成「还有 N 条」。
 * - **同源重复折叠**：相邻两条 `from` 相同、状态相同、且正文互为前缀或一条包含另一条
 *   时并成一组（组头显示一条摘要 + 「N 条」，可展开看全部）。这是**纯展示**折叠：
 *   `ordered` 仍是逐条的真实条目，数据不删。
 *
 * `status` 仍按 `held | unread` 两档描述「已排进队列 / 未读」：条带只做排序与折叠，
 * 不关心条目来自哪里；这套排序口径同时被 `scripts/check-transcript-items.ts`（F15）钉着。
 */

/**
 * 条带的一项：只带排序 / 折叠需要的字段（排队提交的 `run_id` 就是 `message_id`）。
 *
 * 结构上与 `AgentInboxEntry` 同形，所以同一套纯函数既能吃 inbox 条目（F15 门禁用例），
 * 也能吃排队提交映射出来的项。
 */
export interface PendingStripEntry {
  message_id: string;
  from: string;
  summary: string;
  status: 'unread' | 'held';
  ts: number;
}

/** 条带里默认展示的摘要条数（其余折叠）。 */
export const PREVIEW_COUNT = 3;

/** held 在前（ts 升序），其余按 ts 升序；同 ts 用 message_id 兜底保证稳定。 */
export function orderPendingEntries(entries: readonly PendingStripEntry[]): PendingStripEntry[] {
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
  ordered: PendingStripEntry[];
  /** 前 `PREVIEW_COUNT` 组（同源重复并成一组；组内 >= 2 时前端显示「N 条」）。 */
  preview: PendingStripGroup[];
  /** 折叠掉的条数（按**条目**计，不含预览里的那些）。 */
  hidden: number;
  /** 总条数（= ordered.length，供「待处理 · N」）。 */
  total: number;
}

/** 一组同源待处理项（只影响展示；组内条目仍是真实的逐条项）。 */
export interface PendingStripGroup {
  /** 组稳定 key：首条 message_id（=`ordered` 里同一位置）。 */
  key: string;
  /** 组头（摘要 / from / status 都从它取）。 */
  head: PendingStripEntry;
  /** 组内条目，顺序与 `ordered` 一致；长度 >= 1。 */
  entries: PendingStripEntry[];
}

/**
 * 相邻两条是否「同源重复」：`from` 与状态都相同，且正文互为前缀或一条包含另一条。
 *
 * 状态也要求相同：同源折叠的语义是「同一个人、同一种等待状态下的同一段话」，
 * 把 held 与 unread 折进同一组会让组头那些字段变成假信息。
 */
export function sameSourcePrefix(a: PendingStripEntry, b: PendingStripEntry): boolean {
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
export function groupPendingEntries(ordered: readonly PendingStripEntry[]): PendingStripGroup[] {
  const groups: PendingStripGroup[] = [];
  let current: PendingStripGroup | undefined;
  let last: PendingStripEntry | undefined;
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
  entries: readonly PendingStripEntry[],
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
