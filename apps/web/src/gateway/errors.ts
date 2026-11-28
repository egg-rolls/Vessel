/**
 * gateway 稳定错误码 → 面向用户的中文说明（DECISION-020 §R1）。
 *
 * 服务端错误文案是英文且可能很长；UI 统一通过本模块补一句可执行的提示，
 * 原始错误仍原样展示（可展开），不吞掉服务端细节。
 *
 * q-error-e3（§3.9）：冻结 RPC 码 + 可达领域码升级为四段指引
 * （`error.hint.<code>`，多行单键值，既有 .run-error-hint pre-line 渲染）；
 * 传输层码保留既有 `gateway.error.*` 一行说明。未知 code 仍返回 null（不编造）。
 */

import { t } from '../i18n';

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  // ── 冻结 RPC 码（四段指引） ──
  unauthorized: 'error.hint.unauthorized',
  forbidden: 'error.hint.forbidden',
  not_found: 'error.hint.not_found',
  invalid_params: 'error.hint.invalid_params',
  data_locked: 'error.hint.data_locked',
  quota_exceeded: 'error.hint.quota_exceeded',
  conflict: 'error.hint.conflict',
  internal: 'error.hint.internal',
  not_supported: 'error.hint.not_supported',
  expired: 'error.hint.expired',
  run_ended: 'error.hint.run_ended',
  session_not_found: 'error.hint.session_not_found',
  compact_unavailable: 'error.hint.compact_unavailable',
  gateway_restarting: 'error.hint.gateway_restarting',
  no_active_run: 'error.hint.no_active_run',
  run_mismatch: 'error.hint.run_mismatch',
  marker_failed: 'error.hint.marker_failed',
  restart_reserve_failed: 'error.hint.restart_reserve_failed',
  legacy_session_unsupported: 'error.hint.legacy_session_unsupported',
  timeline_unavailable: 'error.hint.timeline_unavailable',
  method_not_found: 'error.hint.method_not_found',
  // ── 可达领域码（message 前缀 / details.domain_code；四段指引） ──
  run_already_running: 'error.hint.run_already_running',
  run_not_found: 'error.hint.run_not_found',
  run_not_resumable: 'error.hint.run_not_resumable',
  run_store_required: 'error.hint.run_store_required',
  agent_not_found: 'error.hint.agent_not_found',
  session_corrupt: 'error.hint.session_corrupt',
  atomic_write_failed: 'error.hint.atomic_write_failed',
  limit_blocked: 'error.hint.limit_blocked',
  empty_response_exhausted: 'error.hint.empty_response_exhausted',
  invalid_input: 'error.hint.invalid_input',
  unknown_member: 'error.hint.unknown_member',
  member_closed: 'error.hint.member_closed',
  member_stale: 'error.hint.member_stale',
  member_not_visible: 'error.hint.member_not_visible',
  no_parent: 'error.hint.no_parent',
  spawn_failed: 'error.hint.spawn_failed',
  team_full: 'error.hint.team_full',
  team_frozen: 'error.hint.team_frozen',
  invalid_state_transition: 'error.hint.invalid_state_transition',
  budget_exceeded: 'error.hint.budget_exceeded',
  budget_unavailable: 'error.hint.budget_unavailable',
  conversation_team_mismatch: 'error.hint.conversation_team_mismatch',
  body_limit: 'error.hint.body_limit',
  node_draining: 'error.hint.node_draining',
  team_not_found: 'error.hint.team_not_found',
  team_conversation_not_found: 'error.hint.team_conversation_not_found',
  team_log_write_failed: 'error.hint.team_log_write_failed',
  team_binding_requires_name: 'error.hint.team_binding_requires_name',
  team_already_in_team: 'error.hint.team_already_in_team',
  team_not_member: 'error.hint.team_not_member',
  team_private_member: 'error.hint.team_private_member',
  team_no_team: 'error.hint.team_no_team',
  team_self_mention: 'error.hint.team_self_mention',
  team_owner_not_rosterable: 'error.hint.team_owner_not_rosterable',
  team_not_empty: 'error.hint.team_not_empty',
  team_archived: 'error.hint.team_archived',
  not_visible: 'error.hint.not_visible',
  message_not_found: 'error.hint.message_not_found',
  cursor_out_of_window: 'error.hint.cursor_out_of_window',
  unknown_ref: 'error.hint.unknown_ref',
  pii_unknown_handle: 'error.hint.pii_unknown_handle',
  pii_expired_handle: 'error.hint.pii_expired_handle',
  pii_invalidated_handle: 'error.hint.pii_invalidated_handle',
  pii_reveal_denied: 'error.hint.pii_reveal_denied',
  provider_auth: 'error.hint.provider_auth',
  provider_rate_limit: 'error.hint.provider_rate_limit',
  provider_quota_exceeded: 'error.hint.provider_quota_exceeded',
  provider_timeout: 'error.hint.provider_timeout',
  provider_context_overflow: 'error.hint.provider_context_overflow',
  provider_unavailable: 'error.hint.provider_unavailable',
  provider_http_error: 'error.hint.provider_http_error',
  provider_network: 'error.hint.provider_network',
  provider_error: 'error.hint.provider_error',
  tool_timeout: 'error.hint.tool_timeout',
  tool_not_found: 'error.hint.tool_not_found',
  tool_invalid_arguments: 'error.hint.tool_invalid_arguments',
  tool_blocked: 'error.hint.tool_blocked',
  tool_error: 'error.hint.tool_error',
  permission_timeout: 'error.hint.permission_timeout',
  permission_cancelled: 'error.hint.permission_cancelled',
  permission_denied: 'error.hint.permission_denied',
  permission_error: 'error.hint.permission_error',
  config_error: 'error.hint.config_error',
  gateway_error: 'error.hint.gateway_error',
  internal_error: 'error.hint.internal_error',
  checkpoint_failed: 'error.hint.checkpoint_failed',
  // ── 传输层 / gateway 本地码（既有一行说明，行为不变） ──
  forbidden_origin: 'gateway.error.forbidden_origin',
  invalid_host: 'gateway.error.invalid_host',
  invalid_request: 'gateway.error.invalid_request',
  rate_limited: 'gateway.error.rate_limited',
  timeout: 'gateway.error.timeout',
  unsupported_protocol: 'gateway.error.unsupported_protocol',
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
