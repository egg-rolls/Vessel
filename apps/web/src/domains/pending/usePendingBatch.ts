/**
 * 一簇审批的「一次提交」。
 *
 * 语义边界（重要）：
 * - 一次提交 = 用户点一次按钮 → 该簇里每条 ask 各发**一次** `ask.respond`；
 * - 这一批应答带**同一个** `batch_id`（additive）：gateway 按
 *   (agent, session, batch_id) 做 250ms 短窗口合并，把整批答案合成**一条** user
 *   消息 + **一次** run（用户反馈：「我是一起批复发过来的，结果拆分为了两个消息」）；
 *   只有一条的簇不带 batch_id（立刻投放，行为与旧版一字不差）；
 * - 应答不会新建 run：等待中的 `ask` 工具拿到结果后，**原来那个 run** 继续；
 *   挂起的 ask（headless / 超时挂起）同理不新建 run——网关在应答落定后 resume 同一个
 *   run id（ADR-082 Errata），前端不需要额外发起 `runs.resume`；
 * - 同簇在途时再次点击直接返回（双击 / 连点不会重复投递），逐条 requestId 的重复
 *   提交另有 `SubmitGuard` 与服务端幂等（duplicate / conflict）兜底。
 */
import { useCallback, useRef, useState } from 'react';
import type { AskUserAnswer } from '../../gateway/types';
import { markAskAnswered } from './ask-answered-marks';

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

/**
 * 一次提交的批次标记。
 *
 * 只需要「同一次提交内唯一」，不需要全局唯一：gateway 的合并 key 还含 agent / session，
 * 窗口只有 250ms。刻意保持短（≤ 32 字符）且带前缀，排障时一眼看出是批次标记。
 */
function newBatchId(): string {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function usePendingBatch(
  respondAsk: (requestId: string, answers: AskUserAnswer[], batchId?: string) => Promise<void>,
): PendingBatch {
  const inFlight = useRef<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const submit = useCallback(
    async (clusterKey: string, items: readonly PendingBatchItem[]) => {
      if (items.length === 0) return;
      if (inFlight.current.has(clusterKey)) return;
      inFlight.current.add(clusterKey);
      setBusyKey(clusterKey);
      // 提交动作一发出就先把这几题在本地记成「已答」：服务端的逐题进度要等一次
      // hydrate 才回来，中间那段窗口用户手快还能再点一次（用户实测的重复提交）。
      // 标记带 TTL 自愈，真失败也不会把题永久锁死。
      for (const item of items) {
        markAskAnswered(
          item.requestId,
          item.answers.map((answer) => answer.question_id ?? '').filter((id) => id.length > 0),
        );
      }
      try {
        // 同一批带同一个 batch_id，且**并发**发出：gateway 的合并窗口是 250ms，
        // 串行 await 会把「最后一条什么时候到」交给前一条的 RTT（慢网下就被拆成多条）。
        // respondAsk 内部已把错误收敛成 toast、不抛，所以并发不会改变错误语义。
        const batchId = items.length > 1 ? newBatchId() : undefined;
        await Promise.all(items.map((item) => respondAsk(item.requestId, item.answers, batchId)));
      } finally {
        inFlight.current.delete(clusterKey);
        setBusyKey(null);
      }
    },
    [respondAsk],
  );

  return { busyKey, submit };
}
