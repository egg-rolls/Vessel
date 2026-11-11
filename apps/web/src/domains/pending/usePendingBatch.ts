/**
 * 一簇审批的「一次提交」。
 *
 * 语义边界（重要）：
 * - 一次提交 = 用户点一次按钮 → 该簇里每条 ask 各发**一次** `ask.respond`；
 * - 应答不会新建 run：等待中的 `ask_user` 工具拿到结果后，**原来那个 run** 继续；
 *   挂起的 ask（headless / 超时挂起）同理不新建 run——网关在应答落定后 resume 同一个
 *   run id（ADR-082 Errata），前端不需要额外发起 `runs.resume`；
 *   所以「一起提交只触发一次 run」在这里的实现是「一次用户动作 + 每条恰好一次应答 +
 *   同簇在途提交互斥」，不存在第二条唤醒路径；
 * - 同簇在途时再次点击直接返回（双击 / 连点不会重复投递），逐条 requestId 的重复
 *   提交另有 `SubmitGuard` 与服务端幂等（duplicate / conflict）兜底。
 */
import { useCallback, useRef, useState } from 'react';
import type { AskUserAnswer } from '../../gateway/types';

/** 一条 ask 的应答计划。 */
export interface PendingBatchItem {
  requestId: string;
  answers: AskUserAnswer[];
}

export interface PendingBatch {
  /** 正在提交的簇 key；没有提交时为 null。 */
  busyKey: string | null;
  submit: (clusterKey: string, items: readonly PendingBatchItem[]) => Promise<void>;
}

export function usePendingBatch(
  respondAsk: (requestId: string, answers: AskUserAnswer[]) => Promise<void>,
): PendingBatch {
  const inFlight = useRef<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const submit = useCallback(
    async (clusterKey: string, items: readonly PendingBatchItem[]) => {
      if (items.length === 0) return;
      if (inFlight.current.has(clusterKey)) return;
      inFlight.current.add(clusterKey);
      setBusyKey(clusterKey);
      try {
        // 串行而不是并发：错误提示、结算顺序与提交顺序一致，也不会把一串应答
        // 同时砸在同一个 gateway 上。
        for (const item of items) {
          await respondAsk(item.requestId, item.answers);
        }
      } finally {
        inFlight.current.delete(clusterKey);
        setBusyKey(null);
      }
    },
    [respondAsk],
  );

  return { busyKey, submit };
}
