/**
 * DeepSeek tools API 的共用调用层（搜索与抓取**共用**一份，避免两套重试/错误语义）。
 *
 * 设计口径（§2.5 / §5.3 / §6.1 / §6.3）：
 * - 缺 key ⇒ 本地判 `provider_auth_failed`，**一个字节都不发出去**；
 * - 只有 408 / 429 / 5xx / 网络层可重试，且**最多 2 次重试**（3 attempts）；
 * - 400/401/402/403/404/413 **一次都不重试**（余额不足还连打 3 次是最贵的错误）；
 * - `Retry-After` ≤5s 照做，>5s 直接放弃（让模型等 60s 不如直接告诉它 `retry_after_s`）；
 * - 整体一个 deadline（含所有重试与 body 读取），半开连接也受同一个 signal 约束；
 * - key 只在 `Authorization: Bearer` 头里，**永不进 URL**；上游文本进 message 前双擦除。
 */

import type { WebToolsConfig } from './config';
import {
  type KeyKind,
  missingKeyMessage,
  readKey,
  redactKey,
  sanitizeUpstreamText,
} from './secrets';
import { WebFetchError, type WebToolErrorCode } from './types';

/** 端点路径（⚠️ owner 口径：仓里没有第二处来源；实现以真实响应为准） */
export const DEEPSEEK_SEARCH_PATH = '/v1/tools/search';
export const DEEPSEEK_FETCH_PATH = '/v1/tools/fetch';

export interface DeepSeekDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
}

export interface DeepSeekCallOptions {
  config: WebToolsConfig;
  /** 这次调用该看哪个环境变量（search / fetch 可分开账户） */
  keyKind: KeyKind;
  path: string;
  body: unknown;
  signal?: AbortSignal;
  deps?: DeepSeekDeps;
  /** 退避毫秒（由 `CostController.backoffMs` 提供，带抖动） */
  backoff: (attempt: number, retryAfterMs?: number) => number;
  /** 400 的补充提示（搜索与抓取的错法不同） */
  badRequestHint?: string;
}

export interface DeepSeekCallResult {
  json: unknown;
  status: number;
  attempts: number;
  /** 最后一次尝试的上游耗时（毫秒） */
  upstreamMs: number;
  /** 整次调用（含重试）耗时（毫秒） */
  latencyMs: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

/** `Retry-After` 可能是秒数，也可能是 HTTP 日期；解析成毫秒 */
export function parseRetryAfterMs(raw: string | null, now: number): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - now);
}

