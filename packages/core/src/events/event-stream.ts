/**
 * EventStream 实现
 * @module @vessel-agent/core/events
 */

import { createStderrLogger } from '../logging.js';
import type { EventHandler, EventStream, RunEvent, Unsubscribe } from '../types/event.js';

/** 未配置时的历史上限（0.3 行为） */
const DEFAULT_MAX_HISTORY = 1000;

/** 订阅者异常走 stderr logger（0.10 R2-14）；不带事件正文之外的信息 */
const logger = createStderrLogger();

/** 历史上限选项（additive） */
export interface MemoryEventStreamOptions {
  /**
   * 未配置 / 缺省 = 1000（保持 0.3 行为）；
   * 0 = 不限制；> 0 = 只保留最近 N 条（环形缓冲）。
   */
  maxHistory?: number;
}

/**
 * 解析历史上限：
 * - 未传参数 → 1000；
 * - options 对象缺 `maxHistory` → 1000；
 * - 数字 / 显式 maxHistory：0 或负数/非有限 → 0（不限制），正数 → 环形容量。
 */
function resolveMaxHistory(options?: MemoryEventStreamOptions | number): number {
  if (options === undefined) return DEFAULT_MAX_HISTORY;

  const raw = typeof options === 'number' ? options : options.maxHistory;
  if (raw === undefined) return DEFAULT_MAX_HISTORY;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;

  const value = Math.floor(raw);
  return value > 0 ? value : 0;
}

/**
 * 把 AbortSignal 的取消原因转成拒绝值（0.13）。
 * 沿用 run 取消语义：reason 是 Error 时原样保留；字符串 / 其他值包成 AbortError。
 */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(
    typeof reason === 'string' && reason.length > 0 ? reason : 'The operation was aborted',
  );
  error.name = 'AbortError';
  return error;
}

/**
 * 内存事件流实现
 * 支持发布/订阅模式，用于 trace/replay/TUI 流式渲染
 */
export class MemoryEventStream implements EventStream {
  private handlers: Set<EventHandler> = new Set();
  /** 不限上限时的历史；有上限时不用 */
  private history: RunEvent[] = [];
  private readonly maxHistorySize: number;
  /** 有上限时的环形缓冲；undefined 表示不限制 */
  private ring?: { buffer: Array<RunEvent | undefined>; head: number; count: number };

  constructor(options?: MemoryEventStreamOptions | number) {
    this.maxHistorySize = resolveMaxHistory(options);
    if (this.maxHistorySize > 0) {
      this.ring = {
        buffer: new Array<RunEvent | undefined>(this.maxHistorySize),
        head: 0,
        count: 0,
      };
    }
  }

  /**
   * 订阅事件
   * @param handler 事件处理器
   * @returns 取消订阅函数
   */
  subscribe(handler: EventHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * 发布事件
   * @param event 运行事件
   */
  publish(event: RunEvent): void {
    // 保存到历史（有上限时写环形缓冲，摊还 O(1)）
    this.record(event);

    // 通知所有订阅者
    for (const handler of this.handlers) {
      try {
        const result = handler(event);
        // 支持异步处理器
        if (result instanceof Promise) {
          result.catch((err) => {
            logger.error('event handler error', {
              run_id: event.run_id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } catch (err) {
        logger.error('event handler error', {
          run_id: event.run_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * 清空事件历史
   */
  clear(): void {
    this.history = [];
    if (this.ring) {
      this.ring.buffer = new Array<RunEvent | undefined>(this.maxHistorySize);
      this.ring.head = 0;
      this.ring.count = 0;
    }
  }

  /**
   * 获取事件历史
   * @param runId 可选的 run ID 过滤
   * @returns 事件历史（按原始时间顺序；不超过 maxHistory）
   */
  getHistory(runId?: string): RunEvent[] {
    const history = this.snapshotHistory();
    if (runId) {
      return history.filter((e) => e.run_id === runId);
    }
    return history;
  }

  /** 记录事件到保留区 */
  private record(event: RunEvent): void {
    const ring = this.ring;
    if (!ring) {
      this.history.push(event);
      return;
    }

    const capacity = this.maxHistorySize;
    const index = (ring.head + ring.count) % capacity;
    ring.buffer[index] = event;
    if (ring.count < capacity) {
      ring.count += 1;
      return;
    }
    // 已满：覆盖最旧一条，head 前移
    ring.head = (ring.head + 1) % capacity;
  }

  /** 按时间顺序复制当前保留的事件 */
  private snapshotHistory(): RunEvent[] {
    const ring = this.ring;
    if (!ring) return [...this.history];

    const capacity = this.maxHistorySize;
    const events: RunEvent[] = [];
    for (let i = 0; i < ring.count; i += 1) {
      const event = ring.buffer[(ring.head + i) % capacity];
      if (event !== undefined) events.push(event);
    }
    return events;
  }

  /**
   * 等待一次匹配事件（ADR-027：工具交互暂停原语）。
   * 订阅事件流，收到 name 匹配（且 requestId 匹配）的事件时 resolve 其 data；
   * 超时或 signal abort 时 reject，并清理 timer / 订阅 / abort listener。
   *
   * 0.13（DECISION-024 §2.3 / Addendum A）：
   * - 缺省或 `timeout <= 0` 不设 timer，一直等到应答或 abort；
   * - 只有正数超时才 reject `Timed out`；
   * - abort 立即结束等待，取消原因沿用 run 取消语义
   *   （`signal.reason` 是 Error 时原样抛出，否则 AbortError）。
   */
  waitFor(
    name: string,
    opts?: { requestId?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const timeoutMs = opts?.timeout;
    const hasTimeout = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0;
    const signal = opts?.signal;

    // 已中止：不查历史、不建订阅 / timer，立即结束（取消优先于已到达的应答）。
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }

    // 先查历史：发布请求事件时若订阅者同步应答（如 headless 自动允许 / 测试自动应答），
    // 回答事件已入历史，直接 resolve，避免「先 publish 后 waitFor」的竞态丢事件。
    // 仅带 requestId 时回放历史——交互暂停事件必带 requestId（UUID，不会撞旧事件）。
    if (opts?.requestId !== undefined) {
      const existing = this.snapshotHistory().find(
        (e) =>
          e.type === name &&
          (e.data as Record<string, unknown> | undefined)?.requestId === opts.requestId,
      );
      if (existing) {
        return Promise.resolve(existing.data);
      }
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe: Unsubscribe | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        unsubscribe?.();
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      const onAbort = (): void => {
        settle(() => reject(abortReason(signal as AbortSignal)));
      };

      // 检查与监听之间可能已被其他任务 abort；addEventListener 不会补发历史事件，
      // 因此注册后再确认一次。
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        settle(() => reject(abortReason(signal)));
        return;
      }

      if (hasTimeout) {
        timer = setTimeout(() => {
          settle(() =>
            reject(new Error(`Timed out after ${timeoutMs}ms waiting for event "${name}"`)),
          );
        }, timeoutMs);
      }

      unsubscribe = this.subscribe((event) => {
        if (event.type !== name) return;
        const data = event.data as Record<string, unknown>;
        if (opts?.requestId !== undefined && data?.requestId !== opts.requestId) {
          return;
        }
        settle(() => resolve(event.data));
      });
    });
  }

  /**
   * 获取订阅者数量
   */
  get subscriberCount(): number {
    return this.handlers.size;
  }
}

export type { EventHandler, RunEvent, Unsubscribe };
