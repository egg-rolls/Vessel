/**
 * Team 群聊正文：本地日分组 + 消息行。
 *
 * 日期分隔沿用 `.day-divider` 的视觉；消息去重由上层（`mergeMessages`）
 * 完成，本组件只按 `message_id` 做 React key，不按内容去重。
 */
import type { ReactNode } from 'react';
import { localDayKey, localDayLabel } from '../../format';
import type { TeamMember } from '../../gateway/types';
import { TeamMessageRow, type TeamMessageView } from './TeamMessageRow';

export interface TeamTranscriptProps {
  messages: readonly TeamMessageView[];
  resolveMember?: (agentId: string) => TeamMember | undefined;
  resolveMemberLabel?: (agentId: string) => string | undefined;
  onViewMemberSession?: (agentId: string, sessionId: string) => void;
  onRetrySend?: (message: TeamMessageView) => void;
}

export function TeamTranscript({
  messages,
  resolveMember,
  resolveMemberLabel,
  onViewMemberSession,
  onRetrySend,
}: TeamTranscriptProps) {
  if (messages.length === 0) return null;

  const nodes: ReactNode[] = [];
  let lastDay: string | null = null;

  for (const message of messages) {
    const day = localDayKey(message.ts);
    if (day && day !== lastDay) {
      nodes.push(
        <div className="day-divider team-day-divider" key={`day-${day}`}>
          <span>{localDayLabel(message.ts)}</span>
        </div>,
      );
      lastDay = day;
    }

    // 系统消息的主语在 `to[0]` / `mentions[0]`，不是 `from`（from 固定为 system）。
    const subjectId =
      message.kind === 'system'
        ? (message.to[0] ?? message.mentions[0] ?? message.from)
        : message.from;
    const member = resolveMember?.(subjectId);
    const sessionId = member?.session_id;
    nodes.push(
      <TeamMessageRow
        key={message.message_id}
        message={message}
        senderLabel={resolveMemberLabel?.(subjectId) ?? member?.name ?? subjectId}
        canViewSession={Boolean(member && sessionId)}
        onViewSession={
          member && sessionId && onViewMemberSession
            ? () => onViewMemberSession(member.agent_id, sessionId)
            : undefined
        }
        onRetry={message.sendStatus === 'failed' ? () => onRetrySend?.(message) : undefined}
      />,
    );
  }

  return <div className="team-transcript">{nodes}</div>;
}
