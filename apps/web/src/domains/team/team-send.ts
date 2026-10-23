/**
 * Team 发送相关的纯函数（无 React）。
 *
 * - 乐观消息只在服务端还没有同 `message_id` 时渲染；
 * - `postTeam` 无幂等键，失败后只能按 content + mentions + ts 对账，
 *   不能按内容自动重试；
 * - 发送期间不发新的 `teams.get`，避免乐观项与轮询结果短暂重复。
 */
import type { TeamDelivery, TeamMessage } from '../../gateway/types';
import { mergeMessages } from '../../state/teams';
import type { TeamMessageView } from './TeamMessageRow';

export interface LocalSend {
  localId: string;
  messageId?: string;
  content: string;
  mentions: string[];
  ts: number;
  status: 'sending' | 'sent' | 'failed';
  error?: string;
  deliveries?: TeamDelivery[];
}

export function shouldFetchTeam(sending: boolean, hasDetail: boolean): boolean {
  return !(sending && hasDetail);
}

function sameMentions(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

/** 响应丢失时，用 content + mentions + ts 找服务端是否已经写入。 */
export function matchWrittenMessage(
  messages: readonly TeamMessage[],
  content: string,
  mentions: readonly string[],
  since: number,
): TeamMessage | undefined {
  return messages.find(
    (message) =>
      message.from === 'human' &&
      message.content === content &&
      message.ts >= since &&
      sameMentions(message.mentions, mentions),
  );
}

/**
 * 把服务端消息与本地乐观项合成渲染行。
 *
 * 服务端已有同 `message_id` 时不再渲染乐观项；本地项只保留
 * `sending / failed / sent` 的附加状态，正文仍以服务端为准。
 */
export function buildTeamRows(
  messages: readonly TeamMessage[],
  sends: readonly LocalSend[],
  teamId: string,
): TeamMessageView[] {
  const serverIds = new Set(messages.map((message) => message.message_id));
  const sendByKey = new Map<string, LocalSend>();
  const localMessages: TeamMessage[] = [];
  for (const send of sends) {
    const key = send.messageId ?? send.localId;
    sendByKey.set(key, send);
    if (serverIds.has(key)) continue;
    localMessages.push({
      message_id: key,
      team_id: teamId,
      from: 'human',
      to: [],
      mentions: send.mentions,
      content: send.content,
      ts: send.ts,
      kind: send.mentions.length > 0 ? 'mention' : 'post',
    });
  }
  return mergeMessages(messages, localMessages).map((message) => {
    const send = sendByKey.get(message.message_id);
    if (!send) return message;
    return {
      ...message,
      ...(send.status === 'failed'
        ? { sendStatus: 'failed' as const, sendError: send.error }
        : send.status === 'sending'
          ? { sendStatus: 'sending' as const }
          : { sendStatus: 'sent' as const }),
      ...(send.deliveries ? { deliveries: send.deliveries } : {}),
    };
  });
}
