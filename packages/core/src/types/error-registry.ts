/**
 * 统一错误 code 注册表（错误系统设计 §3.1 / D1，q-error-e1）。
 *
 * 三层码制的单一登记面：领域码（AgentError/TeamError/TimelineError/ModelRefError…）
 * → 冻结 RPC 码（A-3 §10.2，additive 追加）→ envelope error_code（事件/日志过滤面）。
 * 三大映射（error-envelope CODE_META / mapSessionControlError / mapExternalErrorCode）
 * 收敛为查本表；未注册码兜底必须标 `classified_by: 'registry-miss'`。
 *
 * 纪律：本模块是纯类型/常量模块（types/** 不依赖实现）；只 import 类型。
 * 治理：新码必须进注册表（评审 checklist 项）；既有码不改名（码是契约，
 * message 可改、码不破坏兼容）。
 *
 * @module @vessel-agent/core/types
 */

import type { ErrorCategory, ErrorPhase } from './error.js';

/**
 * 冻结 RPC 错误码**单源清单**（A-3 §10.2；q-error-e1 起唯一来源在此）。
 * serve `RpcErrorCode` 与根 `src/rpc/types.ts` 的白名单清单都从本常量派生，
 * 不允许手抄第二份（过去三处手抄曾漏 8 个已声明码，合法错误信封被客户端判成
 * `internal: invalid RPC response envelope`）。新增冻结码只改这一处。
 */
export const FROZEN_RPC_ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_params',
  'data_locked',
  'quota_exceeded',
  'conflict',
  'internal',
  // 0.12：注入的可选能力未提供（DECISION-023 §2.3，如未注入的 gateway.reload）。
  // q-error-e1 起「能力端口未注入」发射点统一用本码（not_found 拆义，D4）。
  'not_supported',
  // 0.13：交互请求已过期/已随 run 取消（DECISION-024 §2.2）。
  'expired',
  // 0.13 Addendum A：run 已结束 / 重启后找不到 run，权限请求失效。
  'run_ended',
  // 0.34 CONTRACT-0.34-context C7：sessions.compact。
  'session_not_found',
  'compact_unavailable',
  // 0.52 S1a：node 正在优雅退出（fence 已打开）。**可重试**：等 node 回来再发，
  // 客户端按「稍后重试」处理，不要当终态错误展示。
  'gateway_restarting',
  // 自重启 Option A（node.restart.self）：触发者会话此刻没有活跃 run /
  // run_id 与活跃 run 不符 / continuation 标记落盘失败。
  'no_active_run',
  'run_mismatch',
  'marker_failed',
  // q-restart-tool（gateway.restart）：预约段失败（无运行中 node / 无平台 gateway /
  // 编排者 spawn 失败等）；message 携 CLI selfRestartReserveCommand 同款原因。
  'restart_reserve_failed',
  // 0.54 B1（ADR-105 §6 / D4）：时间线订阅的两个稳定码。
  // - `legacy_session_unsupported`：**0.54 之前的旧格式会话**（只有 `events.ndjson`、
  //   没有 timeline 标记）。0.55 起「只读冻结」不再是中间态：这种目录读、写、迁移全不支持，
  //   读面必须报这个码（给空段 = 把「没人能解析」说成「没有事件」）。与 core 写者同名同义
  //   （`packages/core/src/timeline/types.ts`）。
  // - `timeline_unavailable`：装配层没开 timeline 读面（端口缺失）。与上一条分开：
  //   「服务端没开这个能力」不是「这个会话坏了」，混成一个码会误导排障。
  'legacy_session_unsupported',
  'timeline_unavailable',
  // q-error-e1（用户裁定①，2026-11-26）：未知 RPC 方法专用码（not_found 拆义，D4）。
  // 此前未知方法/资源不存在/能力未注入共用 not_found，客户端把 not_found 一律读成
  // 「旧 gateway 不支持」→ 静默回退/空结果（F3.2 误诊根因）。additive 追加先例同款
  // （0.34 session_not_found / 0.52 gateway_restarting / 0.54 legacy_session_unsupported）。
  // details.method 保留方法名。WS legacy 面同场景仍用 method_not_allowed（冻结协议不动）。
  'method_not_found',
] as const;

