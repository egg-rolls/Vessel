/**
 * Gateway SSE 水位 / 背压与帧写入辅助 — 连接状态由调用方传入。
 *
 * @module @vessel-agent/serve/gateway/sse
 */

import type { RunEvent } from '@vessel-agent/core';
import type { ClientBackpressure } from '../backpressure.js';
import type { EventGap, SeqEvent } from '../event-buffer.js';

/** SSE 背压按帧计；highWaterMark 同时用于控制器队列 */
export const SSE_HIGH_WATER_FRAMES = 256;
export const SSE_LOW_WATER_FRAMES = 64;
/** 每次 pull 回放的批大小 */
export const SSE_REPLAY_BATCH = 64;

export type SseController = ReadableStreamDefaultController<unknown>;

/** SSE 回放状态：由 pull 驱动，慢连接不会一次性堆满队列 */
export interface SseReplayState {
  /** 下一条要回放的 seq */
  cursor: number;
  /** 每次 pull 最多发送的事件数 */
  batch: number;
  accepts: (event: RunEvent) => boolean;
  encode: (item: SeqEvent) => string;
}

/** 单个 SSE 连接的状态 */
export interface SseClientState {
  backpressure: ClientBackpressure;
  /** pull 之后自增；作为 Bun desiredSize 失效时的退化信号 */
  unacked: number;
  replay?: SseReplayState;
  onClose?: () => void;
  /**
   * 缺口帧编码（**过渡期，B2 落地即删**）：SSE 只走老路径，老客户端靠它知道
   * 「慢消费漏了哪一段」。时间线 epoch 在 WS 侧，不走这里。
   */
  encodeGap: (gap: EventGap) => string;
  /** 可选事件过滤（events.subscribe run_id / types） */
  accepts?: (event: RunEvent) => boolean;
}

/** 回放数据源：SeqEventBuffer 满足该形状 */
export interface SseReplaySource {
  readonly latestSeq: number;
  gapFor(seq: number): EventGap | null;
  since(seq: number): SeqEvent[];
}

export function sseInflight(
  ctrl: SseController,
  state: SseClientState,
  highWaterFrames = SSE_HIGH_WATER_FRAMES,
): number {
  const desired = ctrl.desiredSize;
  const queued = typeof desired === 'number' ? Math.max(0, highWaterFrames - desired) : 0;
  return Math.max(queued, state.unacked);
}

export function writeSse(ctrl: SseController, state: SseClientState, chunk: string): boolean {
  try {
    ctrl.enqueue(chunk);
    state.unacked += 1;
    return true;
  } catch {
    state.onClose?.();
    return false;
  }
}

/**
 * 背压恢复时**清掉**丢弃记账，**不再**往线上发 `gap` 帧（0.54 B1）。
 *
 * 为什么删帧而不是保留：`gap` 把两种成因（环形淘汰 / 回放预算跳过）压成同一个区间，
 * 而客户端无法区分（ADR-105 §9 R4）；新协议里缺口只有两种解释——写者声明的
 * `holes`，或客户端自己算错（[unacked-queue-closure.md] §3）。慢消费者丢的帧属于
 * 「客户端自己算错」那一侧：它按 `hello.count` 校验就会发现，并报 `timeline_gap_reported`。
 *
 * 但**状态必须清**：`takeGap` 是那个状态机的复位点，不调用会让 `dropping` 永远为真，
 * 之后的 `admit` 会一直按「还在丢弃」处理。
 */
/**
 * 背压恢复时补发缺口帧（**过渡期保留，B2 落地即删**）。
 *
 * SSE 没有 epoch 概念、也永远读不到时间线（`?after_timeline_seq=` 直接 501），
 * 所以这里一律是**老路径**：老客户端靠这一帧知道「慢消费漏了 [from_seq, to_seq]」，
 * 删早了就退化成静默丢帧。时间线 epoch（WS）**不**走这条。
 */
export function flushSseGap(
  ctrl: SseController,
  state: SseClientState,
  highWaterFrames = SSE_HIGH_WATER_FRAMES,
): boolean {
  const gap = state.backpressure.takeGap(sseInflight(ctrl, state, highWaterFrames));
  if (gap === null) return true;
  return writeSse(ctrl, state, state.encodeGap(gap));
}

export function sendGatedSse(
  ctrl: SseController,
  state: SseClientState,
  seq: number,
  chunk: string,
  highWaterFrames = SSE_HIGH_WATER_FRAMES,
): boolean {
  if (ctrl.desiredSize === null) {
    state.onClose?.();
    return false;
  }
  const inflight = sseInflight(ctrl, state, highWaterFrames);
  if (!state.backpressure.admit(seq, inflight)) return true;
  if (!flushSseGap(ctrl, state, highWaterFrames)) return false;
  return writeSse(ctrl, state, chunk);
}

/** 由 pull 驱动回放：每次只发 batch 条，慢客户端自然停在队列满时 */
export function pumpSseReplay(
  ctrl: SseController,
  state: SseClientState,
  source: SseReplaySource,
  highWaterFrames = SSE_HIGH_WATER_FRAMES,
): void {
  const replay = state.replay;
  if (!replay) return;
  // 环形缓冲已经淘汰掉的那一段：游标前移，并把缺口**告诉老客户端**
  // （过渡期保留，B2 落地即删）。
  const historyGap = source.gapFor(replay.cursor - 1);
  if (historyGap) {
    if (!writeSse(ctrl, state, state.encodeGap(historyGap))) return;
    replay.cursor = historyGap.to_seq + 1;
  }
  let sent = 0;
  for (const item of source.since(replay.cursor - 1)) {
    const desired = ctrl.desiredSize;
    if (typeof desired === 'number' && desired <= 0) return;
    replay.cursor = item.seq + 1;
    if (!replay.accepts(item.event)) continue;
    if (!sendGatedSse(ctrl, state, item.seq, replay.encode(item), highWaterFrames)) return;
    sent += 1;
    if (sent >= replay.batch) return;
  }
  if (replay.cursor > source.latestSeq) state.replay = undefined;
}
