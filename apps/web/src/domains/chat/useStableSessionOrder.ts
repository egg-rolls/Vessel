/**
 * 会话卡片「按在飞优先 + 最近活动」排序的**落屏闸门**（0.56）。
 *
 * 为什么不是「每帧排一次」：`orderSessions` 的一级键是「有没有 run 在跑」，而 run 起止
 * 发生在任意时刻。直接每帧渲染它 ⇒ 用户正在滚动 / 正在看某张卡时，卡片会因为后台某个
 * run 开始或结束而突然换位，点击目标跟着跑掉。这是明确的「禁止跳动」要求。
 *
 * 所以拆成两步：
 * 1. **目标顺序**（`orderSessions`，每帧都算，纯函数、便宜）：始终是「现在应该长什么样」；
 * 2. **落屏顺序**（本 hook）：只在**显式时机**才朝目标顺序收敛 ——
 *    - `resetKey` 变了（进入列表 / 手动刷新「刷新当前视图」/ 切 agent、切归档、改搜索）；
 *    - 或者列表里出现了**新**会话（新卡不能等下一次刷新才出现）。
 *    其余时候用 `mergeSessionOrder` 保住已有卡片的相对位置：run 起止期间**一个都不动**。
 *
 * 徽标不走这条闸门：它读的是实时在飞集合（`inflight`），所以 run 结束时卡片**原地**
 * 失去「运行中」标记，而它的位置留到下一次显式时机才归位。这就是本单对
 * 「禁止跳动」的取舍：宁可位置晚半拍，也不让用户手指下面那张卡跳走。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionInfo } from '../../gateway/types';
import { mergeSessionOrder, orderSessions, type SessionInflightMap } from '../../state/sessions';

/** 顺序快照：`resetKey` 一致 + 这批 id（顺序即落屏顺序）。 */
interface OrderSnapshot {
  resetKey: string;
  ids: string[];
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
  // `now` 只在显式时机取一次：用它夹未来时间戳，避免每次渲染都不同（那会让目标顺序
  // 随真实时间漂移，虽然落屏顺序有闸门挡着，但没必要制造无谓的变更）。
  const nowRef = useRef(Date.now());
  const target = useMemo(
    () =>
      orderSessions(sessions, {
        ...(inflight !== undefined ? { inflight } : {}),
        now: nowRef.current,
      }),
    [sessions, inflight],
  );
  const targetIds = useMemo(() => target.map((session) => session.session_id), [target]);

  const [snapshot, setSnapshot] = useState<OrderSnapshot>(() => ({
    resetKey,
    ids: targetIds,
  }));

  // 渲染期只算「按快照 + 目标补新项」，不 setState：新会话在同一帧就可见（不会先少一张卡）。
  const mergedIds = useMemo(
    () => mergeSessionOrder(snapshot.ids, targetIds),
    [snapshot.ids, targetIds],
  );

  useEffect(() => {
    const reset = snapshot.resetKey !== resetKey;
    const nextIds = reset ? targetIds : mergedIds;
    const unchanged =
      nextIds.length === snapshot.ids.length &&
      nextIds.every((id, index) => id === snapshot.ids[index]);
    if (!reset && unchanged) return;
    nowRef.current = Date.now();
    setSnapshot({ resetKey, ids: nextIds });
  }, [resetKey, mergedIds, targetIds, snapshot]);

  return useMemo(() => {
    const byId = new Map(sessions.map((session) => [session.session_id, session]));
    const ordered: SessionInfo[] = [];
    for (const id of mergedIds) {
      const session = byId.get(id);
      if (session !== undefined) ordered.push(session);
    }
    return ordered;
  }, [sessions, mergedIds]);
}
