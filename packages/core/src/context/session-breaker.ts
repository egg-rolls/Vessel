/**
 * per-session 摘要熔断器（0.34 S4 / R7）
 * @module @vessel-agent/core/context
 *
 * 连续失败达到阈值后，对该 session 的自动摘要冷却一段时间，避免每轮都
 * 打一次注定失败的 provider 请求；手动 / overflow 压缩（`force: true`）
 * 总是允许立即重试。状态只在内存里，不持久化，也没有新的配置键。
 */

import type { ContextSummarizer } from '../types/context.js';

/** 单个 session 的熔断状态：失败计数与冷却截止时间（epoch ms） */
interface BreakerState {
  failures: number;
  openUntil: number;
}

const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * 把基础 summarizer 包装成「按 session 取实例」的工厂：
 *
 * ```ts
 * const summarizerFor = createSessionBreaker(base);
 * const summarizer = summarizerFor(sessionId);
 * ```
 *
 * 同一个 sessionId 的多次取用共享一份熔断状态；不同 session 互不影响
 * （空串 / `'default'` 也只是普通 key）。返回的 summarizer：
 * - 冷却中且 `options.force !== true` → 返回 `''`（不调用 base、不计失败）；
 * - `options.force === true` → 先清零失败计数与冷却，再调用 base；
 * - base 返回非空 trim 字符串 → 清零；
 * - base 抛错或返回空 → 失败计数 +1；达到阈值时打开冷却，抛错原样透传
 *   （空的返回值原样返回），让调用方回退占位摘要。
 */
export function createSessionBreaker(
  base: ContextSummarizer,
  opts: {
    /** 连续失败多少次后打开熔断（默认 3） */
    maxFailures?: number;
    /** 熔断打开后的冷却时长，毫秒（默认 10 分钟） */
    cooldownMs?: number;
    /** 时钟注入（测试 / 探针用，默认 Date.now） */
    now?: () => number;
  } = {},
): (sessionId: string) => ContextSummarizer {
  const maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = opts.now ?? Date.now;
  const states = new Map<string, BreakerState>();

  const stateFor = (sessionId: string): BreakerState => {
    let state = states.get(sessionId);
    if (!state) {
      state = { failures: 0, openUntil: 0 };
      states.set(sessionId, state);
    }
    return state;
  };

  const recordFailure = (state: BreakerState): void => {
    state.failures += 1;
    if (state.failures >= maxFailures) {
      state.openUntil = now() + cooldownMs;
    }
  };

  return (sessionId: string): ContextSummarizer => {
    const state = stateFor(sessionId);
    return async (messages, options) => {
      if (options.force === true) {
        // 手动 / overflow 压缩：优先于熔断，先清零再允许一次真实尝试。
        state.failures = 0;
        state.openUntil = 0;
      } else if (state.openUntil > now()) {
        // 冷却中：不调用 base，也不计失败；空串让 core 回退占位摘要。
        return '';
      }

      let summary: string;
      try {
        summary = await base(messages, options);
      } catch (error) {
        recordFailure(state);
        // 原样抛出：core 的 catch 负责回退占位摘要。
        throw error;
      }

      if (!summary.trim()) {
        recordFailure(state);
        return summary;
      }

      state.failures = 0;
      state.openUntil = 0;
      return summary;
    };
  };
}
