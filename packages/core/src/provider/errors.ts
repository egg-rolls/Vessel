/**
 * Provider HTTP 错误（结构化：status / body / retryAfterMs）
 * @module @vessel-agent/core/provider
 */

/** 解析 `retry-after`：秒数或 HTTP date；非法 / 负值返回 undefined。 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (value.length === 0) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(value)) {
    return Math.round(Number(value) * 1000);
  }

  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

/**
 * message 保持既有 `OpenAI API error: <status> - <body>` 文本，避免破坏日志与分类。
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly retryAfterMs?: number;

  constructor(
    provider: 'OpenAI' | 'Anthropic',
    status: number,
    body: string,
    retryAfterMs?: number,
  ) {
    super(`${provider} API error: ${status} - ${body}`);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.body = body;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}
