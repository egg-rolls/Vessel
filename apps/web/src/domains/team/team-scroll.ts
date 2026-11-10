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
