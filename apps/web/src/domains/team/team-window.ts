/**
 * Team 消息 / 成员窗口的纯函数（无 React）。
 *
 * 消息分页走 `teams.get.before` 游标（CONTRACT-msg-system §4.4）：尾页固定
 * `DEFAULT_LIMIT` 条，更早历史由 `before` 前插，`messages_has_more` 驱动是否还有下一页。
 * 成员 `members_limit` 是服务端排好序的窗口：缺省 20、每次 +80、封顶 100。
 */
export const DEFAULT_LIMIT = 100;

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