/** 冻结 RPC 错误码联合（从单源清单派生） */
export type FrozenRpcCode = (typeof FROZEN_RPC_ERROR_CODES)[number];

/** 错误所属领域（注册表治理维度；与过滤大类 ErrorCategory 正交） */
export type ErrorDomain =
  | 'agent'
  | 'model'
  | 'provider'
  | 'tool'
  | 'permission'
  | 'run'
  | 'session'
  | 'timeline'
  | 'gateway'
  | 'node'
  | 'config'
  | 'mcp'
  | 'pii';

/** 单个稳定码的元数据（设计 §3.1） */
export interface ErrorCodeMeta {
  /** 稳定码（snake_case；既有码不改名） */
  code: string;
  domain: ErrorDomain;
  /** 过滤大类（envelope/诊断面） */
  category: ErrorCategory;
  retryable: boolean;
  phase?: ErrorPhase;
  /** 领域码 → 冻结码的**唯一**映射口；冻结码登记自身；无映射 = 兜底 internal */
  rpcCode?: FrozenRpcCode;
  /** i18n 修复指引键（§3.9，E3 期覆盖；本期只留字段） */
  hintKey?: string;
  /** 引入批次（码稳定性审计用）；不可考的存量码标 'pre-E1' */
  since: string;
}

/** 构造辅助：code 从键派生，避免手抄两遍 */
function meta(
  domain: ErrorDomain,
  category: ErrorCategory,
  retryable: boolean,
  extra: { since: string } & Partial<Pick<ErrorCodeMeta, 'phase' | 'rpcCode' | 'hintKey'>>,
): Omit<ErrorCodeMeta, 'code'> {
  return { domain, category, retryable, ...extra };
}

/**
 * 注册表本体。登记口径：
 * - CODE_META 既有 14 码的 category/retryable/phase **逐字冻结**（涉 0.55 硬错误闸，绝不动）。
 * - 领域码按设计进 agent/model/storage/lifecycle 新类（裁定③）；rpcCode 只登记
 *   **既有映射**（mapSessionControlError / mapTeamError / mapExternalErrorCode 实查），
 *   无既有映射的码不臆造 rpcCode（兜底 internal）。
 * - envelope 分类码（provider_* / tool_* 等）元数据与现分类器输出逐字对齐。
 */
