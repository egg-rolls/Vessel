/**
 * 把「本地待确认」接到真实的**事件流**上：订阅 store、吃回显、认领队列 id。
 *
 * 它只做三件事，且都不碰渲染树：
 * 1. `useSyncExternalStore` 订阅 `pendingSends`（渲染侧拿到一份稳定的数组快照）；
 * 2. 盯 `snapshot.entries` 的水位：新到的 `run.started` / `user.message` 交给
 *    `noteEvent()` 认领（首选 `run_id`，没有才按队首）。认领即从 store 摘除 ——
 *    「不重复」是结构性的（摘掉之后没有第二份可画），不是渲染层去重；
 * 3. 同一水位上吃 `agent.message.queued`：把服务端那条队列条目的 `message_id` 挂到
 *    对应的 pending 上（`noteQueued`）。有了这个共享身份，条带才能让客户端那行**精确顶替**
 *    服务端那行（`pending-placement.ts#claimsEntry`），而不是同一条消息在条带上画两遍。
 *
 * **超时 sweep 已移除（用户裁定：「不太需要」）**：原来这里有一个 1 s 节拍的
 * `pendingSends.sweep()`（15 s 没回显 / 3 min 没被取用 ⇒ 失败态）。排队回退整个不再
 * 触发 —— 消息在服务端 inbox 里持久化、等被取用，客户端不该替服务端宣判「发不出去」。
 * 失败态只剩一条来路：`runs.start` RPC 明确失败（`markFailed`，立刻、带原因）。
 * store 里的 `sweep` 与 `busySessions` 闸保留（驱动 / 调试可用），但运行期无人调度。
 *
 * **为什么从 `entries` 读而不是直接订阅 WS**：`entries` 就是 `EventStore` 已经过
 * 去重 / 排序 / 归属判定之后的那份（锚点事件不参与裁剪），拿它当唯一输入口径与
 * `LiveItemStore` 完全一致 —— 不必再开一条「前端第二条事件源」。水位用 `seq`
 * 单调递增，重连回放 / 回填重放都不会让同一条被吃两次（`noteEvent` 本身也幂等）。
 *
 * @module
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { StoredEvent } from '../../state/events';
import { queuedMessageOf } from './pending-placement';
import { type PendingSend, pendingSends } from './pending-sends';

/** 只认这两类事件（与 `pending-sends.ts` 的 `ECHO_EVENT_TYPES` 同一份口径）。 */
const ECHO_TYPES: readonly string[] = ['user.message', 'run.started'];

/**
 * 回显事件里我们能用的三个字段（其余一概不读）。
 *
 * 导出是给**驱动验证**用的（脚本直接喂真实 EventStore 的 entries，与运行期走同一条
 * 映射）；运行期不在别处再导一次。
 */
