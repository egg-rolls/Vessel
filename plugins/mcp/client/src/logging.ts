/**
 * MCP client 诊断告警。
 *
 * 统一写 stderr 结构化 JSON（core Logger，自带 redaction），不污染 stdout。
 * transport 层拿不到 EventStream，因此只走 stderr；连接 / 插件层在 stderr 之外
 * 还会发布 `mcp.warning` 事件。
 */

import { createDefaultTraceRedactor, createStderrLogger } from '@vessel/core';

const logger = createStderrLogger();
const redactor = createDefaultTraceRedactor();

/** URL 内嵌凭据（user:pass@）与常见 token 查询参数 */
const URL_CREDENTIALS = /(\bhttps?:\/\/)[^\s/@]+@/gi;
const URL_TOKEN_QUERY =
  /([?&](?:token|api[_-]?key|key|secret|access[_-]?token|password)=)[^&\s]+/gi;

/**
 * 日志/事件文本脱敏：错误正文可能带回显的配置 URL，先去掉其中的凭据，
 * 再走 core redactor 的高置信度规则（sk- / Bearer / JWT / AWS）。
 */
export function sanitizeLogText(value: string): string {
  const cleaned = value.replace(URL_CREDENTIALS, '$1***@').replace(URL_TOKEN_QUERY, '$1***');
  const redacted = redactor.redact({
    type: 'log',
    run_id: '-',
    data: { value: cleaned },
    ts: 0,
  });
  const result = (redacted.data as Record<string, unknown>).value;
  return typeof result === 'string' ? result : cleaned;
}

/**
 * 写一条 MCP 告警。
 *
 * 只传诊断元信息（server / method / capability 等）；不要传 headers、env、
 * 完整 URL 或响应正文。错误文本会先去掉 URL 内嵌凭据，再交给 core logger。
 */
export function warnMcp(
  server: string,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const safeFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    safeFields[key] = typeof value === 'string' ? sanitizeLogText(value) : value;
  }
  logger.warn(sanitizeLogText(message), { server: sanitizeLogText(server), ...safeFields });
}