const ENTRIES: Readonly<Record<string, Omit<ErrorCodeMeta, 'code'>>> = {
  // ── 冻结 RPC 码（rpcCode = 自身；category=gateway，conflict 除外见下） ──
  unauthorized: meta('gateway', 'gateway', false, { rpcCode: 'unauthorized', since: '0.5' }),
  forbidden: meta('gateway', 'gateway', false, { rpcCode: 'forbidden', since: '0.5' }),
  not_found: meta('gateway', 'gateway', false, { rpcCode: 'not_found', since: '0.5' }),
  invalid_params: meta('gateway', 'gateway', false, { rpcCode: 'invalid_params', since: '0.5' }),
  data_locked: meta('gateway', 'gateway', false, { rpcCode: 'data_locked', since: '0.5' }),
  quota_exceeded: meta('gateway', 'gateway', false, { rpcCode: 'quota_exceeded', since: '0.5' }),
  // conflict 同时在 CODE_META（internal/input）：分类逐字冻结，rpcCode 登记冻结映射。
  conflict: meta('run', 'internal', false, { phase: 'input', rpcCode: 'conflict', since: '0.14' }),
  internal: meta('gateway', 'internal', false, { rpcCode: 'internal', since: '0.5' }),
  not_supported: meta('gateway', 'gateway', false, { rpcCode: 'not_supported', since: '0.12' }),
  expired: meta('gateway', 'gateway', false, { rpcCode: 'expired', since: '0.13' }),
  run_ended: meta('run', 'internal', false, { rpcCode: 'run_ended', since: '0.13' }),
  session_not_found: meta('session', 'storage', false, {
    rpcCode: 'session_not_found',
    since: '0.34',
  }),
  compact_unavailable: meta('session', 'storage', false, {
    rpcCode: 'compact_unavailable',
    since: '0.34',
  }),
  gateway_restarting: meta('node', 'lifecycle', true, {
    rpcCode: 'gateway_restarting',
    since: '0.52',
  }),
  no_active_run: meta('run', 'internal', false, { rpcCode: 'no_active_run', since: 'pre-E1' }),
  run_mismatch: meta('run', 'internal', false, { rpcCode: 'run_mismatch', since: 'pre-E1' }),
  marker_failed: meta('run', 'internal', false, { rpcCode: 'marker_failed', since: 'pre-E1' }),
  restart_reserve_failed: meta('node', 'lifecycle', false, {
    rpcCode: 'restart_reserve_failed',
    since: 'q-restart-tool',
  }),
  legacy_session_unsupported: meta('timeline', 'storage', false, {
    rpcCode: 'legacy_session_unsupported',
    since: '0.54',
  }),
  timeline_unavailable: meta('timeline', 'storage', false, {
    rpcCode: 'timeline_unavailable',
    since: '0.54',
  }),
  method_not_found: meta('gateway', 'gateway', false, {
    rpcCode: 'method_not_found',
    since: 'q-error-e1',
  }),

  // ── CODE_META 既有 14 码（error-envelope.ts:48-70 逐字冻结；conflict 见上） ──
  run_already_running: meta('run', 'internal', true, { phase: 'input', since: 'pre-E1' }),
  run_not_found: meta('run', 'internal', false, { phase: 'input', since: 'pre-E1' }),
  run_not_resumable: meta('run', 'internal', false, { phase: 'input', since: 'pre-E1' }),
  run_store_required: meta('run', 'internal', false, { phase: 'input', since: 'pre-E1' }),
  agent_not_found: meta('agent', 'internal', false, { phase: 'input', since: 'pre-E1' }),
  session_corrupt: meta('session', 'internal', false, { phase: 'input', since: 'pre-E1' }),
  atomic_write_failed: meta('session', 'internal', true, {
    phase: 'checkpoint',
    since: 'pre-E1',
  }),
  limit_blocked: meta('run', 'internal', false, { phase: 'run', since: 'pre-E1' }),
  // q-empty-exhaust：category=internal 而非 provider ⇒ 不触发 0.55 硬错误闸（逐字冻结）。
  empty_response_exhausted: meta('provider', 'internal', false, {
    phase: 'llm',
    since: 'q-empty-exhaust',
  }),
  pii_unknown_handle: meta('pii', 'tool', false, { phase: 'tool', since: '0.52' }),
  pii_expired_handle: meta('pii', 'tool', false, { phase: 'tool', since: '0.52' }),
  pii_invalidated_handle: meta('pii', 'tool', false, { phase: 'tool', since: '0.52' }),
  pii_reveal_denied: meta('pii', 'permission', false, { phase: 'permission', since: '0.52' }),

  // ── AgentErrorCode（packages/agent/src/types.ts；rpcCode 按 mapSessionControlError 实查） ──
  invalid_input: meta('agent', 'agent', false, { rpcCode: 'invalid_params', since: 'pre-E1' }),
  unknown_member: meta('agent', 'agent', false, { rpcCode: 'not_found', since: 'pre-E1' }),
  member_closed: meta('agent', 'agent', false, { rpcCode: 'conflict', since: 'pre-E1' }),
  member_stale: meta('agent', 'agent', false, { since: 'pre-E1' }),
  // not_visible 安全裁定②：wire 保持 not_found + details.reason，不泄漏存在性。
  member_not_visible: meta('agent', 'agent', false, { rpcCode: 'not_found', since: 'pre-E1' }),
  no_parent: meta('agent', 'agent', false, { since: 'pre-E1' }),
  spawn_failed: meta('agent', 'agent', false, { rpcCode: 'internal', since: 'pre-E1' }),
  team_full: meta('agent', 'agent', false, { rpcCode: 'conflict', since: 'pre-E1' }),
  team_frozen: meta('agent', 'agent', false, { rpcCode: 'conflict', since: 'pre-E1' }),
  invalid_state_transition: meta('agent', 'agent', false, { since: 'pre-E1' }),
  budget_exceeded: meta('agent', 'agent', false, { since: 'pre-E1' }),
  budget_unavailable: meta('agent', 'agent', false, { since: 'pre-E1' }),
  conversation_team_mismatch: meta('agent', 'agent', false, { since: 'pre-E1' }),
  body_limit: meta('agent', 'agent', false, { since: 'pre-E1' }),
  // node_draining → gateway_restarting 的既有映射在 src/run/run-control.ts（可重试）。
  node_draining: meta('agent', 'lifecycle', true, { rpcCode: 'gateway_restarting', since: '0.52' }),

  // ── q-error-e2（§3.5）：drain 证据指引码（node.drain.skipped 按 reason 登记）。
  //    只定证据不修行为（F1/SD-2 归 q-infra-hardening，已在 main）；无既有 RPC 映射
  //    不臆造 rpcCode；hintKey 就位，四段 i18n 全文属 E3。 ──
  node_drain_no_record: meta('node', 'lifecycle', false, {
    hintKey: 'error.hint.node_drain_no_record',
    since: 'q-error-e2',
  }),
  node_drain_unauthorized: meta('node', 'lifecycle', false, {
    hintKey: 'error.hint.node_drain_unauthorized',
    since: 'q-error-e2',
  }),
  node_drain_method_not_found: meta('node', 'lifecycle', false, {
    hintKey: 'error.hint.node_drain_method_not_found',
    since: 'q-error-e2',
  }),
  node_drain_network: meta('node', 'lifecycle', false, {
    hintKey: 'error.hint.node_drain_network',
    since: 'q-error-e2',
  }),
  node_drain_timeout: meta('node', 'lifecycle', false, {
    hintKey: 'error.hint.node_drain_timeout',
    since: 'q-error-e2',
  }),
  node_drain_quiesce_timeout: meta('node', 'lifecycle', false, {
    hintKey: 'error.hint.node_drain_quiesce_timeout',
    since: 'q-error-e2',
  }),

  // ── TeamErrorCode（rpcCode 按 mapTeamError 实查：default → invalid_params） ──
  team_not_found: meta('agent', 'agent', false, { rpcCode: 'not_found', since: 'pre-E1' }),
  team_conversation_not_found: meta('agent', 'agent', false, {
    rpcCode: 'not_found',
    since: 'pre-E1',
  }),
  team_log_write_failed: meta('agent', 'storage', false, { rpcCode: 'internal', since: 'pre-E1' }),
  team_binding_requires_name: meta('agent', 'agent', false, {
    rpcCode: 'invalid_params',
    since: 'pre-E1',
  }),
  team_already_in_team: meta('agent', 'agent', false, {
    rpcCode: 'invalid_params',
    since: 'pre-E1',
  }),
  team_not_member: meta('agent', 'agent', false, { rpcCode: 'invalid_params', since: 'pre-E1' }),
  team_private_member: meta('agent', 'agent', false, {
    rpcCode: 'invalid_params',
    since: 'pre-E1',
  }),
  team_no_team: meta('agent', 'agent', false, { rpcCode: 'invalid_params', since: 'pre-E1' }),
  team_self_mention: meta('agent', 'agent', false, { rpcCode: 'invalid_params', since: 'pre-E1' }),
  team_owner_not_rosterable: meta('agent', 'agent', false, {
    rpcCode: 'invalid_params',
    since: 'pre-E1',
  }),
  team_not_empty: meta('agent', 'agent', false, { rpcCode: 'conflict', since: 'pre-E1' }),
  team_archived: meta('agent', 'agent', false, { rpcCode: 'conflict', since: 'pre-E1' }),
  not_visible: meta('agent', 'agent', false, { rpcCode: 'invalid_params', since: 'pre-E1' }),
  message_not_found: meta('agent', 'agent', false, { rpcCode: 'not_found', since: '0.38' }),
  // mapTeamError 的 S1 游标码（不在 TeamErrorCode 联合里，duck-typed 到达）。
  cursor_out_of_window: meta('agent', 'agent', false, { rpcCode: 'conflict', since: 'pre-E1' }),

  // ── TimelineErrorCode（packages/core/src/timeline/types.ts） ──
  timeline_write_failed: meta('timeline', 'storage', false, { since: 'pre-E1' }),
  timeline_record_too_large: meta('timeline', 'storage', false, { since: 'pre-E1' }),
  timeline_event_type_excluded: meta('timeline', 'storage', false, { since: 'pre-E1' }),
  timeline_writer_closed: meta('timeline', 'storage', false, { since: 'pre-E1' }),
  timeline_index_invalid: meta('timeline', 'storage', false, { since: 'pre-E1' }),
  timeline_archive_failed: meta('timeline', 'storage', false, { since: 'pre-E1' }),

  // ── ModelRefError（packages/config/src/model-registry.ts） ──
  unknown_ref: meta('model', 'model', false, { since: 'pre-E1' }),

  // ── envelope 分类码（与 error-envelope.ts 分类器输出逐字对齐；phase 缺省 =
  //    defaultPhase(category)，保持 options.phase 覆盖语义不变） ──
  provider_auth: meta('provider', 'provider', false, { since: '0.14' }),
  provider_rate_limit: meta('provider', 'provider', true, { since: '0.14' }),
  provider_quota_exceeded: meta('provider', 'provider', false, { since: '0.14' }),
  provider_timeout: meta('provider', 'provider', true, { since: '0.14' }),
  provider_context_overflow: meta('provider', 'provider', false, { since: '0.14' }),
  provider_unavailable: meta('provider', 'provider', true, { since: '0.14' }),
  provider_http_error: meta('provider', 'provider', false, { since: '0.14' }),
  provider_network: meta('provider', 'provider', true, { since: '0.14' }),
  provider_error: meta('provider', 'provider', false, { since: '0.14' }),
  tool_timeout: meta('tool', 'tool', true, { since: '0.14' }),
  tool_not_found: meta('tool', 'tool', false, { since: '0.14' }),
  tool_invalid_arguments: meta('tool', 'tool', false, { since: '0.14' }),
  tool_blocked: meta('tool', 'tool', false, { since: '0.14' }),
  tool_error: meta('tool', 'tool', false, { since: '0.14' }),
  permission_timeout: meta('permission', 'permission', false, {
    phase: 'permission',
    since: '0.14',
  }),
  permission_cancelled: meta('permission', 'permission', false, {
    phase: 'permission',
    since: '0.14',
  }),
  permission_denied: meta('permission', 'permission', false, {
    phase: 'permission',
    since: '0.14',
  }),
  permission_error: meta('permission', 'permission', false, { since: '0.14' }),
  config_error: meta('config', 'config', false, { since: '0.14' }),
  gateway_error: meta('gateway', 'gateway', false, { since: '0.14' }),
  internal_error: meta('gateway', 'internal', false, { since: '0.14' }),
  checkpoint_failed: meta('run', 'internal', true, { phase: 'checkpoint', since: 'pre-E1' }),
};

/** 单一 code 注册表（键 = 稳定码；只读） */
export const ERROR_REGISTRY: Readonly<Record<string, ErrorCodeMeta>> = Object.freeze(
  Object.fromEntries(Object.entries(ENTRIES).map(([code, m]) => [code, { code, ...m }])),
);

/** 查表（纯函数）；未注册返回 undefined，调用方兜底必须标 classified_by:'registry-miss'。 */
export function lookupErrorCode(code: string): ErrorCodeMeta | undefined {
  return Object.hasOwn(ERROR_REGISTRY, code) ? ERROR_REGISTRY[code] : undefined;
}
