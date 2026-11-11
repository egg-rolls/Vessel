/**
 * Provider 传输层重试（指数退避 + 抖动）
 *
 * 纯函数模块：只判定「这个错误能不能重发同一请求」与「退避多久」；
 * 计数、发事件、真正等待都在 `ExecutionUnit.chatWithOverflowRetry` 里。
 *
 * 判定范围刻意收窄（其余一律不重试）：
 * - 传输层：socket 被对端关掉 / ECONNRESET / ETIMEDOUT / `fetch failed` /
 *   undici 的 headers / body timeout；
 * - 过载：HTTP 429 / 502 / 503 / 504，有 `Retry-After` 就优先用它（封顶）。
 * 鉴权 / 参数 / 上下文超长 / 内容审查（4xx 里除 429）不重试——重试只会重复烧钱。
 *
 * 与 `error-envelope.ts` 的 `retryable` 是两套口径：那里是给人看的分类建议，
 * 这里决定是否真的自动重发；只认本文件列出的类别，缺省不重试。
 *
 * @module @vessel-agent/core/runtime
 */

import { parseRetryAfterMs } from '../provider/index.js';
import type { ProviderRetryPolicy } from '../types/provider.js';

/**
 * 默认重试策略：base 500ms、x2、最多 4 次重试、单次封顶 8s、±50% 抖动。
 *
 * 4 次重试的退避序列约 500 / 1000 / 2000 / 4000ms（含抖动），最坏累计 ~15s：
 * 够熬过热点切换的一次断网，又不会让用户对着空屏等太久。
 * 装配层覆写走 `TenantRuntimeProfile.retry` / `ExecutionUnitOptions.retry`（暂无 YAML 键）。
 */
export const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
  maxRetries: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  jitterRatio: 0.5,
};

/** 重试范围：传输层断开 / 过载 */
export type ProviderRetryScope = 'transport' | 'overload';

/** 一次失败的重试判定结果 */
export interface ProviderRetryDecision {
  /** 是否允许自动重发同一请求 */
  retryable: boolean;
  /** 命中类别；`retryable: false` 时缺省 */
  scope?: ProviderRetryScope;
  /** 稳定错误码（`llm.retry.error_code`；与 error-envelope 的 `provider_*` 同口径） */
  error_code?: string;
  /** provider 给出的 `Retry-After`（毫秒；仅在可重试且 provider 明确给出时存在） */
  retry_after_ms?: number;
}

/** 传输层失败的错误文本特征（大小写不敏感；结构化 status 缺省时才看文本） */
const TRANSPORT_PATTERNS: readonly RegExp[] = [
  /socket connection was closed unexpectedly/i,
  /other side closed/i,
  /socket hang up/i,
  /fetch failed/i,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /headers timeout/i,
  /body timeout/i,
  /UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)/,
];

/** 可重试的 HTTP 状态码：只有一个过载集合（500 / 501 等不在内） */
const RETRYABLE_STATUS: Readonly<Record<number, string>> = {
  429: 'provider_rate_limit',
  502: 'provider_unavailable',
  503: 'provider_unavailable',
  504: 'provider_unavailable',
};

