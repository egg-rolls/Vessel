/**
 * gateway 稳定错误码 → 面向用户的中文说明（DECISION-020 §R1）。
 *
 * 服务端错误文案是英文且可能很长；UI 统一通过本模块补一句可执行的提示，
 * 原始错误仍原样展示（可展开），不吞掉服务端细节。
 */

import { t } from '../i18n';

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  unauthorized: 'gateway.error.unauthorized',
  forbidden: 'gateway.error.forbidden',
  forbidden_origin: 'gateway.error.forbidden_origin',
  invalid_host: 'gateway.error.invalid_host',
  not_found: 'gateway.error.not_found',
  invalid_params: 'gateway.error.invalid_params',
  invalid_request: 'gateway.error.invalid_request',
  conflict: 'gateway.error.conflict',
  quota_exceeded: 'gateway.error.quota_exceeded',
  rate_limited: 'gateway.error.rate_limited',
  timeout: 'gateway.error.timeout',
  unsupported_protocol: 'gateway.error.unsupported_protocol',
  internal: 'gateway.error.internal',
  no_runtime: 'gateway.error.no_runtime',
  durable_disabled: 'gateway.error.durable_disabled',
  mcp_disabled: 'gateway.error.mcp_disabled',
  evals_disabled: 'gateway.error.evals_disabled',
};

/** 已知错误码的可执行说明；未知 code 返回 null（不编造文案）。 */
export function describeGatewayError(code: string | null | undefined): string | null {
  if (!code) return null;
  const key = DESCRIPTIONS[code];
  return key ? t(key) : null;
}

/** 从 `code: message` 文本里取稳定错误码前缀；没有则返回 null。 */
export function gatewayErrorCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = /^([a-z][a-z0-9_]*):/.exec(text.trim());
  return match?.[1] ?? null;
}

/** 从一段原始错误文本得到中文说明；未知/无 code 返回 null。 */
export function describeGatewayErrorText(text: string | null | undefined): string | null {
  return describeGatewayError(gatewayErrorCode(text));
}

/** 错误对象上的稳定 code：HTTP RPC 与 WS `res` 都可能携带。 */
function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function errorDetailsReasonOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return null;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : null;
}

function errorTextOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

export function isConflictError(error: unknown): boolean {
  if (errorCodeOf(error) === 'conflict') return true;
  return gatewayErrorCode(errorTextOf(error)) === 'conflict';
}

/**
 * `sessions.get.before` 锚点失效：历史前缀被改写（rewind / compaction）。
 * S1 的 WS `res` 不携带 details，因此同时按 message 文本兜底。
 */
export function isHistoryChangedError(error: unknown): boolean {
  if (!isConflictError(error)) return false;
  if (errorDetailsReasonOf(error) === 'history_changed') return true;
  return errorTextOf(error).toLowerCase().includes('history changed');
}

/**
 * `teams.get.before` 超出本地保留窗口（64 MiB 回扫上限）。
 * 客户端收到后停止翻页并给一次性提示，保留已加载内容。
 */
export function isCursorOutOfWindowError(error: unknown): boolean {
  if (!isConflictError(error)) return false;
  if (errorDetailsReasonOf(error) === 'cursor_out_of_window') return true;
  return errorTextOf(error).includes('cursor_out_of_window');
}
