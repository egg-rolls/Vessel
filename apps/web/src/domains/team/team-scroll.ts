/**
 * Team 群聊的吸附滚动 key（纯函数，便于测试）。
 *
 * - resetKey 标识“打开/切换会话 + detail 是否已 hydrate”；加载更早历史不变。
 * - followKey 只看最后一条消息的身份，不用 rows.length：loadEarlier 在前方追加
 *   旧消息时 key 不变，因此不会触发跟随。
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
