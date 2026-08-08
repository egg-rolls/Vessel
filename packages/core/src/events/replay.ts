/**
 * 事件回放
 * @module @vessel/core/events
 *
 * 从 FileEventStore 读取持久化事件，按序发布到 EventStream。
 * 订阅者不区分 live/replay——走同一 publish() 路径，保留原始 ts。
 */

import type { EventStream } from '../types/event.js';
import { EventType } from '../types/event.js';
import type { FileEventStore } from './file-event-store.js';

/** 回放选项 */
export interface ReplayOptions {
  /** 事件间延迟（ms），默认 50。设为 0 即时发布，用于测试 */
  delayMs?: number;
}

/**
 * 回放指定 run 的所有事件到 EventStream
 *
 * 先发布 ReplayStarted 信号，再按序发布每个原始事件（保留原始 ts），
 * 最后发布 ReplayCompleted 信号。订阅者通过同一 EventStream.subscribe()
 * 接收，不区分 live/replay。
 *
 * @param store - 事件持久化存储
 * @param runId - 要回放的 run_id
 * @param eventStream - 目标 EventStream
 * @param options - 可选配置（delayMs 默认 50ms）
 * @returns 回放的事件数量（不含 ReplayStarted/ReplayCompleted 标记），未找到返回 0
 */
export async function replayRun(
  store: FileEventStore,
  runId: string,
  eventStream: EventStream,
  options: ReplayOptions = {},
): Promise<number> {
  const delayMs = options.delayMs ?? 50;
  const events = await store.readRun(runId);

  if (events.length === 0) {
    return 0;
  }

  const startTime = Date.now();

  // 回放开始标记
  eventStream.publish({
    type: EventType.ReplayStarted,
    run_id: runId,
    data: { run_id: runId, event_count: events.length },
    ts: startTime,
  });

  // 按序发布每个原始事件（保留原始 ts）
  for (const event of events) {
    eventStream.publish(event);
    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  // 回放完成标记
  eventStream.publish({
    type: EventType.ReplayCompleted,
    run_id: runId,
    data: {
      run_id: runId,
      event_count: events.length,
      duration_ms: Date.now() - startTime,
    },
    ts: Date.now(),
  });

  return events.length;
}

/** 延迟工具函数 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
