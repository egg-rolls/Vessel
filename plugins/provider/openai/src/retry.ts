/**
 * Provider 重试装饰器。
 *
 * 对 429 / 5xx / 网络错误做指数退避重试；429 优先按错误上的 retry-after 退避；
 * 402（额度耗尽）不重试；调用方 abort 时立即停止。
 * 与 timeout 组合时放在内层：外层 timeout 是整个请求（含重试）的总时限。
 */

import {
  type ChatRequest,
  createStderrLogger,
  type LLMProvider,
  type LLMResponse,
} from '@vessel-agent/core';

/** 默认重试次数（不含首次请求） */
export const DEFAULT_MAX_RETRIES = 3;
/** 默认首次退避 */
export const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
/** 默认单次退避上限 */
export const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
/** 默认抖动比例：实际延迟在 ±jitter 区间内随机 */
export const DEFAULT_RETRY_JITTER = 0.2;

/** 一次重试的可观测记录；不含错误正文 / 请求体，避免泄漏凭据 */
export interface RetryEvent {
  /** 即将进行的第 N 次重试（1 基，不含首次请求） */
  attempt: number;
  maxRetries: number;
  delayMs: number;
  /** 触发重试的 HTTP 状态码（能从错误中解析时） */
  status?: number;
  /** 错误类型名（不记录 message） */
  errorName: string;
  /** provider 名（如 openai / anthropic） */
  provider?: string;
}

export interface RetryOptions {
  /** 重试次数（不含首次）；<= 0 关闭重试 */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 抖动比例，0 = 无抖动；建议 <= 0.5 */
  jitter?: number;
  /** 测试注入点：默认 setTimeout */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 重试观测回调；缺省写结构化 stderr。抛错会被吞掉 */
  onRetry?: (event: RetryEvent) => void;
  /** 日志/回调里的 provider 标识 */
  provider?: string;
}

const retryLogger = createStderrLogger();

/** 记录一次重试；观测失败不得改变重试语义 */
function recordRetry(options: RetryOptions, event: RetryEvent): void {
  try {
    if (options.onRetry) {
      options.onRetry(event);
      return;
    }
    retryLogger.warn('provider retry', {
      attempt: event.attempt,
      max_retries: event.maxRetries,
      delay_ms: event.delayMs,
      ...(event.status !== undefined ? { status: event.status } : {}),
      error_name: event.errorName,
      ...(event.provider !== undefined ? { provider: event.provider } : {}),
    });
  } catch {
    // 日志 sink / 回调故障不得影响重试
  }
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

/** 读有限数字字段（结构化错误可能是第三方 Error，字段按 unknown 处理） */
function finiteField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Headers 实例或普通对象里的头值；取不到返回 undefined */
function headerValue(headers: unknown, name: string): unknown {
  if (typeof headers !== 'object' || headers === null) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): unknown }).get(name);
  }
  const record = headers as Record<string, unknown>;
  return record[name] ?? record[name.toLowerCase()];
}

/** retry-after 头转毫秒：裸数字按 HTTP 标准的秒，带 ms 后缀按毫秒 */
function retryAfterHeaderMs(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value * 1000 : undefined;
  if (typeof value !== 'string') return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s)?\s*$/i.exec(value);
  if (match?.[1] === undefined) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  return match[2]?.toLowerCase() === 'ms' ? amount : amount * 1000;
}

/**
 * 从错误对象读取服务端建议的退避时间（毫秒）。
 * 顺序：retryAfterMs / retry_after_ms（毫秒）→ retryAfter / retry_after（秒）→ retry-after 头。
 */
function retryAfterMsOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const direct = finiteField(record.retryAfterMs) ?? finiteField(record.retry_after_ms);
  if (direct !== undefined) return Math.max(0, direct);
  const seconds = finiteField(record.retryAfter) ?? finiteField(record.retry_after);
  if (seconds !== undefined) return Math.max(0, seconds * 1000);
  return retryAfterHeaderMs(headerValue(record.headers, 'retry-after'));
}

/** 瞬时可重试错误：429 / 5xx / 网络类；abort、402 与其它 4xx 不重试 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false;
  const status = statusOf(error);
  if (status !== undefined) {
    // 402 是额度耗尽，重试只会再消耗一次配额
    if (status === 402) return false;
    return status === 429 || (status >= 500 && status <= 599);
  }
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

/** 429 优先按 retry-after 退避（不加抖动），仍不超过 maxDelayMs */
function retryAfterDelay(
  error: unknown,
  status: number | undefined,
  maxDelayMs: number,
): number | undefined {
  if (status !== 429) return undefined;
  const retryAfterMs = retryAfterMsOf(error);
  if (retryAfterMs === undefined) return undefined;
  return Math.min(Math.round(retryAfterMs), Math.max(0, maxDelayMs));
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
          const status = statusOf(error);
          const delayMs =
            retryAfterDelay(error, status, timing.maxDelayMs) ?? delayFor(attempt, timing);
          recordRetry(options, {
            attempt: attempt + 1,
            maxRetries,
            delayMs,
            ...(status !== undefined ? { status } : {}),
            errorName: error instanceof Error ? error.name : typeof error,
            ...(options.provider !== undefined ? { provider: options.provider } : {}),
          });
          await sleep(delayMs, req.signal);
          attempt += 1;
        }
      }
    },
  };
}
