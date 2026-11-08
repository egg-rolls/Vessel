/**
 * 事件扇入面（0.18；0.49 T3 收敛为单执行面）。
 *
 * gateway 的序号、环形缓冲、广播、agent registry 都从本 hub 读取；
 * 单运行时的 runtimeEvents 作为构造数据接入（0.49 T4：单 `stream`）。
 * hub **不提供 publish**，业务代码只能写运行时流。
 *
 * - `subscribe()`：原始 fan-in（interactions registry），事件写入构造时的单 id（克隆）；
 * - `subscribeSequenced()`：`map`（脱敏 / 裁剪）之后、分配单调 `seq` 的事件；
 * - `since()` / `gapFor()` / `latestSeq` / `oldestSeq`：供 WS / SSE 回放。
 *
 * `map` 不得修改原事件：原始订阅者（interactions registry）必须看到原始 requestId / input。
 *
 * @module @vessel-agent/serve/tenant-event-hub
 */

import {
  createDefaultTraceRedactor,
  type EventStream,
  type RunEvent,
  type TraceRedactor,
  type Unsubscribe,
} from '@vessel-agent/core';
import { type EventGap, type SeqEvent, SeqEventBuffer } from './event-buffer.js';
import { summarizeBroadcastEvent } from './event-summary.js';
import { capToolEvent } from './tool-events.js';

/** hub 选项 */
export interface TenantEventHubOptions {
  /** 单运行时流（0.49 C3 / T4：单执行面只有一条流）。 */
  stream?: EventStream;
  /**
   * 环形缓冲容量（默认 10000）。0 / 缺省 = 默认值；非法值抛错。
   * 与 gateway 旧语义一致：0 不表示“无上限”。
   */
  maxHistory?: number;
  /**
   * 入缓冲前的变换（必填；gateway 传 `capToolEvent(redact(event))`）。
   * 只影响 sequenced 订阅与回放，不影响 raw 订阅。必须返回新事件，不得原地修改。
   */
  map: (event: RunEvent) => RunEvent;
}

/** 带默认脱敏 / 裁剪的 hub 选项（gateway / local dispatcher 的装配入口）。 */
export interface GatewayEventHubOptions extends Omit<TenantEventHubOptions, 'map'> {
  /** 缺省 = core 默认 redactor；应与 gateway 的 `redactor` 一致。 */
  redactor?: TraceRedactor;
}

/** 事件扇入面（无 publish） */
export interface TenantEventHub {
  /** 单运行时流；未配置 / 已关闭时 undefined。 */
  stream(): EventStream | undefined;

  /** 原始 fan-in：事件原样分发，不改原对象。 */
  subscribe(handler: (event: RunEvent) => void): Unsubscribe;
  /** `map` + 序号后的 fan-in。 */
  subscribeSequenced(handler: (item: SeqEvent) => void): Unsubscribe;

  /** 回放保留区（升序）。 */
  since(seq: number): SeqEvent[];
  gapFor(seq: number): EventGap | null;
  readonly latestSeq: number;
  readonly oldestSeq: number;

  /** 退订来源与订阅者、清空缓冲；幂等。关闭后 subscribe 抛错。 */
  close(): void;
}

const DEFAULT_MAX_HISTORY = 10_000;

function reportHubError(action: string, error: unknown): void {
  console.error(
    `[vessel] tenant event hub: ${action} failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

/** 创建事件扇入面 */
export function createTenantEventHub(options: TenantEventHubOptions): TenantEventHub {
  const configuredHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
  if (!Number.isSafeInteger(configuredHistory) || configuredHistory < 0) {
    throw new Error('TenantEventHub maxHistory must be a non-negative integer.');
  }
  const capacity = configuredHistory === 0 ? DEFAULT_MAX_HISTORY : configuredHistory;
  const buffer = new SeqEventBuffer(capacity);

  // 0.49 C3 / T4：单执行面只有一条流。旧事件仍留在各自来源（持久化 / 回放）中，
  // 读取端不做 tenant 过滤，因此 legacy id 不会被隐藏。
  const source = options.stream;
  const rawHandlers = new Set<(event: RunEvent) => void>();
  const sequencedHandlers = new Set<(item: SeqEvent) => void>();
  let closed = false;

  function assertOpen(action: string): void {
    if (closed) throw new Error(`TenantEventHub is closed; cannot ${action}.`);
  }

  function fanIn(event: RunEvent): void {
    for (const handler of [...rawHandlers]) {
      try {
        handler(event);
      } catch (error) {
        reportHubError('raw subscriber', error);
      }
    }

    let prepared: RunEvent;
    try {
      // map 必须返回新事件；这里不克隆第二次，避免掩盖原地修改。
      prepared = options.map(event);
    } catch (error) {
      reportHubError('map', error);
      return;
    }
    const seq = buffer.append(prepared);
    const item: SeqEvent = { seq, event: prepared };
    for (const handler of [...sequencedHandlers]) {
      try {
        handler(item);
      } catch (error) {
        reportHubError('sequenced subscriber', error);
      }
    }
  }

  function subscribe(handler: (event: RunEvent) => void): Unsubscribe {
    assertOpen('subscribe');
    rawHandlers.add(handler);
    return () => {
      rawHandlers.delete(handler);
    };
  }

  function subscribeSequenced(handler: (item: SeqEvent) => void): Unsubscribe {
    assertOpen('subscribeSequenced');
    sequencedHandlers.add(handler);
    return () => {
      sequencedHandlers.delete(handler);
    };
  }

  let sourceUnsubscribe: Unsubscribe | undefined;
  if (source !== undefined) {
    // 0.49 T4：不戳记 tenant_id；事件原样扇入。
    sourceUnsubscribe = source.subscribe(fanIn);
  }

  function close(): void {
    if (closed) return;
    closed = true;
    try {
      sourceUnsubscribe?.();
    } catch (error) {
      reportHubError('close source', error);
    }
    sourceUnsubscribe = undefined;
    rawHandlers.clear();
    sequencedHandlers.clear();
  }

  return {
    stream: () => source,
    subscribe,
    subscribeSequenced,
    since: (seq) => buffer.since(seq),
    gapFor: (seq) => buffer.gapFor(seq),
    get latestSeq() {
      return buffer.latestSeq;
    },
    get oldestSeq() {
      return buffer.oldestSeq;
    },
    close,
  };
}

/**
 * gateway / local dispatcher 的装配入口：默认 redactor + 工具事件裁剪。
 * 嵌入方若给 gateway 传了自定义 `redactor`，应把同一个实例也传到这里。
 */
export function createGatewayEventHub(options: GatewayEventHubOptions = {}): TenantEventHub {
  const { redactor: providedRedactor, ...rest } = options;
  const redactor = providedRedactor ?? createDefaultTraceRedactor();
  return createTenantEventHub({
    ...rest,
    // 顺序：脱敏 → 工具 payload 裁剪 → 广播摘要（raw fan-in 不经此 map）。
    map: (event) => summarizeBroadcastEvent(capToolEvent(redactor.redact(event))),
  });
}
