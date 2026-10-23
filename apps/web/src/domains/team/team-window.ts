/**
 * Team 消息窗口的纯函数（无 React）。
 *
 * S3 `teams.get` 只有 `limit`，没有游标；这里把“加载更早”固定为
 * 100 → 200 → 500 → 1000，并如实报告是否可能被截断。
 */
export const DEFAULT_LIMIT = 100;
const LIMIT_STEPS = [100, 200, 500, 1000] as const;
export const MAX_LIMIT = 1000;

export function nextLimitFor(limit: number): number {
  return LIMIT_STEPS.find((step) => step > limit) ?? MAX_LIMIT;
}

export interface TeamWindowFlags {
  canLoadEarlier: boolean;
  historyLimited: boolean;
  visibleCount: number;
}

export function teamWindowFlags(limit: number, messageCount: number): TeamWindowFlags {
  return {
    canLoadEarlier: limit < MAX_LIMIT && messageCount >= limit,
    // 没有 has_more：只能保守地说明“可能被截断”。
    historyLimited: limit === MAX_LIMIT || messageCount >= limit,
    visibleCount: Math.min(messageCount, limit),
  };
}
