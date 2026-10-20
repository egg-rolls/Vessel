/**
 * Host 级 EventBus 实现（复用 MemoryEventStream，不新增事件机制）。
 *
 * @module @vessel-agent/core/kernel
 */

import { MemoryEventStream } from '../events/event-stream.js';
import type { EventHandler, RunEvent, Unsubscribe } from '../types/event.js';
import type { EventBus, EventFilter } from './types.js';

/** 过滤事件：agentId 取自 data.agentId（core 内部 camelCase，A7） */
function matches(event: RunEvent, filter?: EventFilter): boolean {
  if (!filter) return true;
  if (filter.runId !== undefined && event.run_id !== filter.runId) return false;
  if (filter.typePrefix !== undefined && !event.type.startsWith(filter.typePrefix)) return false;
  if (filter.nodeId !== undefined && event.node_id !== filter.nodeId) return false;
  if (filter.agentId !== undefined) {
    const data = event.data as Record<string, unknown> | undefined;
    if (data?.agentId !== filter.agentId) return false;
  }
  return true;
}

/** Host 聚合事件总线 */
export class MemoryEventBus implements EventBus {
  private readonly stream: MemoryEventStream;

  /**
   * @param options 与 `MemoryEventStreamOptions` 结构一致（kernel 不 import 实现类型，
   *   保持 D4 依赖边界）；缺省 / `{}` = 1000，`0` = 不限制。
   */
  constructor(options?: { maxHistory?: number }) {
    this.stream = new MemoryEventStream(options);
  }

  subscribe(handler: EventHandler): Unsubscribe {
    return this.stream.subscribe(handler);
  }

  subscribeFiltered(handler: EventHandler, filter?: EventFilter): Unsubscribe {
    return this.stream.subscribe((event) => {
      if (matches(event, filter)) handler(event);
    });
  }

  publish(event: RunEvent): void {
    this.stream.publish(event);
  }

  clear(): void {
    this.stream.clear();
  }

  getHistory(runId?: string): RunEvent[] {
    return this.stream.getHistory(runId);
  }

  waitFor(name: string, opts?: { requestId?: string; timeout?: number }): Promise<unknown> {
    return this.stream.waitFor(name, opts);
  }
}
