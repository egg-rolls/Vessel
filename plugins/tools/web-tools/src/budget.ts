/**
 * 输出预算（唯一口径：`estimateTokens`，ASCII 0.25 / CJK 0.5 token 每字符）。
 *
 * 本文件是**过渡期的第二道闸**，不是终态（设计 §4.3 / §4.5）：
 * `boundToolResult` 是 basic-tools 的模块私有函数 ⇒ 任何插件工具的返回值都不经过它。
 * 所以在闸上移到 `tool-calling-loop` 之前，插件必须在**生成端**就按预算生产。
 */

import { estimateTokens } from '@vessel-agent/core';

import { MAX_RESULT_TOKENS } from './config';

/** 统一的截断标记：local 与 deepseek 用**同一个函数**产出，否则模型没法比较两份输出（§4.3） */
export function omissionMarker(omitted: number): string {
  return `…（省略 ${omitted} 字符）`;
}

/** 保证 `text.length ≤ maxChars`，截断时带统一省略标记 */
export function truncateText(raw: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0) return { text: '', truncated: raw.length > 0 };
  if (raw.length <= maxChars) return { text: raw, truncated: false };

  // 标记长度依赖省略数字的位数 ⇒ 迭代几次即稳定
  let keep = Math.max(0, maxChars);
  for (let round = 0; round < 5; round += 1) {
    const kept = Math.min(keep, raw.length);
    const candidate = raw.slice(0, kept) + omissionMarker(raw.length - kept);
    const overflow = candidate.length - maxChars;
    if (overflow <= 0) return { text: candidate, truncated: true };
    if (kept === 0) break;
    keep = Math.max(0, kept - overflow);
  }
  return { text: raw.slice(0, maxChars), truncated: true };
}

/**
 * token 预算的二次裁（插件自己算一次，**不依赖闸存在**）。
 *
 * 上界同时成立才算通过：字符 ≤ `max_chars`、token ≤ min(16,000, 换算)、字节 ≤ 5 MiB。
 */
export function clampToTokenBudget(
  text: string,
  maxTokens: number = MAX_RESULT_TOKENS,
): { text: string; truncated: boolean; tokens: number } {
  const budget = Math.max(1, Math.trunc(maxTokens));
  if (estimateTokens(text) <= budget) {
    return { text, truncated: false, tokens: estimateTokens(text) };
  }
  let low = 0;
  let high = text.length;
  let best = text.slice(0, 0) + omissionMarker(text.length);
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const candidate = text.slice(0, mid) + omissionMarker(text.length - mid);
    if (estimateTokens(candidate) <= budget) {
      best = candidate;
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { text: best, truncated: true, tokens: estimateTokens(best) };
}

/** 两道闸串起来：先按字符截（保留 §4.3 的标记），再按 token 收口 */
export function applyOutputBudget(
  raw: string,
  maxChars: number,
  maxTokens: number = MAX_RESULT_TOKENS,
): { text: string; truncated: boolean; tokens: number } {
  const byChars = truncateText(raw, maxChars);
  const byTokens = clampToTokenBudget(byChars.text, maxTokens);
  return {
    text: byTokens.text,
    truncated: byChars.truncated || byTokens.truncated,
    tokens: byTokens.tokens,
  };
}

export { estimateTokens };