function endpointFor(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 上游错误体里的原因（JSON 或纯文本），只用于拼 message，且必先擦除 */
function upstreamReason(text: string): string {
  const flat = text.trim();
  if (flat === '') return '(空响应体)';
  try {
    const parsed = JSON.parse(flat) as unknown;
    const reason = pickString(parsed, [['error', 'message'], ['message'], ['detail'], ['error']]);
    if (reason !== undefined) return reason;
  } catch {
    // 不是 JSON：原样截断
  }
  return flat;
}

/** 按路径取第一个非空字符串（`error.message` 这类嵌套也走这里） */
export function pickString(
  value: unknown,
  paths: readonly (readonly string[])[],
): string | undefined {
  for (const path of paths) {
    let cursor: unknown = value;
    for (const segment of path) {
      if (cursor === null || typeof cursor !== 'object') {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    if (typeof cursor === 'string' && cursor.trim() !== '') return cursor.trim();
  }
  return undefined;
}

interface StatusMapping {
  code: WebToolErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

/** HTTP 状态码 → 码 / 文案 / 能否重试（设计 §2.5(c) 的逐条表） */
function mapHttpStatus(
  status: number,
  bodyText: string,
  keyValue: string,
  retryAfterHeader: string | null,
  now: number,
  attempt: number,
  badRequestHint: string,
): StatusMapping {
  const reason = sanitizeUpstreamText(
    upstreamReason(bodyText === '' ? '' : redactKey(bodyText, keyValue)),
    keyValue,
  );
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader, now);

  if (status === 400) {
    return {
      code: 'provider_bad_request',
      message: `请求被服务端判为非法：${reason}；${badRequestHint}`,
      retryable: false,
    };
  }
  if (status === 401) {
    return {
      code: 'provider_auth_failed',
      message: '鉴权失败：key 无效或已撤销（检查环境变量名配置，不放 key 本身）',
      retryable: false,
    };
  }
  if (status === 402) {
    return {
      code: 'provider_quota_exhausted',
      message: '账户余额不足，服务端拒绝（需充值）。本次不降级到其它后端',
      retryable: false,
    };
  }
  if (status === 403) {
    return {
      code: 'provider_auth_failed',
      message: '无权访问该接口（key 权限或账户状态问题）',
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      code: 'endpoint_not_found',
      message: '接口路径不存在：检查 base_url/版本号配置',
      retryable: false,
    };
  }
  if (status >= 300 && status < 400) {
    // 本客户端不跟随重定向（`redirect: 'manual'`）：只可能是 base_url 配错（例如少了 /v1）
    return {
      code: 'endpoint_not_found',
      message: `上游返回重定向 ${status}：本客户端不跟随重定向，检查 base_url 配置`,
      retryable: false,
    };
  }
  if (status === 408) {
    return { code: 'timeout', message: '服务端抓取/检索超时', retryable: true };
  }
  if (status === 413) {
    return {
      code: 'too_large',
      message: '请求体过大：缩短 query 或降低 count',
      retryable: false,
    };
  }
  if (status === 429) {
    // >5s 直接放弃：让模型等一分钟不如把等待时间告诉它
    if (retryAfterMs !== undefined && retryAfterMs > 5_000) {
      return {
        code: 'provider_rate_limited',
        message: `限流：服务端要求 ${Math.round(retryAfterMs / 1000)}s 后重试（超过 5s，本次不再退避）`,
        retryable: false,
        retryAfterMs,
      };
    }
    return {
      code: 'provider_rate_limited',
      message: `限流：${retryAfterMs !== undefined ? `${Math.round(retryAfterMs / 1000)}s 后` : '稍后'}重试（已自动退避 ${attempt} 次）`,
      retryable: true,
      retryAfterMs,
    };
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return {
      code: 'provider_unavailable',
      message: `${status === 504 ? '网关超时' : '服务端错误'}（已重试 ${attempt} 次）`,
      retryable: true,
    };
  }
  if (status >= 500) {
    return {
      code: 'provider_unavailable',
      message: `服务端错误 ${status}（已重试 ${attempt} 次）`,
      retryable: true,
    };
  }
  return {
    code: 'provider_bad_request',
    message: `客户端错误 ${status}：${reason}`,
    retryable: false,
  };
}

interface NetworkMapping {
  code: WebToolErrorCode;
  message: string;
  retryable: boolean;
}

function mapNetworkError(error: unknown, timedOut: boolean, canceled: boolean): NetworkMapping {
  const name = (error as { name?: string } | null)?.name ?? '';
  const message = error instanceof Error ? error.message : String(error);
  if (canceled) {
    return {
      code: 'connect_failed',
      message: '调用被取消（本次没有完成计费调用）',
      retryable: false,
    };
  }
  if (timedOut || name === 'AbortError' || name === 'TimeoutError') {
    return { code: 'timeout', message: '上游调用超时（整体 deadline 到点）', retryable: true };
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i.test(message)) {
    return { code: 'dns_failed', message: `DNS 解析失败：${message}`, retryable: true };
  }
  if (/certificate|tls|ssl|self-signed/i.test(message)) {
    return { code: 'tls_error', message: `TLS 握手失败：${message}`, retryable: true };
  }
  return { code: 'connect_failed', message: `连接失败：${message}`, retryable: true };
}

/**
 * 调一次 tools API（含重试）。成功返回解析后的 JSON；失败抛 `WebFetchError`。
 *
 * 非预期异常（例如注入的 fetch 抛了奇怪的东西）一律映射成 `connect_failed`，
 * 由上层按「网络层失败」处理——不把内部栈暴露给模型。
 */
export async function callDeepSeekTool(options: DeepSeekCallOptions): Promise<DeepSeekCallResult> {
  const config = options.config;
  const deps = options.deps ?? {};
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;

  const key = readKey(config, options.keyKind, deps.env ?? process.env);
  if (!key.present) {
    // 缺 key：本地判，不发请求，不静默降级
    throw new WebFetchError('provider_auth_failed', missingKeyMessage(key.envName));
  }

  const endpoint = endpointFor(config.baseUrl, options.path);
  const startedAt = now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.apiTimeoutMs);
  const onOuterAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const maxAttempts = Math.max(0, config.retryMax) + 1;
  let lastError: WebFetchError | undefined;
  const badRequestHint = options.badRequestHint ?? '检查 query 里的特殊字符与 site/lang/after 格式';

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const attemptStarted = now();
      let mapping: StatusMapping | NetworkMapping;
      let retryAfterMs: number | undefined;
      try {
        const response = await doFetch(endpoint, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            authorization: `Bearer ${key.value}`,
            'content-type': 'application/json',
            accept: 'application/json',
            'user-agent': config.userAgent,
          },
          body: JSON.stringify(options.body),
          signal: controller.signal,
        });
        // body 读完之前不许清 timer：header 到了、body 挂住是最常见的「超时没生效」
        const text = await response.text();
        const upstreamMs = now() - attemptStarted;
        if (response.ok) {
          let json: unknown;
          try {
            json = text.trim() === '' ? {} : JSON.parse(text);
          } catch {
            throw new WebFetchError(
              'provider_bad_request',
              '上游返回的不是 JSON（响应形状变了，检查版本号/路径配置）',
            );
          }
          return {
            json,
            status: response.status,
            attempts: attempt + 1,
            upstreamMs,
            latencyMs: now() - startedAt,
          };
        }
        const mapped = mapHttpStatus(
          response.status,
          text,
          key.value,
          response.headers.get('retry-after'),
          now(),
          attempt,
          badRequestHint,
        );
        mapping = mapped;
        retryAfterMs = mapped.retryAfterMs;
      } catch (error) {
        if (error instanceof WebFetchError) throw error;
        mapping = mapNetworkError(error, timedOut, options.signal?.aborted === true);
      }

      const failure = new WebFetchError(mapping.code, mapping.message);
      if (!mapping.retryable || attempt === maxAttempts - 1) throw failure;
      const waitMs = options.backoff(attempt, retryAfterMs);
      if (now() - startedAt + waitMs >= config.apiTimeoutMs) {
        // 再等就超总 deadline：把最后一次失败如实抛出去，不假装还在重试
        throw failure;
      }
      lastError = failure;
      await sleep(waitMs);
    }
    throw lastError ?? new WebFetchError('timeout', '上游调用超时（整体 deadline 到点）');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}
