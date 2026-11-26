/**
 * agent 级 inbox 变更的 live 触发器（P1-B 起；inbox 统一批后是**唯一**一套 inbox 触发器）。
 *
 * 硬口径：**事件只当触发器，数据永远来自那次 `agents.inbox` RPC 读**。归属按 **agent**
 * 匹配（用户裁定：inbox 是 agent 级的消息，收件箱真相视图不做会话过滤）。消费点：
 * InboxView（真相视图）与 ChatView → PendingStrip（条带，I-1 agent 级取数后触发器同口径；
 * 会话级 `useInboxRefresh.ts` 已退役删除，不留两套触发器）。
 *
 * 认三类事件（§6.4 完整词汇，主判据 + 补充）：
 * - `agent.inbox.changed` 且 `data.agent_id === agentId`：**主判据**（新 gateway）。
 *   store 状态机每个 mutation 口（append/hold/unhold/release/consume/claim/discard）
 *   落状态后一条，recall/claim/跨会话/wake-quiet 全覆盖 —— 事件只当触发器（I-2）。
 * - `agent.message.queued` 且 `data.agent_id === agentId`：补充词汇（旧 gateway 降级
 *   保活，§6.6）。服务端一条事件覆盖三种投递（input / wake / quiet），`agent_id`
 *   由 `emitForSession` 恒带 —— 无 `session_id` 的 wake/quiet 投递也能触发。
 * - `tool.call.completed` / `tool.call.failed` 且 `tool_name === 'inbox'`：补充词汇
 *   （同②）。模型的 read / delete 在 handler 里已改完 inbox 状态，完成帧到达即重读。
 *   工具帧不带 `agent_id`，归属两条路：`data.agent_id` 命中（新 gateway 若带），或
 *   事件的会话归属（EventStore 按 run 记的 `sessionId`，缺省读 `data.session_id`）
 *   落在该 agent 的 body sessions 集合里（roster `bodies` 派生，body_id ≡ session_id）。
 *
 * ②③不是过渡态双系统：新 gateway 下①覆盖全部，②③冗余但经去抖无害；旧 gateway 下
 * ②③是会话内唯一信号。事件丢失的静默缺口由 resync 点承接（R1-R6，§6.5，零 interval）。
 *
 * 水位用 `seq` 单调递增（与 `usePendingSends` 同款）：重连回放 / 回填重放不会
 * 把同一条事件吃两次；换 agent / seq 纪元回退时水位重置重扫 —— 重扫最多多触发一次
 * 重读，视图本来就要在切 agent 时读一次盘，无副作用。
 *
 * @module
 */

import { useEffect, useRef, useState } from 'react';
import type { StoredEvent } from '../../state/events';

/** 成员内置 inbox 工具的工具名（`packages/agent/src/inbox.ts#createInboxTool`）。 */
const INBOX_TOOL_NAME = 'inbox';

/** 工具终态帧：handler 已执行完，inbox 状态（若被改）此刻已落定。 */
const TOOL_TERMINAL_TYPES: readonly string[] = ['tool.call.completed', 'tool.call.failed'];

/** 入队事件（与 `pending-placement.ts` 同一个字面）。 */
const QUEUED_EVENT_TYPE = 'agent.message.queued';

/** inbox 状态机变更帧（§6.2，store onChange 钩子唯一来源）——触发器主判据。 */
const INBOX_CHANGED_EVENT_TYPE = 'agent.inbox.changed';

/**
 * 这条事件是否意味着「`agentId` 这个 agent 的 inbox 可能变了」（纯函数）。
 *
 * 参数是**结构最小集**（不是 `StoredEvent`）：运行期吃 `EventStore` 的条目，
 * 门禁 / 驱动也可以拿一条事件直接喂进来 —— 两处走同一份判据。
 *
 * `agentSessions` = 该 agent 的 body session 集合（含 primary；body_id ≡ session_id）。
 * 空集时工具帧无从归属 ⇒ 不触发（①②仍按 `agent_id` 触发，其余由 resync 点承接）。
 */
export function agentInboxChangeOf(
  entry: {
    event: { type: string; data?: Record<string, unknown> };
    sessionId?: string;
  },
  agentId: string,
  agentSessions: ReadonlySet<string>,
): boolean {
  const event = entry.event;
  const data = event.data ?? {};
  // ① 主判据：store 状态机变更帧（全 mutation 口，§6.2）。
  if (event.type === INBOX_CHANGED_EVENT_TYPE) return data.agent_id === agentId;
  // ② 补充：入队帧（旧 gateway 降级保活）。
  if (event.type === QUEUED_EVENT_TYPE) return data.agent_id === agentId;
  if (!TOOL_TERMINAL_TYPES.includes(event.type) || data.tool_name !== INBOX_TOOL_NAME) {
    return false;
  }
  if (data.agent_id === agentId) return true;
  const owner =
    entry.sessionId ?? (typeof data.session_id === 'string' ? data.session_id : undefined);
  return owner !== undefined && agentSessions.has(owner);
}

/**
 * 数「该 agent inbox 变更」的触发器：每见到一条新事件 +1，供视图 / 条带并入重读信号。
 *
 * 返回的 tick 只是触发器，不携带任何条目数据 —— 消费点拿到变化后仍然走那次
 * `agents.inbox{agent_id}` RPC（去抖由消费点自己做）。
 *
 * `agentId` 缺省 = 归属未知（条带的 catalogAgentId 派生链可能落空）⇒ 不触发，
 * 与「缺省不发 RPC」同一条不猜 id 的规矩。
 */
export function useAgentInboxRefreshTick(
  entries: readonly StoredEvent[],
  agentId: string | undefined,
  agentSessions: ReadonlySet<string>,
): number {
  const [tick, setTick] = useState(0);
  const watermark = useRef(-1);
  const scannedAgent = useRef<string | null>(null);

  useEffect(() => {
    if (agentId === undefined) return;
    if (scannedAgent.current !== agentId) {
      scannedAgent.current = agentId;
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
      if (agentInboxChangeOf(entry, agentId, agentSessions)) changed = true;
    }
    watermark.current = next;
    if (changed) setTick((value) => value + 1);
  }, [entries, agentId, agentSessions]);

  return tick;
}
