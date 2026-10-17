/**
 * 带单调序号的网关事件环形缓冲。
 *
 * core 的 `RunEvent` 没有序号，重连时无法区分「已收到」与「缺失」。
 * gateway 在广播前给每条事件分配进程内单调 `seq`，并用固定大小的环形缓冲
 * 支持 `since` 增量回放与 `gap` 信号。序号只在传输层，不改 core 类型。
 *
 * @module @vessel/serve/event-buffer
 */

import type { RunEvent } from '@vessel/core';

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

/** 固定容量的序号事件缓冲 */
export class SeqEventBuffer {
  private readonly items: SeqEvent[] = [];
  private nextSeq = 1;

  constructor(private readonly maxSize = 10_000) {
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
