/**
 * 「按优先级排序，但**禁止跳动**」的落屏闸门（通用版；0.56 会话卡 → 0.57 Team 卡共用）。
 *
 * 为什么不是「每帧排一次」：一级键是「有没有 run / 有没有成员在跑」，而 run 起止发生在
 * 任意时刻。直接每帧渲染目标顺序 ⇒ 用户正在滚动 / 正在看某张卡时，卡片会因为后台某个
 * run 开始或结束而突然换位，点击目标跟着跑掉。这是明确的「禁止跳动」要求。
 *
 * 所以拆成两步：
 * 1. **目标顺序**（调用方给的 `order`，每帧都算，纯函数、便宜）：始终是「现在应该长什么样」；
 * 2. **落屏顺序**（本 hook）：只在**显式时机**才朝目标顺序收敛 ——
 *    - `resetKey` 变了（进入列表 / 手动刷新「刷新当前视图」/ 切 agent、切归档、改搜索）；
 *    - 或者列表里出现了**新**项（新卡不能等下一次刷新才出现）。
 *    其余时候用 `mergeOrder` 保住已有项的相对位置：run 起止期间**一个都不动**。
 *
 * 徽标不走这条闸门：它读实时在飞集合，所以 run 结束时卡片**原地**失去标记，而它的位置
 * 留到下一次显式时机才归位。这就是「禁止跳动」的取舍：宁可位置晚半拍，也不让用户手指
 * 下面那张卡跳走。
 *
 * 本文件只有闸门逻辑，不认识会话 / Team：调用方给 `keyOf` + `order` + `resetKey`。
 * 会话侧包装见 `domains/chat/useStableSessionOrder.ts`，Team 侧见
 * `domains/teams/useStableTeamOrder.ts` —— 两边**必须**走这里，不许各写一套。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { mergeOrder } from '../state/sessions';

/** 顺序快照：`resetKey` 一致 + 这批 key（顺序即落屏顺序）。 */
interface OrderSnapshot {
  resetKey: string;
  keys: string[];
}

export interface StableOrderOptions<T> {
  /** 稳定身份（同一实体在两次渲染里必须给出同一个串）；重复 key 会让后面的项丢失。 */
  keyOf: (item: T) => string;
  /**
   * 目标顺序（纯函数）。`now` 由闸门在**显式时机**取样，用来夹住未来时间戳；
   * 不要在 `order` 里自己取 `Date.now()`。
   *
   * 身份会进 memo 依赖：请在调用方 `useCallback` 住它（否则每帧都重算目标顺序，
   * 结果仍正确，只是白算）。它变化 ⇒ 目标顺序重算，但落屏顺序照旧由闸门把住。
   */
  order: (items: readonly T[], now: number) => readonly T[];
  /** 显式时机：变化即「整体重置为目标顺序」。 */
  resetKey: string;
}

export function useStableOrder<T>(items: readonly T[], options: StableOrderOptions<T>): T[] {
  const { keyOf, order, resetKey } = options;
  // `now` 只在显式时机取一次：用它夹未来时间戳，避免每次渲染都不同（那会让目标顺序
  // 随真实时间漂移，虽然落屏顺序有闸门挡着，但没必要制造无谓的变更）。
  const nowRef = useRef(Date.now());
  const target = useMemo(() => order(items, nowRef.current), [items, order]);
  const targetKeys = useMemo(() => target.map((item) => keyOf(item)), [target, keyOf]);

  const [snapshot, setSnapshot] = useState<OrderSnapshot>(() => ({
    resetKey,
    keys: targetKeys,
  }));

  // 渲染期只算「按快照 + 目标补新项」，不 setState：新项在同一帧就可见（不会先少一张卡）。
  const mergedKeys = useMemo(
    () => mergeOrder(snapshot.keys, targetKeys),
    [snapshot.keys, targetKeys],
  );

  useEffect(() => {
    const reset = snapshot.resetKey !== resetKey;
    const nextKeys = reset ? targetKeys : mergedKeys;
    const unchanged =
      nextKeys.length === snapshot.keys.length &&
      nextKeys.every((key, index) => key === snapshot.keys[index]);
    if (!reset && unchanged) return;
    nowRef.current = Date.now();
    setSnapshot({ resetKey, keys: nextKeys });
  }, [resetKey, mergedKeys, targetKeys, snapshot]);

  return useMemo(() => {
    const byKey = new Map(items.map((item) => [keyOf(item), item]));
    const ordered: T[] = [];
    for (const key of mergedKeys) {
      const item = byKey.get(key);
      if (item !== undefined) ordered.push(item);
    }
    return ordered;
  }, [items, keyOf, mergedKeys]);
}
