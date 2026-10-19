/**
 * hello 帧的 seq 回退决策（纯函数，便于单测）。
 *
 * gateway 重启后事件序号从 1 重新计数；此时客户端已收到的 `currentSeq`
 * 可能大于新 gateway 的 `latest_seq`。如果把本地 lastSeq 直接推进到
 * `latest_seq`（旧实现），重放的 1..latest_seq 会全部被当成重复事件丢弃。
 * 正确做法是断开当前连接、把本地游标归零，并以 `since=0` 重新建连重放。
 *
 * 与 TUI `src/rpc/http-client.ts` 的 seq 回退状态机语义一致。
 */

export interface HelloSeqPlan {
  /** true = 必须断开当前连接并以 `since=0` 重连重放 */
  replay: boolean;
  /** 重连时使用的 since（replay=true 时恒为 0） */
  since: number;
  /** 重放前 eventStore 应重置到的 seq；null = 不重置 */
  resetTo: number | null;
  /** 需要展示给用户的提示；null = 无 */
  notice: string | null;
}

/** 判断 hello 是否表示序号回退，并给出重放计划。 */
export function planHelloSeq(latestSeq: number, currentSeq: number): HelloSeqPlan {
  if (latestSeq < currentSeq) {
    return {
      replay: true,
      since: 0,
      resetTo: 0,
      notice: 'gateway 已重启，事件序号已回退，正在从头重放',
    };
  }
  return { replay: false, since: currentSeq, resetTo: null, notice: null };
}
