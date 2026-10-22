/**
 * 错误分类器
 *
 * 将 run() 抛出的错误分类（取消 / 权限 / 超时 / 网络 / API / 限额 / 鉴权 / 其他）。
 * 纯函数，可单测。
 */

import { t } from './i18n/index.js';

export type ErrorCategory =
  | 'cancelled'
  | 'permission'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'quota'
  | 'api'
  // 0.3：durable / MCP 稳定错误码（DECISION-008 §4.4 + Addendum A §1 + Addendum B §9.2）
  | 'not_found'
  | 'not_resumable'
  | 'conflict'
  | 'disabled'
  | 'invalid'
  | 'unknown';

/** 跨层稳定的错误 code（core RunResumeError / MCP 控制面约定） */
const STABLE_ERROR_CODES = [
  'run_not_found',
  'run_not_resumable',
  'run_already_running',
  'run_store_required',
  'agent_not_found',
  'durable_disabled',
  'mcp_disabled',
  'mcp_server_not_found',
  'mcp_server_disabled',
  // 0.4：feishu 稳定错误码（DECISION-009 §5.3.4）
  'channel_disabled',
  'channel_not_connected',
  'channel_auth_failed',
  // 0.5：RPC 冻结错误码（DECISION-010 §2.3）。放在长码之后，避免子串抢先匹配。
  'unauthorized',
  'forbidden',
  'invalid_params',
  'tenant_locked',
  'quota_exceeded',
  'conflict',
  'internal',
  'not_found',
] as const;

type StableErrorCode = (typeof STABLE_ERROR_CODES)[number];

/** 0.5 RPC 错误码中过短/易误判的两个，只从 Error.code 识别 */
const CODE_ONLY_RPC_CODES = new Set<StableErrorCode>(['conflict', 'internal']);

/** 先读 Error.code，再回退到 message；两者都可能来自不同装配层 */
function readStableCode(error: unknown, lowerMessage: string): StableErrorCode | undefined {
  const rawCode =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof rawCode === 'string') {
    const matched = STABLE_ERROR_CODES.find((code) => rawCode.includes(code));
    if (matched) return matched;
  }
  return STABLE_ERROR_CODES.find(
    (code) => !CODE_ONLY_RPC_CODES.has(code) && lowerMessage.includes(code),
  );
}

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  hint?: string;
}

/**
 * 把 run() 抛出的错误分类。纯函数，可单测。
 *
 * 顺序很重要：
 * - 先判 timeout——`The operation was aborted due to timeout` 同时含 abort，不能被当成取消；
 * - 再判权限拒绝、取消；
 * - 其余沿用原有网络 / 限额 / 鉴权 / API 规则。
 */
export function classifyError(error: unknown): ClassifiedError {
  const msg = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  const lower = msg.toLowerCase();

  // 0.3 稳定错误码优先：它们是跨层协议，不能被 message 里的泛化词误判
  const stableCode = readStableCode(error, lower);
  if (stableCode) {
    switch (stableCode) {
      case 'run_not_found':
      case 'agent_not_found':
      case 'mcp_server_not_found':
        return {
          category: 'not_found',
          message: msg,
          hint: t('error.hint.notFound'),
        };
      case 'run_not_resumable':
        return {
          category: 'not_resumable',
          message: msg,
          hint: t('error.hint.notResumable'),
        };
      case 'run_already_running':
        return {
          category: 'conflict',
          message: msg,
          hint: t('error.hint.alreadyRunning'),
        };
      case 'run_store_required':
      case 'durable_disabled':
        return {
          category: 'disabled',
          message: msg,
          hint: t('error.hint.durableDisabled'),
        };
      case 'mcp_disabled':
      case 'mcp_server_disabled':
        return {
          category: 'disabled',
          message: msg,
          hint: t('error.hint.mcpDisabled'),
        };
      case 'channel_disabled':
        return {
          category: 'disabled',
          message: msg,
          hint: t('error.hint.channelDisabled'),
        };
      case 'channel_not_connected':
        return {
          category: 'network',
          message: msg,
          hint: t('error.hint.channelNotConnected'),
        };
      case 'channel_auth_failed':
        return {
          category: 'auth',
          message: msg,
          hint: t('error.hint.channelAuthFailed'),
        };
      // 0.5：RPC 冻结错误码
      case 'unauthorized':
        return {
          category: 'auth',
          message: msg,
          hint: t('error.hint.unauthorized'),
        };
      case 'forbidden':
        return {
          category: 'permission',
          message: msg,
          hint: t('error.hint.forbidden'),
        };
      case 'invalid_params':
        return {
          category: 'invalid',
          message: msg,
          hint: t('error.hint.invalidParams'),
        };
      case 'not_found':
        return {
          category: 'not_found',
          message: msg,
          hint: t('error.hint.genericNotFound'),
        };
      case 'tenant_locked':
        return {
          category: 'conflict',
          message: msg,
          hint: t('error.hint.tenantLocked'),
        };
      case 'quota_exceeded':
        return {
          category: 'quota',
          message: msg,
          hint: t('error.hint.quotaExceeded'),
        };
      case 'conflict':
        return {
          category: 'conflict',
          message: msg,
          hint: t('error.hint.conflict'),
        };
      case 'internal':
        return {
          category: 'api',
          message: msg,
          hint: t('error.hint.internal'),
        };
    }
  }

  // 超时（含 AbortSignal.timeout 的 TimeoutError）
  if (
    name === 'TimeoutError' ||
    /timed out|timeout|etimedout|connect_timeout|deadline exceeded/.test(lower)
  ) {
    return { category: 'timeout', message: msg, hint: t('error.hint.timeout') };
  }

  // 权限拒绝（用户或策略）
  if (/denied by (user|permission policy)|execution denied|permission denied/.test(lower)) {
    return {
      category: 'permission',
      message: msg,
      hint: t('error.hint.permissionDenied'),
    };
  }

  // 取消（Esc / Ctrl+C / AbortError）
  if (name === 'AbortError' || /abort|cancel/.test(lower)) {
    return { category: 'cancelled', message: msg };
  }

  if (/usage limits exceeded|termination policy|max iterations|max_runtime/.test(lower)) {
    return {
      category: 'quota',
      message: msg,
      hint: t('error.hint.limits'),
    };
  }
  if (/429|rate limit|rate_limit|quota/.test(lower)) {
    return { category: 'quota', message: msg, hint: t('error.hint.rateLimit') };
  }
  if (/401|unauthorized|invalid api key|invalid_api_key|authentication/.test(lower)) {
    return { category: 'auth', message: msg, hint: t('error.hint.auth') };
  }
  if (
    /fetch failed|econnrefused|econnreset|enotfound|etimedout|connect_timeout|network|socket hang up|dns/.test(
      lower,
    )
  ) {
    return { category: 'network', message: msg, hint: t('error.hint.network') };
  }
  if (/api error|http \d{3}|bad request|400|403|404|500|502|503/.test(lower)) {
    return { category: 'api', message: msg, hint: t('error.hint.api') };
  }
  return { category: 'unknown', message: msg };
}

/**
 * 格式化为单条可读文本（TTY / simple mode 共用）。
 * 取消不是错误，显示为一条状态；其余带分类标签与 hint。
 */
export function formatClassifiedError(classified: ClassifiedError): string {
  if (classified.category === 'cancelled') return t('common.cancelled');
  const head = `✗ [${classified.category}] ${classified.message}`;
  return classified.hint ? `${head}\n  ${classified.hint}` : head;
}
