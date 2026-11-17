/**
 * 会话卡片「按在飞优先 + 最近活动」排序的**落屏闸门**（0.56）。
 *
 * 闸门本体是通用的 `app/useStableOrder.ts`（Team 卡也走它）；这里只做会话侧的接线：
 * - 目标顺序 = `orderSessions`（`state/sessions.ts`）；
 * - 身份 = `session_id`；
 * - 显式时机由调用方给 `resetKey`。
 *
 * 这样「run 起止不重排、只在显式时机收敛」只有一份实现，Team 卡不会因为复制粘贴而漂移。
 */

import { useCallback } from 'react';
import { useStableOrder } from '../../app/useStableOrder';
import type { SessionInfo } from '../../gateway/types';
import { orderSessions, type SessionInflightMap } from '../../state/sessions';

/** 会话卡片的稳定身份；模块级常量，保证进 memo 依赖时身份不变。 */
function sessionKeyOf(session: SessionInfo): string {
  return session.session_id;
}

export function useStableSessionOrder(
  sessions: readonly SessionInfo[],
  options: {
    /** 权威在飞集合（`health.get.runtime.scheduler`）；只影响目标顺序与徽标。 */
    inflight?: SessionInflightMap;
    /** 显式时机：变化即「整体重置为目标顺序」。 */
    resetKey: string;
  },
): SessionInfo[] {
  const { inflight, resetKey } = options;
  const order = useCallback(
    (list: readonly SessionInfo[], now: number) =>
      orderSessions(list, {
        ...(inflight !== undefined ? { inflight } : {}),
        now,
      }),
    [inflight],
  );
  return useStableOrder(sessions, { keyOf: sessionKeyOf, order, resetKey });
}
