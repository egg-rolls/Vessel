/**
 * Provider 重试装饰器。
 *
 * 对 429 / 5xx / 网络错误做指数退避重试；调用方 abort 时立即停止。
 * 与 timeout 组合时放在内层：外层 timeout 是整个请求（含重试）的总时限。
 */

import type { ChatRequest, LLMProvider, LLMResponse } from '@vessel/core';

/** 默认重试次数（不含首次请求） */
export const DEFAULT_MAX_RETRIES = 3;
/** 默认首次退避 */
export const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
/** 默认单次退避上限 */
export const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
/** 默认抖动比例：实际延迟在 ±jitter 区间内随机 */
export const DEFAULT_RETRY_JITTER = 0.2;

export interface RetryOptions {
  /** 重试次数（不含首次）；<= 0 关闭重试 */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 抖动比例，0 = 无抖动；建议 <= 0.5 */
  jitter?: number;
  /** 测试注入点：默认 setTimeout */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** 从配置读取有限数字 */
export function readRetryNumber(config: Record<string, unknown>, key: string): number | undefined {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 合并配置与默认值；maxRetries <= 0 表示关闭 */
export function resolveRetryOptions(config: Record<string, unknown>): RetryOptions {
  return {
    maxRetries: readRetryNumber(config, 'max_retries') ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: readRetryNumber(config, 'retry_base_delay_ms') ?? DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelayMs: readRetryNumber(config, 'retry_max_delay_ms') ?? DEFAULT_RETRY_MAX_DELAY_MS,
    jitter: readRetryNumber(config, 'retry_jitter') ?? DEFAULT_RETRY_JITTER,
  };
}

/** 从错误消息提取 HTTP 状态码（core provider 抛 `... API error: 429 - body`） */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.status === 'number') return record.status;
  if (typeof record.statusCode === 'number') return record.statusCode;
  if (error instanceof Error) {
    const match = /(?:API error|status(?: code)?)\D{0,12}(\d{3})\b/i.exec(error.message);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return undefined;
}

/** 瞬时可重试错误：429 / 5xx / 网络类；abort 与 4xx 不重试 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false;
  const status = statusOf(error);
  if (status !== undefined) return status === 429 || (status >= 500 && status <= 599);
  if (!(error instanceof Error)) return false;
  return /fetch failed|network error|socket hang up|connection (?:reset|closed)|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE/i.test(
    error.message,
  );
}

/** 取 abort 原因（保留调用方自定义 Error） */
function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' && reason !== '' ? reason : 'request aborted');
  error.name = 'AbortError';
  return error;
}

/** 可中断 sleep：abort 时清掉定时器并拒绝 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(abortError(signal as AbortSignal));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 计算第 attempt 次重试（0 基）的等待时间 */
function delayFor(
  attempt: number,
  options: Required<Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'jitter'>>,
): number {
  const exponential = Math.min(options.baseDelayMs * 2 ** attempt, Math.max(0, options.maxDelayMs));
  const jitter = Math.min(Math.max(options.jitter, 0), 1);
  const factor = 1 + (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(exponential * factor));
}

/** 包装 provider：可重试错误按指数退避重试，abort 立即停止 */
export function withRetry(provider: LLMProvider, options: RetryOptions = {}): LLMProvider {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (maxRetries <= 0) return provider;

  const timing = {
    baseDelayMs: options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
    jitter: options.jitter ?? DEFAULT_RETRY_JITTER,
  };
  const sleep = options.sleep ?? abortableSleep;

  return {
    async chat(req: ChatRequest): Promise<LLMResponse> {
      let attempt = 0;
      // 流式已输出内容后不再重试，否则会重复发给 UI/模型
      let emitted = false;
      const request: ChatRequest = req.on_chunk
        ? {
            ...req,
            on_chunk: (chunk) => {
              emitted = true;
              req.on_chunk?.(chunk);
            },
          }
        : req;

      for (;;) {
        if (req.signal?.aborted) throw abortError(req.signal);
        try {
          return await provider.chat(request);
        } catch (error) {
          if (req.signal?.aborted) throw abortError(req.signal);
          if (emitted) throw error;
          if (attempt >= maxRetries || !isRetryableError(error)) throw error;
          await sleep(delayFor(attempt, timing), req.signal);
          attempt += 1;
        }
      }
    },
  };
}
