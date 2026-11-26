/**
 * 文本提取与回复截断。
 */

import type { FeishuMention } from './types.js';

export const TRUNCATED_SUFFIX = '…(truncated)';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只处理 text；返回 null 表示忽略。 */
export function extractText(messageType: string, content: string): string | null {
  if (messageType !== 'text') return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed) || typeof parsed.text !== 'string') return null;
    return parsed.text;
  } catch {
    return null;
  }
}

/**
 * 清洗群聊 @ 占位符（P1-A3）：飞书文本里的 `@_user_N` 是占位符，须按 mentions 还原。
 * - bot 自身的 @（mentionedType === 'bot'）：移除（只是呼叫机器人，非内容）；
 * - 其他用户的 @：还原为 `@名字`（保留语境），无名字则移除；
 * - 残留未知占位符一律移除；折叠多余横向空白并修剪首尾。
 */
export function cleanMentionPlaceholders(text: string, mentions: FeishuMention[]): string {
  let result = text;
  for (const mention of mentions) {
    if (mention.key === '') continue;
    const replacement =
      mention.mentionedType === 'bot'
        ? ''
        : mention.name !== undefined && mention.name !== ''
          ? `@${mention.name}`
          : '';
    result = result.split(mention.key).join(replacement);
  }
  result = result.replace(/@_user_\d+/g, '');
  result = result.replace(/[ \t]{2,}/g, ' ').trim();
  return result;
}

/**
 * 最终回复长度 ≤ maxChars（含 …(truncated) 后缀）。
 * 上限小于后缀长度时只回后缀的前缀。
 */
export function truncateReply(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATED_SUFFIX.length) return TRUNCATED_SUFFIX.slice(0, maxChars);
  return `${text.slice(0, maxChars - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
}
