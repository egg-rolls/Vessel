/**
 * 待处理条带的排序与折叠（纯函数，无 React / DOM）。
 *
 * **数据来源是服务端持久真相**：`agents.inbox{ session_id }` 的条目（服务端已按会话归属
 * 等值过滤，客户端再用 {@link ownedBySession} 断一次归属）。不再来自
 * `useChatTranscript.visibleQueued` 那份客户端内存 —— 那是「一份内存、两处渲染」，
 * 刷新 / 切会话就消失；而 agent 维度的全量 inbox 会把「父 agent 发给子成员的消息」串进
 * 这条带子。换了数据源之后，「串进子成员收件箱」和「切会话残留」两个问题一起消失。
 *
 * 来源**不过滤**（agent 源的条目也上条带）：能不能写（取消 / 收回编辑）由 UI 层按 `from`
 * 判，排序与折叠不关心是谁发的。
 *
 * 口径（与 main 的裁决一致）：
 * - `held` 在前、按 ts 升序；其余（unread）按 ts 升序 —— 只做「谁在等」的稳定排序，
 *   不假装能拖拽换序（条目的先后只有 `ts` 是权威的，落盘后没有队列序号）。
 * - 条带只展示前 `PREVIEW_COUNT` 组，其余折叠成「还有 N 条」。
 * - **同源重复折叠**：相邻两条 `from` 相同、状态相同、且正文互为前缀或一条包含另一条
 *   时并成一组（组头显示一条摘要 + 「N 条」，可展开看全部）。这是**纯展示**折叠：
 *   `ordered` 仍是逐条的真实条目，数据不删。
 *
 * `status` 仍按 `held | unread` 两档描述「已排进队列 / 未读」：条带只做排序与折叠，
 * 不关心条目来自哪里；这套排序口径同时被 `scripts/check-transcript-items.ts`（F15）钉着。
 */

/**
 * 归属过滤：只留 `session_id` **等值命中**的条目。
 *
 * 这是 0.53 换数据源时那条 `from === 'human'` 对策真正要保的东西：agent 维度的 inbox 是
 * 全量的，`from` 只说明「谁发的」，不说明「发到哪个会话」；父 agent 发给子成员的消息与
 * 这条会话的下一条输入在结构上一模一样，**只有 `session_id` 能区分归属**。所以缺
 * `session_id` 的老条目（`wake` / `quiet` 投递）一律不显示 —— 宁可隐藏，也不把别人的消息
 * 串到这条会话上。
 *
 * 按来源过滤的时代结束了（agent 源也要上条带），但归属这道防线不动：它原本就是真正的判据。
 */
export function ownedBySession<T extends { session_id?: string }>(
  entries: readonly T[],
  sessionId: string,
): T[] {
  return entries.filter((entry) => entry.session_id === sessionId);
}

/**
 * 条带的一项：只带排序 / 折叠需要的字段（结构上是 inbox 条目的子集）。
 *
 * 与 `AgentInboxEntry` 同形，所以同一套纯函数直接吃 RPC 读回来的条目（F15 门禁用例）。
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
 *
 * `from` 不同一律不并组：human 源与 agent 源的两段文字哪怕正文互为前缀，也不是
 * 「同一个人说了同一件事」，折成一组会把身份那格弄成假信息（由 F29 钉住）。
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
