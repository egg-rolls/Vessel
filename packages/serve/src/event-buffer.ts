/**
 * 带单调序号的网关事件环形缓冲。
 *
 * core 的 `RunEvent` 没有序号，重连时无法区分「已收到」与「缺失」。
 * gateway 在广播前给每条事件分配进程内单调 `seq`，并用固定大小的环形缓冲
 * 支持 `since` 增量回放与 `gap` 信号。序号只在传输层，不改 core 类型。
 *
 * @module @vessel-agent/serve/event-buffer
 */

import type { RunEvent } from '@vessel-agent/core';

/** 缓冲条目 */
export interface SeqEvent {
  seq: number;
  event: RunEvent;
}

/** 事件缺口（客户端错过了 [from, to]） */
export interface EventGap {
  from_seq: number;
  to_seq: number;
}

/**
 * 环形缓冲默认容量（0.53：10000 → 50000，与 `replay-budget.ts#MAX_EVENTS` 同步）。
 *
 * ## 常驻内存代价（放大窗口的真实成本，写在这里免得被当成免费的）
 *
 * 环里存的是 `SeqEvent` = `{ seq, event }`，`event` 是**同一个** `RunEvent` 对象的引用
 * （广播时就已经在堆上，环只延长它的生命周期，不复制正文）。所以代价等于
 * 「这 50000 条事件本来会被 GC 收掉的那部分内存」：
 *
 * - 编码后的 `tool.call.completed` / `llm.request` 带正文，按会话实测普遍在
 *   **0.3–3 KB/条**；50000 条 ⇒ **约 15–150 MB** 常驻（按 300 B 的极小事件算是 15 MB 下限）；
 *   一条 MB 级工具输出会让这个会话在环里占掉几十条的位置。
 * - 环是**全局一份**（整个 gateway 进程 / 每个 tenant hub 一个），不是每会话一份：
 *   多会话并发时，单个会话能回放的历史会被挤短 —— 这是「窗口靠内存兜底」的天花板。
 * - 超出窗口的部分**不再不可恢复**：`sessions.events`（磁盘事件日志分页）是回填的兜底，
 *   前端按 `sessions.get.event_cursor` 判断有没有洞。
 *
 * 想再放大（10 万条以上）请先量 RSS：这个数是「纯涨」的常驻，不是峰值。
 */
export const DEFAULT_MAX_HISTORY = 50_000;

/** 固定容量的序号事件缓冲 */
export class SeqEventBuffer {
  private readonly items: SeqEvent[] = [];
  private nextSeq = 1;

  constructor(private readonly maxSize = DEFAULT_MAX_HISTORY) {
    if (maxSize < 1) throw new Error('SeqEventBuffer maxSize must be >= 1');
  }

  /** 追加事件并返回分配的序号 */
  append(event: RunEvent): number {
    const seq = this.nextSeq++;
    this.items.push({ seq, event });
    if (this.items.length > this.maxSize) {
      this.items.splice(0, this.items.length - this.maxSize);
    }
    return seq;
  }

  /** 最新序号；无事件时为 0 */
  get latestSeq(): number {
    return this.nextSeq - 1;
  }

  /** 当前保留的最早序号；空缓冲时等于 nextSeq */
  get oldestSeq(): number {
    return this.items[0]?.seq ?? this.nextSeq;
  }

  /** 序号之后的全部保留事件（升序） */
  since(seq: number): SeqEvent[] {
    return this.items.filter((item) => item.seq > seq);
  }

  /**
   * 计算 since 与保留区间之间的缺口。
   * 返回 null 表示没有缺口（或客户端已是最新）。
   */
  gapFor(since: number): EventGap | null {
    const first = this.items[0]?.seq;
    if (first === undefined) return null;
    if (since < first - 1) {
      return { from_seq: since + 1, to_seq: first - 1 };
    }
    return null;
  }
}
