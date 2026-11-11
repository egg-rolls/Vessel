/**
 * Team 群聊正文：本地日分组 + 消息行。
 *
 * 日期分隔沿用 `.day-divider` 的视觉；消息去重由上层（`mergeMessages`）
 * 完成，本组件只按 `message_id` 做 React key，不按内容去重。
 */
import type { ReactNode } from 'react';
import { localDayKey, localDayLabel } from '../../format';
import type { TeamMember, TeamMessage } from '../../gateway/types';
import { TeamMessageRow, type TeamMessageView } from './TeamMessageRow';

/**
 * 一条日志的 agent 收件人（消息头 `from → to` 的数据来源）。
 *
 * 只读服务端落盘的结构化 `to`（`TeamLogEntry.to`）：`teams.post` 用解析后的 mention
 * agent id 填它，人类收件人写 `human`（本机 / 跨节点 human 分支同形）。**绝不从正文
 * 里的 `@` 反解**：正文的 `@name` 没有 chip 时只是普通文本（见 `mention.ts`）。
 *
 * 这些目标**不是** agent，不进箭头：`human` / `system`、`<principal>@<node>:<team>`
 * 形式的地址、`federation:` 前缀的跨节点发送者形态。人类收件人保持「只显示 from」
 * （另有「给你」标签），广播（`to` 为空）与成员回复（`to` 为空）同样不显示箭头。
 */
function agentRecipients(message: TeamMessage): string[] {
  if (!Array.isArray(message.to)) return [];
  const recipients: string[] = [];
  for (const target of message.to) {
    if (typeof target !== 'string' || target.length === 0) continue;
    if (target === 'human' || target === 'system') continue;
    if (target.includes('@') || target.startsWith('federation:')) continue;
    if (target === message.from) continue;
    if (recipients.includes(target)) continue;
    recipients.push(target);
  }
  return recipients;
}

export interface TeamTranscriptProps {
  messages: readonly TeamMessageView[];
  resolveMember?: (agentId: string) => TeamMember | undefined;
  resolveMemberLabel?: (agentId: string) => string | undefined;
  onViewMemberSession?: (agentId: string, sessionId: string) => void;
  onRetrySend?: (message: TeamMessageView) => void;
  onEditMessage?: (message: TeamMessageView) => void;
  onResendMessage?: (message: TeamMessageView) => void;
  onRetractMessage?: (message: TeamMessageView) => void;
}

export function TeamTranscript({
  messages,
  resolveMember,
  resolveMemberLabel,
  onViewMemberSession,
  onRetrySend,
  onEditMessage,
  onResendMessage,
  onRetractMessage,
}: TeamTranscriptProps) {
  if (messages.length === 0) return null;

  const nodes: ReactNode[] = [];
  let lastDay: string | null = null;

  for (const message of messages) {
    const day = localDayKey(message.ts);
    if (day && day !== lastDay) {
      nodes.push(
        <div
          className="day-divider mx-auto mt-1.5 mb-0.5 w-full max-w-[var(--chat-content-w,860px)]"
          key={`day-${day}`}
        >
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
    // `→ to` 只给 agent 发出的日志：人类自己发的消息（`from === 'human'`）保持原样；
    // 系统灰条的主语另算（`subjectId`），它的 `to` 是事件目标而不是收件人。
    const recipientIds =
      message.kind === 'system' || message.from === 'human' ? [] : agentRecipients(message);
    const recipientLabels = recipientIds.map(
      (agentId) => resolveMemberLabel?.(agentId) ?? resolveMember?.(agentId)?.name ?? agentId,
    );
    nodes.push(
      <TeamMessageRow
        key={message.message_id}
        message={message}
        senderLabel={resolveMemberLabel?.(subjectId) ?? member?.name ?? subjectId}
        recipientLabels={recipientLabels}
        canViewSession={Boolean(member && sessionId)}
        onViewSession={
          member && sessionId && onViewMemberSession
            ? () => onViewMemberSession(member.agent_id, sessionId)
            : undefined
        }
        onRetry={message.sendStatus === 'failed' ? () => onRetrySend?.(message) : undefined}
        onEdit={onEditMessage ? () => onEditMessage(message) : undefined}
        onResend={onResendMessage ? () => onResendMessage(message) : undefined}
        onRetract={onRetractMessage ? () => onRetractMessage(message) : undefined}
      />,
    );
  }

  // 列宽只有一层来源：每条消息行（`TeamMessageRow`）/ 日分隔各自带
  // `max-w-[var(--chat-content-w,860px)]` + `mx-auto`，别在这里再套一层定宽
  // （曾经是 `max-w-180` = 720px，把内容列宽度手柄顶死在 720：拖到 860 以上全无效果）。
  return <div className="mx-auto flex w-full flex-col gap-3">{nodes}</div>;
}