export function echoOf(
  entry: StoredEvent,
): { type: string; runId?: string; sessionId?: string; text?: string } | undefined {
  const event = entry.event;
  if (!ECHO_TYPES.includes(event.type)) return undefined;
  const data = event.data ?? {};
  const sessionId =
    entry.sessionId ??
    (typeof data.session_id === 'string' ? data.session_id : undefined) ??
    undefined;
  // `run.started` 的正文在 `input`，`user.message` 在 `text`（两个都只在兜底认领时用）。
  const text =
    typeof data.text === 'string'
      ? data.text
      : typeof data.input === 'string'
        ? data.input
        : undefined;
  return {
    type: event.type,
    ...(typeof event.run_id === 'string' && event.run_id !== '' ? { runId: event.run_id } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(text !== undefined ? { text } : {}),
  };
}

export function usePendingSends(options: {
  /** 事件窗口（`EventStore` 快照的 entries）；关闭 / 未连接时传空数组。 */
  entries: readonly StoredEvent[];
  /** 当前会话：只画这一条会话的灰气泡（切会话不串台）。 */
  sessionId: string | null;
  /**
   * 重试的真实动作（`useChatSubmit.handleRetryPending`）。
   *
   * **状态复位在这里做**（回到 `sending` 并重置计时），因为「重发」本身在
   * `useChatSubmit` 里（它才拿得到 client / 草稿 / refs）—— 两边都只做自己那一半：
   * 这里管气泡怎么显示，那边管消息怎么再飞一次。
   */
  onRetry?: (pending: PendingSend) => void;
  /**
   * 调度器还有在飞工作（`running` / `queued`）的会话集合（权威：`health.get` 的
   * `runtime.scheduler`，见 `state/sessions.ts#inflightFromScheduler`）。
   *
   * **超时 sweep 移除后运行期不再消费它**（用户裁定，见模块头）：保留入参是为了
   * 调用方形状不变，且 store 的 `sweep`（驱动 / 调试）仍认这份闸。
   */
  busySessions?: ReadonlySet<string>;
}): {
  pending: readonly PendingSend[];
  /** 已经被服务端取用（回显到达）的 `message_id`：条带据此立刻滤掉那份缓存读数。 */
  sentMessageIds: readonly string[];
  retry: (pending: PendingSend) => void;
  dismiss: (pending: PendingSend) => void;
  /**
   * 真相源对账（P0-A）：条带每次 `agents.inbox` 读完后调用，把「服务端已消费 / 撤回、
   * 又不会有回显」的客户端 pending 摘掉（判据与护栏全在 `pending-sends.ts#reconcileWithServer`）。
   * 没有它，`inbox read` 取消 queued run 的那条消息永远等不到 `user.message` / `run.started`，
   * 「等待中 human」那行会常驻到刷新。
   */
  reconcile: (input: {
    sessionId: string;
    presentIds: ReadonlySet<string>;
    readStartedAt: number;
  }) => void;
  /**
   * 兜底认领升级（P0-A 配套）：条带读到真实服务端条目后，把摘要兜底认领升级成精确
   * `messageId`（判据在 `PendingStrip` 的升级 effect，配对与渲染顶替同一份贪心）。
   */
  attachMessage: (pendingId: string, messageId: string) => void;
} {
  const all = useSyncExternalStore(pendingSends.subscribe, pendingSends.list, pendingSends.list);
  const sentMessageIds = useSyncExternalStore(
    pendingSends.subscribe,
    pendingSends.sentMessageIds,
    pendingSends.sentMessageIds,
  );

  // 只看当前会话的 pending：草稿态（sessionId 为 null）的 pending 在会话 id 落定前也要画，
  // 所以「null 会话」单独放行（它还没有归属，切走之前必然属于眼前这一屏）。
  const pending = useMemo(
    () =>
      all.filter(
        (item) =>
          item.sessionId === null ||
          options.sessionId === null ||
          item.sessionId === options.sessionId,
      ),
    [all, options.sessionId],
  );

  // 超时扫描已移除（用户裁定：「不太需要」）：这里原来有一个 1 s 节拍调
  // `pendingSends.sweep(undefined, busyRef.current)` 的 interval —— 排队 / 回显超时
  // 整个不再触发，消息在服务端 inbox 里等被取用，失败态只来自 RPC 明确失败。
  // store 的 `sweep` 与 `busySessions` 闸保留给驱动 / 调试，运行期无人调度。

  // 回显水位：`seq` 只增不减，回放 / 回填只会重复不会乱序，所以一个水位够了。
  // 换会话 / 重连换了 seq 纪元（窗口最大 seq 比水位还小）时水位退回重扫 ——
  // 重扫是安全的：`noteEvent` 认领即摘除，同一条 pending 不可能被吃掉两次。
  const watermark = useRef<number>(-1);
  const scannedSession = useRef<string | null>(null);
  useEffect(() => {
    if (scannedSession.current !== options.sessionId) {
      scannedSession.current = options.sessionId;
      watermark.current = -1;
    }
    if (options.entries.length === 0) return;
    let maxSeq = -1;
    for (const entry of options.entries) {
      if (entry.seq > maxSeq) maxSeq = entry.seq;
    }
    if (maxSeq < watermark.current) watermark.current = -1;
    let next = watermark.current;
    for (const entry of options.entries) {
      if (entry.seq <= watermark.current) continue;
      if (entry.seq > next) next = entry.seq;
      const echo = echoOf(entry);
      if (echo !== undefined) {
        pendingSends.noteEvent(echo);
        continue;
      }
      // 队列 id：与回显同一个水位、同一份 entries —— 认领一次就挂住（幂等）。
      const queued = queuedMessageOf(entry);
      if (queued !== undefined) pendingSends.noteQueued(queued);
    }
    watermark.current = next;
  }, [options.entries, options.sessionId]);

  return {
    pending,
    sentMessageIds,
    retry: (item) => {
      // 真正的重发在 `useChatSubmit`（它手里有 client / 草稿 / refs）；这里只把状态复位。
      // 复位放在重发之前，避免「重发立刻失败」时气泡还停在 failed 一眼看不出在重试。
      pendingSends.create({ sessionId: item.sessionId, text: item.text, reuseId: item.id });
      options.onRetry?.(item);
    },
    dismiss: (item) => {
      pendingSends.remove(item.id);
    },
    reconcile: (input) => {
      pendingSends.reconcileWithServer(input);
    },
    attachMessage: (pendingId, messageId) => {
      pendingSends.attachMessage(pendingId, messageId);
    },
  };
}
