/**
 * Team 群聊的吸附滚动 key 与「无感加载更早」的滚动锚点（纯函数，便于测试）。
 *
 * - resetKey 标识“打开/切换会话 + detail 是否已 hydrate”；加载更早历史不变。
 * - followKey 只看最后一条消息的身份，不用 rows.length：自动加载更早历史在前方
 *   追加旧消息时 key 不变，因此不会触发跟随。
 */
import type { TeamMessageView } from './TeamMessageRow';

export function teamChatResetKey(teamId: string, detailTeamId: string | undefined): string {
  return `${detailTeamId ?? teamId}:${detailTeamId ? 'ready' : 'loading'}`;
}

export function teamFollowKey(
  rows: readonly Pick<TeamMessageView, 'message_id' | 'ts' | 'sendStatus'>[],
): string {
  const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
  if (!last) return 'empty';
  return `${last.message_id}:${last.ts}:${last.sendStatus ?? ''}`;
}

/** 距顶部小于该值时自动加载更早一页（无感加载，不显示按钮 / 截断提示）。 */
export const EARLIER_LOAD_THRESHOLD_PX = 120;

export interface ScrollAnchor {
  readonly scrollTop: number;
  readonly scrollHeight: number;
}

export function isNearTop(scrollTop: number, threshold = EARLIER_LOAD_THRESHOLD_PX): boolean {
  return scrollTop <= threshold;
}

export function captureScrollAnchor(box: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
}): ScrollAnchor {
  return { scrollTop: box.scrollTop, scrollHeight: box.scrollHeight };
}

/**
 * 把新插入到上方的内容高度补回 `scrollTop`：视觉位置原地不动，不跳顶也不跳底。
 *
 * 浏览器原生滚动锚定（`overflow-anchor`）可能已经补偿了一部分，这里只补差额，
 * 避免二次位移。返回 false 表示内容还没长高（异步页未到），锚点留给下一帧。
 */
export function restoreScrollAnchor(
  box: { scrollTop: number; readonly scrollHeight: number },
  anchor: ScrollAnchor,
): boolean {
  const grown = box.scrollHeight - anchor.scrollHeight;
  if (grown <= 0) return false;
  const target = anchor.scrollTop + grown;
  if (Math.abs(target - box.scrollTop) > 1) box.scrollTop = target;
  return true;
}

/**
 * 「还有没有更早内容」的探针状态。
 *
 * `teams.get` 没有 `has_more`，`canLoadEarlier` 只能看窗口是否被填满
 * （`messageCount >= limit`），所以总数正好等于 `limit` 时会误判成还有更早的。
 * 探针用「上一页回来条数有没有变多」来兜底：没变多就记住这个条数，之后在同一个
 * 条数上不再白拉（有新消息把条数推高时自动重新允许探一次）。
 */
export interface EarlierProbeState {
  /** 在途请求发出时的消息条数；null = 没有在途请求。 */
  readonly pendingCount: number | null;
  /** 已确认「下一页一条也没多」的条数；命中同条数时不再请求。 */
  readonly stalledAt: number | null;
}

export const IDLE_EARLIER_PROBE: EarlierProbeState = { pendingCount: null, stalledAt: null };

export type EarlierProbeDecision =
  | { readonly probe: true; readonly next: EarlierProbeState }
  | { readonly probe: false; readonly next: EarlierProbeState };

export function decideEarlierProbe(
  state: EarlierProbeState,
  { hasMore, messageCount }: { hasMore: boolean; messageCount: number },
): EarlierProbeDecision {
  if (!hasMore) return { probe: false, next: state };
  if (state.stalledAt === messageCount) return { probe: false, next: state };
  if (state.pendingCount !== null) {
    if (state.pendingCount === messageCount) {
      // 上一页回来了但一条也没多：服务端没有 has_more，别再白拉。
      return { probe: false, next: { pendingCount: null, stalledAt: messageCount } };
    }
    // 条数变了 = 新页带来了历史，继续探下一页。
  }
  return { probe: true, next: { pendingCount: messageCount, stalledAt: state.stalledAt } };
}

/** 新页落地后（条数变化）同步探针：在途标记清零，允许继续往前拉。 */
export function settleEarlierProbe(
  state: EarlierProbeState,
  messageCount: number,
): EarlierProbeState {
  if (state.pendingCount === null || state.pendingCount === messageCount) return state;
  return IDLE_EARLIER_PROBE;
}
