/**
 * 把「本地待确认」接到真实的**事件流**上：订阅 store、扫超时、吃回显。
 *
 * 它只做三件事，且都不碰渲染树：
 * 1. `useSyncExternalStore` 订阅 `pendingSends`（渲染侧拿到一份稳定的数组快照）；
 * 2. 1 s 节拍调 `sweep()` —— 15 s 没回显 ⇒ 失败态（**永不静默消失**）；
 * 3. 盯 `snapshot.entries` 的水位：新到的 `run.started` / `user.message` 交给
 *    `noteEvent()` 认领（首选 `run_id`，没有才按队首）。认领即从 store 摘除 ——
 *    「不重复」是结构性的（摘掉之后没有第二份可画），不是渲染层去重。
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
import { PENDING_SWEEP_INTERVAL_MS, type PendingSend, pendingSends } from './pending-sends';

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
}): {
  pending: readonly PendingSend[];
  retry: (pending: PendingSend) => void;
  dismiss: (pending: PendingSend) => void;
} {
  const all = useSyncExternalStore(pendingSends.subscribe, pendingSends.list, pendingSends.list);

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

  // 超时扫描：`queued` 不参与（排队本身可能就是几分钟），判定在 store 里。
  useEffect(() => {
    const timer = window.setInterval(() => {
      pendingSends.sweep();
    }, PENDING_SWEEP_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

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
      if (echo === undefined) continue;
      pendingSends.noteEvent(echo);
    }
    watermark.current = next;
  }, [options.entries, options.sessionId]);

  return {
    pending,
    retry: (item) => {
      // 真正的重发在 `useChatSubmit`（它手里有 client / 草稿 / refs）；这里只把状态复位。
      // 复位放在重发之前，避免「重发立刻失败」时气泡还停在 failed 一眼看不出在重试。
      pendingSends.create({ sessionId: item.sessionId, text: item.text, reuseId: item.id });
      options.onRetry?.(item);
    },
    dismiss: (item) => {
      pendingSends.remove(item.id);
    },
  };
}
