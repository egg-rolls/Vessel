/**
 * Tenant 事件扇入面（0.18）：tenant 运行时事件流是唯一事实源。
 *
 * gateway 的序号、环形缓冲、广播、agent registry 都从本 hub 读取；
 * 每个 tenant 的 runtimeEvents 通过 `register()` 接入。hub **不提供 publish**，
 * 业务代码只能写自己的 tenant 流。
 *
 * - `subscribe()`：原始 fan-in（RunEngine），事件缺 `tenant_id` 时补齐（克隆）；
 * - `subscribeSequenced()`：`map`（脱敏 / 裁剪）之后、分配单调 `seq` 的事件；
 * - `since()` / `gapFor()` / `latestSeq` / `oldestSeq`：供 WS / SSE 回放。
 *
 * `map` 不得修改原事件：原始订阅者（engine）必须看到原始 requestId / input。
 *
 * @module @vessel-agent/serve/tenant-event-hub
 */

import type { EventStream, RunEvent, Unsubscribe } from '@vessel-agent/core';
import { type EventGap, type SeqEvent, SeqEventBuffer } from './event-buffer.js';

/** 注册到 hub 的 tenant 流 */
export interface TenantEventSource {
  tenantId: string;
  stream: EventStream;
}

/** hub 选项 */
export interface TenantEventHubOptions {
  /** 初始注册的 tenant 流；后续可用 `register()` 追加。 */
  streams?: readonly TenantEventSource[];
  /**
   * 环形缓冲容量（默认 10000）。0 / 缺省 = 默认值；非法值抛错。
   * 与 gateway 旧语义一致：0 不表示“无上限”。
   */
  maxHistory?: number;
  /**
   * 入缓冲前的变换（gateway 传 `capToolEvent(redact(event))`）。
   * 只影响 sequenced 订阅与回放，不影响 raw 订阅。
   */
  map?: (event: RunEvent) => RunEvent;
}

/** 事件扇入面（无 publish） */
export interface TenantEventHub {
  /** 幂等注册：同 tenant + 同 stream = no-op；同 tenant + 不同 stream 抛错。 */
  register(tenantId: string, stream: EventStream): Unsubscribe;
  /** 该 tenant 的运行时流；未注册 / 已关闭时 undefined。 */
  streamFor(tenantId: string): EventStream | undefined;
  readonly tenantIds: readonly string[];

  /** 原始 fan-in：事件缺 `tenant_id` 时补齐（克隆），不改原对象。 */
  subscribe(handler: (event: RunEvent) => void): Unsubscribe;
  /** `map` + 序号后的 fan-in。 */
  subscribeSequenced(handler: (item: SeqEvent) => void): Unsubscribe;

  /** 回放保留区（升序）。 */
  since(seq: number): SeqEvent[];
  gapFor(seq: number): EventGap | null;
  readonly latestSeq: number;
  readonly oldestSeq: number;

  /** 退订所有来源与订阅者、清空缓冲；幂等。关闭后 register / subscribe 抛错。 */
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

function withTenantId(event: RunEvent, tenantId: string): RunEvent {
  const current = (event as { tenant_id?: unknown }).tenant_id;
  if (typeof current === 'string' && current.length > 0) return event;
  return { ...event, tenant_id: tenantId };
}

/** 创建事件扇入面 */
export function createTenantEventHub(options: TenantEventHubOptions = {}): TenantEventHub {
  const configuredHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
  if (!Number.isSafeInteger(configuredHistory) || configuredHistory < 0) {
    throw new Error('TenantEventHub maxHistory must be a non-negative integer.');
  }
  const capacity = configuredHistory === 0 ? DEFAULT_MAX_HISTORY : configuredHistory;
  const buffer = new SeqEventBuffer(capacity);

  interface Registration {
    stream: EventStream;
    unsubscribe: Unsubscribe;
  }
  const registrations = new Map<string, Registration>();
  const rawHandlers = new Set<(event: RunEvent) => void>();
  const sequencedHandlers = new Set<(item: SeqEvent) => void>();
  let closed = false;

  function assertOpen(action: string): void {
    if (closed) throw new Error(`TenantEventHub is closed; cannot ${action}.`);
  }

  function fanIn(tenantId: string, event: RunEvent): void {
    const stamped = withTenantId(event, tenantId);

    for (const handler of [...rawHandlers]) {
      try {
        handler(stamped);
      } catch (error) {
        reportHubError('raw subscriber', error);
      }
    }

    let prepared: RunEvent;
    try {
      // map 必须返回新事件；这里不克隆第二次，避免掩盖原地修改。
      prepared = options.map ? options.map(stamped) : stamped;
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

  function register(tenantId: string, stream: EventStream): Unsubscribe {
    assertOpen('register');
    if (!tenantId) throw new Error('TenantEventHub tenantId is required.');
    const existing = registrations.get(tenantId);
    if (existing) {
      if (existing.stream === stream) return () => {};
      throw new Error(`TenantEventHub already registered a different stream for "${tenantId}".`);
    }

    const registration: Registration = {
      stream,
      unsubscribe: () => {},
    };
    registration.unsubscribe = stream.subscribe((event) => {
      fanIn(tenantId, event);
    });
    registrations.set(tenantId, registration);

    return () => {
      const current = registrations.get(tenantId);
      if (current !== registration) return;
      registrations.delete(tenantId);
      try {
        registration.unsubscribe();
      } catch (error) {
        reportHubError('unregister', error);
      }
    };
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

  function close(): void {
    if (closed) return;
    closed = true;
    for (const registration of registrations.values()) {
      try {
        registration.unsubscribe();
      } catch (error) {
        reportHubError('close source', error);
      }
    }
    registrations.clear();
    rawHandlers.clear();
    sequencedHandlers.clear();
  }

  for (const source of options.streams ?? []) {
    register(source.tenantId, source.stream);
  }

  return {
    register,
    streamFor: (tenantId) => registrations.get(tenantId)?.stream,
    get tenantIds() {
      return [...registrations.keys()];
    },
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