/** 错误文本（含 cause 链一层：fetch 把真实原因挂在 `cause` 上） */
function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message} ${cause.message}` : error.message;
}

/** 从错误对象读取 HTTP 状态码（status / statusCode / httpStatus / response.status） */
function readHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ['status', 'statusCode', 'httpStatus']) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  }
  const response = record.response;
  if (typeof response === 'object' && response !== null) {
    const status = (response as Record<string, unknown>).status;
    if (typeof status === 'number' && Number.isFinite(status)) return Math.floor(status);
  }
  return undefined;
}

/** 文本兜底读状态码（内置 provider 抛的是普通 Error：`OpenAI API error: 401 - ...`） */
function readTextStatus(message: string): number | undefined {
  const match = /(?:api error|http(?: status)?|status(?: code)?)\s*[:=]?\s*(\d{3})\b/i.exec(
    message,
  );
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** provider 显式给出的 `Retry-After`（`ProviderHttpError.retryAfterMs` 或响应头） */
function readRetryAfterMs(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;

  const direct = record.retryAfterMs;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) return direct;

  const response = record.response;
  if (typeof response !== 'object' || response === null) return undefined;
  const headers = (response as Record<string, unknown>).headers;
  if (typeof headers !== 'object' || headers === null) return undefined;
  const maybeGet = (headers as { get?: (name: string) => string | null }).get;
  if (typeof maybeGet === 'function') {
    return parseRetryAfterMs(maybeGet.call(headers, 'retry-after'));
  }
  const raw = (headers as Record<string, unknown>)['retry-after'];
  return typeof raw === 'string' ? parseRetryAfterMs(raw) : undefined;
}

/** 取消 / 中断永远优先：AbortError 一律不重试 */
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as Record<string, unknown>).name === 'AbortError';
}

/** 分类一次 provider 失败：只有传输层断开与过载可重试。 */
export function classifyProviderRetry(error: unknown): ProviderRetryDecision {
  if (isAbortError(error)) return { retryable: false };

  const message = errorMessage(error);
  // 结构化状态码优先；内置 provider 的普通 Error 只能从文本兜底读。
  const status = readHttpStatus(error) ?? readTextStatus(message);
  if (status !== undefined) {
    const code = RETRYABLE_STATUS[status];
    if (code === undefined) return { retryable: false };
    const retryAfterMs = readRetryAfterMs(error);
    return {
      retryable: true,
      scope: 'overload',
      error_code: code,
      ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
    };
  }

  if (!TRANSPORT_PATTERNS.some((pattern) => pattern.test(message))) return { retryable: false };
  return { retryable: true, scope: 'transport', error_code: 'provider_network' };
}

/** 归一化策略：缺字段取默认值，非有限数 / 负数取默认或下限。 */
export function normalizeRetryPolicy(policy?: Partial<ProviderRetryPolicy>): ProviderRetryPolicy {
  const pick = (value: number | undefined, fallback: number, min: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(min, value) : fallback;
  const baseDelayMs = pick(policy?.baseDelayMs, DEFAULT_PROVIDER_RETRY_POLICY.baseDelayMs, 0);
  const maxDelayMs = Math.max(
    baseDelayMs,
    pick(policy?.maxDelayMs, DEFAULT_PROVIDER_RETRY_POLICY.maxDelayMs, 0),
  );
  return {
    maxRetries: Math.floor(pick(policy?.maxRetries, DEFAULT_PROVIDER_RETRY_POLICY.maxRetries, 0)),
    baseDelayMs,
    maxDelayMs,
    jitterRatio: Math.min(
      1,
      pick(policy?.jitterRatio, DEFAULT_PROVIDER_RETRY_POLICY.jitterRatio, 0),
    ),
  };
}

/**
 * 第 `retry` 次重试（1 起）前等待多久。
 *
 * - `Retry-After` 优先，并被 `maxDelayMs` 封顶（服务端说 60s 也不让用户干等）；
 * - 否则 `baseDelayMs * 2^(retry-1)`，再叠 ±`jitterRatio` 抖动，仍受封顶约束。
 */
export function retryBackoffMs(
  retry: number,
  policy: ProviderRetryPolicy,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.round(Math.min(retryAfterMs, policy.maxDelayMs));
  }
  const exponent = Math.max(0, retry - 1);
  const base = Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
  const jitter = 1 + policy.jitterRatio * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(Math.min(base * jitter, policy.maxDelayMs)));
}

/** 中断错误：沿用 loop 的既有文案口径（`AbortSignal.reason` 原样透传）。 */
export function abortErrorFrom(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' && reason.length > 0 ? reason : 'Run cancelled');
}

/**
 * 退避等待，可被 `AbortSignal` 立即打断（用户取消 / rotate / shutdown）。
 * 中断时抛出 `abortErrorFrom(signal)`；run 终态由 signal 决定，这里不改任何 run 状态。
 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortErrorFrom(signal));
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(abortErrorFrom(signal as AbortSignal));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
