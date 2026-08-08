/**
 * EventStream 实现
 * @module @vessel/core/events
 */

import type { EventHandler, EventStream, RunEvent, Unsubscribe } from '../types/event.js';

/**
 * 内存事件流实现
 * 支持发布/订阅模式，用于 trace/replay/TUI 流式渲染
 */
export class MemoryEventStream implements EventStream {
  private handlers: Set<EventHandler> = new Set();
  private history: RunEvent[] = [];
  private maxHistorySize: number;

  constructor(maxHistorySize = 1000) {
    this.maxHistorySize = maxHistorySize;
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
    // 保存到历史
    this.history.push(event);

    // 限制历史大小
    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(-this.maxHistorySize);
    }

    // 通知所有订阅者
    for (const handler of this.handlers) {
      try {
        const result = handler(event);
        // 支持异步处理器
        if (result instanceof Promise) {
          result.catch((err) => {
            console.error(`Event handler error: ${err}`);
          });
        }
      } catch (err) {
        console.error(`Event handler error: ${err}`);
      }
    }
  }

  /**
   * 清空事件历史
   */
  clear(): void {
    this.history = [];
  }

  /**
   * 获取事件历史
   * @param runId 可选的 run ID 过滤
   * @returns 事件历史
   */
  getHistory(runId?: string): RunEvent[] {
    if (runId) {
      return this.history.filter((e) => e.run_id === runId);
    }
    return [...this.history];
  }

  /**
   * 等待一次匹配事件（ADR-027：工具交互暂停原语）。
   * 订阅事件流，收到 name 匹配（且 requestId 匹配）的事件时 resolve 其 data；
   * 超时 reject。收到匹配事件后自动取消订阅。
   */
  waitFor(name: string, opts?: { requestId?: string; timeout?: number }): Promise<unknown> {
    const timeoutMs = opts?.timeout ?? 30000;

    // 先查历史：发布请求事件时若订阅者同步应答（如 headless 自动允许 / 测试自动应答），
    // 回答事件已入历史，直接 resolve，避免「先 publish 后 waitFor」的竞态丢事件。
    // 仅带 requestId 时回放历史——交互暂停事件必带 requestId（UUID，不会撞旧事件）。
    if (opts?.requestId !== undefined) {
      const existing = this.history.find(
        (e) =>
          e.type === name &&
          (e.data as Record<string, unknown> | undefined)?.requestId === opts.requestId,
      );
      if (existing) {
        return Promise.resolve(existing.data);
      }
    }

    return new Promise((resolve, reject) => {
      let unsubscribe: Unsubscribe | undefined;
      const timer = setTimeout(() => {
        unsubscribe?.();
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for event "${name}"`));
      }, timeoutMs);

      unsubscribe = this.subscribe((event) => {
        if (event.type !== name) return;
        const data = event.data as Record<string, unknown>;
        if (opts?.requestId !== undefined && data?.requestId !== opts.requestId) {
          return;
        }
        unsubscribe?.();
        clearTimeout(timer);
        resolve(event.data);
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
