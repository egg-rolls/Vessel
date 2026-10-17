/**
 * Provider 请求超时装饰器。
 *
 * Provider 插件在工厂里包一层：合并调用方 signal 与超时 signal，
 * 超时后 abort 底层请求并以明确错误拒绝。默认 120s，可通过插件配置关闭（<=0）。
 */

import type { ChatRequest, LLMProvider, LLMResponse } from '@vessel/core';

/** 默认超时（毫秒） */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** 包装 provider：超过 timeoutMs 仍未返回则拒绝对应 promise 并中断底层请求 */
export function withTimeout(provider: LLMProvider, timeoutMs?: number): LLMProvider {
  const ms = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 非有限值或非正数 = 不设超时（显式关闭）
  if (!Number.isFinite(ms) || ms <= 0) return provider;

  return {
    async chat(req: ChatRequest): Promise<LLMResponse> {
      const controller = new AbortController();
      const forwardAbort = (): void => {
        controller.abort(req.signal?.reason);
      };

      if (req.signal?.aborted) {
        forwardAbort();
      } else {
        req.signal?.addEventListener('abort', forwardAbort, { once: true });
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`LLM request timed out after ${ms}ms`);
          // 通知底层 fetch 放弃请求；部分兼容实现会因此提前结束
          controller.abort(error);
          reject(error);
        }, ms);
      });

      const inner = provider.chat({ ...req, signal: controller.signal });
      // 超时先返回时，底层 promise 之后可能 reject——这里吞掉，避免 unhandled rejection
      inner.catch(() => {});

      try {
        return await Promise.race([inner, timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        req.signal?.removeEventListener('abort', forwardAbort);
      }
    },
  };
}
