/**
 * Team 卡片「有成员在跑优先 + 最近活动」排序的**落屏闸门**（0.57）。
 *
 * 闸门本体与会话卡是同一个（`app/useStableOrder.ts` + `state/sessions.ts#mergeOrder`），
 * 这里只做 Team 侧的接线：
 * - 目标顺序 = `orderTeams`（`state/team-order.ts`）；
 * - 身份 = `nodeKey:team_id`（Team 栏跨节点，光 `team_id` 不唯一）；
 * - 显式时机由调用方给 `resetKey`。
 *
 * 于是「成员 run 起止不让卡片换位」和会话侧是同一份实现、同一套时机，不会一边收敛
 * 一边抖动。
 */
import { useCallback } from 'react';
import { useStableOrder } from '../../app/useStableOrder';
import {
  orderTeams,
  type TeamMembersByTeam,
  type TeamOrderCard,
  teamCardKey,
} from '../../state/team-order';

/** 卡片的稳定身份；模块级函数，保证进 memo 依赖时身份不变。 */
function cardKeyOf(card: TeamOrderCard): string {
  return teamCardKey(card.nodeKey, card.team.team_id);
}

export function useStableTeamOrder(
  cards: readonly TeamOrderCard[],
  options: {
    /** 有成员正在跑的 Team key（`health.get.runtime.scheduler`）；只影响目标顺序与徽标。 */
    runningTeams?: ReadonlySet<string>;
    /** Team key → roster 成员；语义见 `state/team-order.ts`。 */
    membersByTeam?: TeamMembersByTeam;
    /** 显式时机：变化即「整体重置为目标顺序」。 */
    resetKey: string;
  },
): TeamOrderCard[] {
  const { runningTeams, membersByTeam, resetKey } = options;
  const order = useCallback(
    (list: readonly TeamOrderCard[], now: number) =>
      orderTeams(list, {
        ...(runningTeams !== undefined ? { runningTeams } : {}),
        ...(membersByTeam !== undefined ? { membersByTeam } : {}),
        now,
      }),
    [runningTeams, membersByTeam],
  );
  // 同会话侧：有成员**刚**开始跑 ⇒ 把这张 team 卡顶上去一次；跑完不移动。
  const promoteToken = useCallback(
    (card: TeamOrderCard): string | null => {
      const key = teamCardKey(card.nodeKey, card.team.team_id);
      return runningTeams?.has(key) === true ? key : null;
    },
    [runningTeams],
  );
  return useStableOrder(cards, { keyOf: cardKeyOf, order, resetKey, promoteToken });
}
