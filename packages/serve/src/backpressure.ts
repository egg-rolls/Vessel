/**
 * 慢客户端背压（0.4 W2，DECISION-009 §5.7 / §10.3.5）。
 *
 * 每个连接维护一个 `ClientBackpressure`。事件帧在超过高水位时被丢弃，
 * 并记录丢弃区间；当积压回落到低水位以下时，补发一个合并后的 `gap`。
 * 控制帧（hello / gap / res / ping）不经过本类，保证客户端始终能收到
 * 错误、心跳与缺口通知。
 *
 * 该类是纯状态机：调用方负责提供当前积压量（字节或帧数）。
 *
 * @module @vessel-agent/serve/backpressure
 */

import type { EventGap } from './event-buffer.js';

export interface BackpressureThresholds {
  /** 超过该积压量开始丢弃事件 */
  high: number;
  /** 回落到该值以下才恢复发送并补 gap */
  low: number;
}

/** 单个连接的丢弃/恢复状态机 */
export class ClientBackpressure {
  private readonly high: number;
  private readonly low: number;
  private dropping = false;
  private dropFrom = 0;
  private dropTo = 0;

  constructor(thresholds: BackpressureThresholds) {
    if (!Number.isFinite(thresholds.high) || thresholds.high <= 0) {
      throw new Error('ClientBackpressure high threshold must be > 0');
    }
    if (!Number.isFinite(thresholds.low) || thresholds.low < 0) {
      throw new Error('ClientBackpressure low threshold must be >= 0');
    }
    if (thresholds.low >= thresholds.high) {
      throw new Error('ClientBackpressure low threshold must be < high threshold');
    }
    this.high = thresholds.high;
    this.low = thresholds.low;
  }

  get isDropping(): boolean {
    return this.dropping;
  }

  /** 当前待补发的合并缺口；没有则为 null */
  get pendingGap(): EventGap | null {
    return this.dropping ? { from_seq: this.dropFrom, to_seq: this.dropTo } : null;
  }

  /**
   * 判断一个事件帧是否可以发送。
   * 返回 false 表示已丢弃并记录 seq；返回 true 后调用方仍应调用 `takeGap`
   * 以在恢复时先补发缺口。
   */
  admit(seq: number, inflight: number): boolean {
    if (inflight > this.high) {
      this.drop(seq);
      return false;
    }
    if (this.dropping && inflight > this.low) {
      this.drop(seq);
      return false;
    }
    return true;
  }

  /**
   * 积压已回落到低水位以下时，返回合并后的缺口并清空状态；否则返回 null。
   * 调用方应在发送事件前调用一次。
   */
  takeGap(inflight: number): EventGap | null {
    if (!this.dropping || inflight > this.low) return null;
    const gap = { from_seq: this.dropFrom, to_seq: this.dropTo };
    this.dropping = false;
    this.dropFrom = 0;
    this.dropTo = 0;
    return gap;
  }

  private drop(seq: number): void {
    if (!this.dropping) {
      this.dropping = true;
      this.dropFrom = seq;
    }
    this.dropTo = seq;
  }
}
