/**
 * inbox 变更的 live 触发器：条带见到「本会话的 inbox 可能变了」就再读一次盘。
 *
 * 用户报的现场：agent 调 `inbox read` 把消息消费掉之后，待处理条带仍显示「等待中」，
 * 刷新页面才消失。条带的数据源是服务端持久真相（`agents.inbox`），非空时虽有 2s 兜底
 * 轮询，但**消费这件事没有任何 live 信号**——事件面上 `agent.message.queued` 只覆盖
 * 「入队」，不覆盖「拿走」。这里补上触发器那一半（数据仍然只来自那次 RPC 读，与
 * `PendingStrip.tsx` 的三条硬口径逐字一致：事件只当触发器，不拿事件拼条目）。
 *
 * 认两类事件（都按会话归属过滤，别的会话 / 子 agent 的 inbox 动作不触发本条带）：
 * - `tool.call.completed` / `tool.call.failed` 且 `tool_name === 'inbox'`：模型的
 *   read / delete 在 handler 里已经改完 inbox 状态，完成帧到达即重读（read 消费、
 *   delete 移除都在这条路上；insert 是 quiet 自述、无 session_id，本就不上条带）；
 * - `agent.message.queued`：新条目入队。条带空态时**没有轮询**（空态零流量），
 *   没有这条触发器的话，agent 源的新消息要等下一次别的触发器才上带子。
 *
 * 会话归属与 `usePendingSends.ts#echoOf` / `pending-placement.ts#queuedMessageOf`
 * 同一条规矩：`entry.sessionId`（EventStore 按 run 记住的归属）优先，缺省读
 * `data.session_id`。工具事件本身不带 session_id，全靠前者；成员事件两者都可能给。
 *
 * 水位用 `seq` 单调递增（与 `usePendingSends` 同款）：重连回放 / 回填重放不会把同一
 * 条事件吃两次；换会话 / seq 纪元回退时水位重置重扫——重扫最多多触发一次重读，
 * 条带本来就要在切会话时读一次盘，无副作用。
 *
 * @module
 */

import { useEffect, useRef, useState } from 'react';
import type { StoredEvent } from '../../state/events';

/** 成员内置 inbox 工具的工具名（`packages/agent/src/inbox.ts#createInboxTool`）。 */
const INBOX_TOOL_NAME = 'inbox';

/** 工具终态帧：handler 已执行完，inbox 状态（若被改）此刻已落定。 */
const TOOL_TERMINAL_TYPES: readonly string[] = ['tool.call.completed', 'tool.call.failed'];

/** 入队事件（与 `pending-placement.ts` 的 `QUEUED_EVENT_TYPE` 同一个字面）。 */
const QUEUED_EVENT_TYPE = 'agent.message.queued';

/**
 * 这条事件是否意味着「`sessionId` 这个会话的 inbox 可能变了」（纯函数）。
 *
 * 参数是**结构最小集**（不是 `StoredEvent`）：运行期吃 `EventStore` 的条目，驱动 /
 * 门禁也可以拿一条事件直接喂进来——两处走同一份判据。
 */
export function inboxChangeOf(
  entry: {
    event: { type: string; data?: Record<string, unknown> };
    sessionId?: string;
  },
  sessionId: string,
): boolean {
  const event = entry.event;
  const data = event.data ?? {};
  const owner =
    entry.sessionId ?? (typeof data.session_id === 'string' ? data.session_id : undefined);
  if (owner !== sessionId) return false;
  if (event.type === QUEUED_EVENT_TYPE) return true;
  return TOOL_TERMINAL_TYPES.includes(event.type) && data.tool_name === INBOX_TOOL_NAME;
}

/**
 * 数「本会话 inbox 变更」的触发器：每见到一条新事件 +1，供条带并入 `refreshKey`。
 *
 * 返回的 tick 只是触发器，不携带任何条目数据——条带拿到变化后仍然走那次
 * `agents.inbox` RPC（250ms debounce 由条带自己做）。
 */
export function useInboxRefreshTick(
  entries: readonly StoredEvent[],
  sessionId: string | null,
): number {
  const [tick, setTick] = useState(0);
  const watermark = useRef(-1);
  const scannedSession = useRef<string | null>(null);

  useEffect(() => {
    if (sessionId === null) return;
    if (scannedSession.current !== sessionId) {
      scannedSession.current = sessionId;
      watermark.current = -1;
    }
    if (entries.length === 0) return;
    let maxSeq = -1;
    for (const entry of entries) {
      if (entry.seq > maxSeq) maxSeq = entry.seq;
    }
    // 重连 / 回填换了 seq 纪元（窗口最大 seq 比水位还小）：退回重扫。
    if (maxSeq < watermark.current) watermark.current = -1;
    let next = watermark.current;
    let changed = false;
    for (const entry of entries) {
      if (entry.seq <= watermark.current) continue;
      if (entry.seq > next) next = entry.seq;
      if (inboxChangeOf(entry, sessionId)) changed = true;
    }
    watermark.current = next;
    if (changed) setTick((value) => value + 1);
  }, [entries, sessionId]);

  return tick;
}
