/**
 * 事件转发（CONTRACT-0.43 §2.5）。
 *
 * - 注入单流 `PluginEventSource`（gateway 用 hub 适配，测试用 fake）；
 * - `contributes.events` 白名单支持精确与 `prefix.*` 通配；
 * - 每 plugin 默认 200 事件/秒，超出丢弃并计数（`plugin_event_dropped`）；
 * - DTO 转换时按键名脱敏，超限事件直接丢弃。
 *
 * @module @vessel-agent/serve/plugin-host
 */

import { normalizePluginEventDto, toPluginEventDto } from './dto.js';
import type { PluginEventDto, PluginEventSource } from './types.js';

/** 默认限流（contract §2.5） */
export const DEFAULT_EVENTS_PER_SECOND = 200;

export interface PluginHubLike {
  subscribe(handler: (event: unknown) => void): () => void;
}

export interface HubEventSourceOptions {
  /** gateway 的 redactor（返回新事件）；缺省只做键名脱敏。 */
  redact?: (event: unknown) => unknown;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 事件类型是否命中白名单（`*`、精确、`llm.*`）。 */
export function matchesEventFilter(type: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === '*' || pattern === type) return true;
    if (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1))) return true;
    if (pattern.endsWith('*') && type.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

/** 固定 1 秒窗口限流器（单 plugin）。 */
export class EventRateLimiter {
  readonly limit: number;
  private window = -1;
  private count = 0;
  private droppedInWindow = 0;
  private readonly now: () => number;

  constructor(limit = DEFAULT_EVENTS_PER_SECOND, now: () => number = Date.now) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error('EventRateLimiter limit must be a positive integer.');
    }
    this.limit = limit;
    this.now = now;
  }

  /** 允许则计数并返回 true；超出返回 false 并累计被丢弃数。 */
  allow(): boolean {
    const window = Math.floor(this.now() / 1000);
    if (window !== this.window) {
      this.window = window;
      this.count = 0;
      this.droppedInWindow = 0;
    }
    if (this.count >= this.limit) {
      this.droppedInWindow += 1;
      return false;
    }
    this.count += 1;
    return true;
  }

  /** 当前窗口已丢弃数（诊断用）。 */
  get dropped(): number {
    return this.droppedInWindow;
  }
}

/**
 * 把 gateway hub 的原始 fan-in 适配为单流 plugin 事件源。
 *
 * hub 的 raw 订阅不带 `map`（脱敏 / 摘要）；这里应用注入的 redactor，
 * 再交给 manager 做白名单、限流与 DTO 化。
 */
export function createHubPluginEventSource(
  hub: PluginHubLike,
  options: HubEventSourceOptions = {},
): PluginEventSource {
  return {
    subscribe(handler) {
      return hub.subscribe((raw) => {
        if (!isRecord(raw)) return;
        const redacted = options.redact !== undefined ? options.redact(raw) : raw;
        if (!isRecord(redacted)) return;
        // tenant_id 不进入 plugin DTO：toPluginEventDto 只取 type/ts/data。
        const dto = toPluginEventDto(redacted);
        if (dto === null) return;
        handler(dto);
      });
    },
  };
}

/** 过滤 + 限流 + DTO 归一化；被拒绝时返回 null（调用方记账）。 */
export function preparePluginEvent(
  event: PluginEventDto,
  patterns: readonly string[],
  limiter: EventRateLimiter,
): PluginEventDto | null {
  if (!matchesEventFilter(event.type, patterns)) return null;
  if (!limiter.allow()) return null;
  return normalizePluginEventDto(event);
}
