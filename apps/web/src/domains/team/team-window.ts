/**
 * Team 消息 / 成员窗口的纯函数（无 React）。
 *
 * `teams.get` 的消息 `limit` 没有游标；这里把“加载更早”固定为
 * 100 → 200 → 500 → 1000，并如实报告是否可能被截断。
 * 成员 `members_limit` 是服务端排好序的窗口：缺省 20、每次 +80、封顶 100。
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

/** DECISION-038 §2.3：roster 窗口缺省 20、每次 +80、封顶 100。 */
export const DEFAULT_MEMBERS_LIMIT = 20;
export const MEMBERS_LIMIT_STEP = 80;
export const MAX_MEMBERS_LIMIT = 100;

export function nextMembersLimitFor(limit: number): number {
  return Math.min(MAX_MEMBERS_LIMIT, limit + MEMBERS_LIMIT_STEP);
}

export interface MemberWindowFlags {
  /** 还有未加载的 present 成员，且窗口未到上限。 */
  canLoadMore: boolean;
  /** 已到 100 上限但总数仍更多：只能提示“仅显示前 100”。 */
  capped: boolean;
}

export function memberWindowFlags(shown: number, total: number, limit: number): MemberWindowFlags {
  return {
    canLoadMore: shown < total && limit < MAX_MEMBERS_LIMIT,
    capped: shown < total && limit >= MAX_MEMBERS_LIMIT,
  };
}

export function teamWindowFlags(limit: number, messageCount: number): TeamWindowFlags {
  return {
    canLoadEarlier: limit < MAX_LIMIT && messageCount >= limit,
    // 没有 has_more：只能保守地说明“可能被截断”。
    historyLimited: limit === MAX_LIMIT || messageCount >= limit,
    visibleCount: Math.min(messageCount, limit),
  };
}
