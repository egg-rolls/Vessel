/**
 * Provider 请求超时装饰器。
 *
 * Provider 插件在工厂里包一层：用 AbortSignal.timeout 生成超时信号，
 * 再与调用方 signal 经 AbortSignal.any 合并；超时后以可识别的
 * ProviderTimeoutError 拒绝。默认 120s，可通过插件配置关闭（<=0）。
 */

import type { ChatRequest, LLMProvider, LLMResponse } from '@vessel/core';

/** 默认超时（毫秒） */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** 超时错误码（调用方按 code / instanceof 识别） */
export const PROVIDER_TIMEOUT_CODE = 'provider_timeout';

/** 请求超时错误；不吞，交给调用方决定重试或终止 */
export class ProviderTimeoutError extends Error {
  readonly code = PROVIDER_TIMEOUT_CODE;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms`);
    this.name = 'ProviderTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 解析配置值：缺省 / 非数字 / 非有限值 → 默认 120s；<=0 → 关闭（返回 0）。
 * 非法值不能静默变成“无超时”，否则一个拼写错误会让请求永久挂起。
 */
export function resolveTimeoutMs(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return value > 0 ? value : 0;
}

/** 包装 provider：超过 timeoutMs 仍未返回则以 ProviderTimeoutError 拒绝并中断底层请求 */
export function withTimeout(provider: LLMProvider, timeoutMs?: number): LLMProvider {
  const ms = resolveTimeoutMs(timeoutMs);
  // <=0 = 显式关闭超时
  if (ms <= 0) return provider;

  return {
    async chat(req: ChatRequest): Promise<LLMResponse> {
      // 请求级信号 = 调用方取消 ∪ AbortSignal.timeout ∪ 显式 abort 定时器。
      // 显式定时器同时用于竞速拒绝：Bun 的 AbortSignal.timeout 定时器在事件循环
      // 空闲时可能不推进，只有 signal 而无本地 setTimeout 会一直挂起。
      const timeoutSignal = AbortSignal.timeout(ms);
      const controller = new AbortController();
      const signal = AbortSignal.any(
        req.signal
          ? [req.signal, timeoutSignal, controller.signal]
          : [timeoutSignal, controller.signal],
      );
      const timeoutError = new ProviderTimeoutError(ms);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(timeoutError);
          reject(timeoutError);
        }, ms);
      });

      const inner = provider.chat({ ...req, signal });
      // 超时先返回时，底层 promise 之后可能 reject——这里吞掉，避免 unhandled rejection
      inner.catch(() => {});

      try {
        return await Promise.race([inner, timeout]);
      } catch (error) {
        // AbortSignal.timeout 先于本地定时器触发时，把 DOMException 归一为可识别错误
        if (!req.signal?.aborted && timeoutSignal.aborted) {
          throw error instanceof ProviderTimeoutError ? error : new ProviderTimeoutError(ms);
        }
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
