/**
 * 文本提取与回复截断。
 */

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
 * 最终回复长度 ≤ maxChars（含 …(truncated) 后缀）。
 * 上限小于后缀长度时只回后缀的前缀。
 */
export function truncateReply(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATED_SUFFIX.length) return TRUNCATED_SUFFIX.slice(0, maxChars);
  return `${text.slice(0, maxChars - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
}
