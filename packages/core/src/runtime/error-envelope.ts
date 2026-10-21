/**
 * 结构化错误 envelope（0.14 P0，DECISION-025 §1.2）。
 *
 * 纯函数：只读取错误对象与调用方提示，不发布事件、不写文件。
 * 输出用于 `run.failed` / `tool.call.failed` 的 additive 字段；
 * 原 `error` 文本保持不变，调用方继续按原文展示。
 *
 * @module @vessel-agent/core/runtime
 */

import type {
  ErrorCategory,
  ErrorEnvelope,
  ErrorPhase,
  ToErrorEnvelopeOptions,
} from '../types/error.js';
import { RunAlreadyRunningError, RunResumeError } from '../types/run-store.js';
import { PermissionAbortedError, PermissionTimeoutError } from './permission-policy.js';

const PERMISSION_DENIED_PATTERNS: readonly RegExp[] = [
  /execution denied by permission policy/i,
  /execution denied by user/i,
];

const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context[_ ]length/i,
  /context window/i,
  /maximum context/i,
  /prompt is too long/i,
  /input is too long/i,
  /too many tokens/i,
  /token limit/i,
  /request too large/i,
];

const PROVIDER_NETWORK_PATTERN =
  /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|network/i;
const PROVIDER_TIMEOUT_PATTERN = /\btimed?\s*out\b|timeout/i;
const PROVIDER_UNAVAILABLE_PATTERN = /no response from|returned no stream body/i;

/** 通用 `code` 错误的分类/可重试性；未知 code 保持原值、默认不可重试。 */
const CODE_META: Readonly<
  Record<string, { category: ErrorCategory; retryable: boolean; phase?: ErrorPhase }>
> = {
  run_already_running: { category: 'internal', retryable: true, phase: 'input' },
  run_not_found: { category: 'internal', retryable: false, phase: 'input' },
  run_not_resumable: { category: 'internal', retryable: false, phase: 'input' },
  run_store_required: { category: 'internal', retryable: false, phase: 'input' },
  agent_not_found: { category: 'internal', retryable: false, phase: 'input' },
  session_corrupt: { category: 'internal', retryable: false, phase: 'input' },
  atomic_write_failed: { category: 'internal', retryable: true, phase: 'checkpoint' },
  invalid_tenant_id: { category: 'config', retryable: false, phase: 'input' },
  conflict: { category: 'internal', retryable: false, phase: 'input' },
  limit_blocked: { category: 'internal', retryable: false, phase: 'run' },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 错误对象自带的结构化细节（如 `LimitExceededError.details`） */
function readErrorDetails(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const details = (error as Record<string, unknown>).details;
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return undefined;
  return details as Record<string, unknown>;
}

function readHttpStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null) {
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
  }

  // 内置 provider 抛的是普通 Error（`OpenAI API error: 401 - ...`），从文本兜底读取。
  const match = /(?:api error|http(?: status)?|status(?: code)?)\s*[:=]?\s*(\d{3})\b/i.exec(
    errorMessage(error),
  );
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function matchesAny(message: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

function isProviderMessage(message: string): boolean {
  return (
    /api error\s*:\s*\d{3}/i.test(message) ||
    PROVIDER_NETWORK_PATTERN.test(message) ||
    PROVIDER_UNAVAILABLE_PATTERN.test(message) ||
    /no response from .*api/i.test(message)
  );
}

function isToolMessage(message: string): boolean {
  return (
    /^Tool "/.test(message) ||
    /^Invalid JSON in tool arguments/.test(message) ||
    /^Tool call blocked/.test(message) ||
    /^Tool result blocked/.test(message)
  );
}

function resolveCategory(
  message: string,
  options: ToErrorEnvelopeOptions,
  metadata: { category: ErrorCategory } | undefined,
): ErrorCategory {
  if (metadata) return metadata.category;
  if (options.category) return options.category;
  if (options.phase === 'llm') return 'provider';
  if (options.phase === 'tool') return 'tool';
  if (options.phase === 'permission') return 'permission';
  if (isProviderMessage(message)) return 'provider';
  if (isToolMessage(message)) return 'tool';
  return 'internal';
}

function defaultPhase(category: ErrorCategory): ErrorPhase {
  switch (category) {
    case 'provider':
      return 'llm';
    case 'tool':
      return 'tool';
    case 'permission':
      return 'permission';
    case 'config':
      return 'input';
    default:
      return 'run';
  }
}

interface Classification {
  error_code: string;
  category: ErrorCategory;
  retryable: boolean;
  http_status?: number;
  phase?: ErrorPhase;
}

function classifyProvider(message: string, status?: number): Classification {
  if (status === 401 || status === 403) {
    return {
      error_code: 'provider_auth',
      category: 'provider',
      retryable: false,
      http_status: status,
    };
  }
  if (status === 429) {
    return {
      error_code: 'provider_rate_limit',
      category: 'provider',
      retryable: true,
      http_status: status,
    };
  }
  if (status === 402) {
    return {
      error_code: 'provider_quota_exceeded',
      category: 'provider',
      retryable: false,
      http_status: status,
    };
  }
  if (status === 408) {
    return {
      error_code: 'provider_timeout',
      category: 'provider',
      retryable: true,
      http_status: status,
    };
  }
  if (status === 400 && matchesAny(message, CONTEXT_OVERFLOW_PATTERNS)) {
    return {
      error_code: 'provider_context_overflow',
      category: 'provider',
      retryable: false,
      http_status: status,
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      error_code: 'provider_unavailable',
      category: 'provider',
      retryable: true,
      http_status: status,
    };
  }
  if (status !== undefined) {
    return {
      error_code: 'provider_http_error',
      category: 'provider',
      retryable: false,
      http_status: status,
    };
  }
  if (PROVIDER_TIMEOUT_PATTERN.test(message)) {
    return { error_code: 'provider_timeout', category: 'provider', retryable: true };
  }
  if (PROVIDER_NETWORK_PATTERN.test(message)) {
    return { error_code: 'provider_network', category: 'provider', retryable: true };
  }
  if (PROVIDER_UNAVAILABLE_PATTERN.test(message)) {
    return { error_code: 'provider_unavailable', category: 'provider', retryable: true };
  }
  return { error_code: 'provider_error', category: 'provider', retryable: false };
}

function classifyTool(message: string): Classification {
  if (/timed?\s*out after \d+ms/i.test(message)) {
    return { error_code: 'tool_timeout', category: 'tool', retryable: true };
  }
  if (/not found/i.test(message)) {
    return { error_code: 'tool_not_found', category: 'tool', retryable: false };
  }
  if (/^Invalid JSON in tool arguments/.test(message)) {
    return { error_code: 'tool_invalid_arguments', category: 'tool', retryable: false };
  }
  if (/blocked by/i.test(message)) {
    return { error_code: 'tool_blocked', category: 'tool', retryable: false };
  }
  return { error_code: 'tool_error', category: 'tool', retryable: false };
}

/**
 * 把任意错误归一成结构化 envelope。
 *
 * @param error 原始错误（Error 或任意抛出值）
 * @param options 阶段 / 来源 / 补充细节提示
 */
export function toErrorEnvelope(
  error: unknown,
  options: ToErrorEnvelopeOptions = {},
): ErrorEnvelope {
  const message = errorMessage(error);
  const status = readHttpStatus(error);
  // 错误对象自带 details 时原样传递（如 LimitExceededError）；显式 options 优先。
  const details = options.details ?? readErrorDetails(error);

  // 1) 权限错误有稳定的类型语义，优先于调用方提示。
  if (error instanceof PermissionTimeoutError) {
    return withDetails(
      {
        error_code: 'permission_timeout',
        category: 'permission',
        phase: 'permission',
        retryable: false,
      },
      details,
    );
  }
  if (error instanceof PermissionAbortedError) {
    return withDetails(
      {
        error_code: 'permission_cancelled',
        category: 'permission',
        phase: 'permission',
        retryable: false,
      },
      details,
    );
  }

  // 2) durable run 的稳定错误码。
  if (error instanceof RunAlreadyRunningError) {
    return withDetails(
      {
        error_code: 'run_already_running',
        category: 'internal',
        phase: 'input',
        retryable: true,
      },
      details,
    );
  }
  if (error instanceof RunResumeError) {
    return withDetails(
      {
        error_code: error.code,
        category: 'internal',
        phase: 'input',
        retryable: false,
      },
      details,
    );
  }

  // 3) checkpoint 失败被 writeCheckpoint 包装成固定前缀。
  if (message.startsWith('run_checkpoint_failed')) {
    return withDetails(
      {
        error_code: 'checkpoint_failed',
        category: 'internal',
        phase: 'checkpoint',
        retryable: true,
      },
      details,
    );
  }

  // 4) 权限拒绝是普通 Error（由 PermissionPolicy 抛出）。
  if (matchesAny(message, PERMISSION_DENIED_PATTERNS)) {
    return withDetails(
      {
        error_code: 'permission_denied',
        category: 'permission',
        phase: 'permission',
        retryable: false,
      },
      details,
    );
  }

  // 5) 通用 `code`（ErrnoError / 领域错误）：只接受 snake_case，避免泄漏平台大小写码。
  const genericCode =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>).code
      : undefined;
  const metadata =
    typeof genericCode === 'string' && /^[a-z][a-z0-9_]*$/.test(genericCode)
      ? CODE_META[genericCode]
      : undefined;

  const category = resolveCategory(message, options, metadata);
  // 稳定 code 的 phase 优先于调用方提示（ToErrorEnvelopeOptions.phase 的覆盖语义）。
  const phase = metadata?.phase ?? options.phase ?? defaultPhase(category);

  if (metadata && typeof genericCode === 'string') {
    return withDetails(
      {
        error_code: genericCode,
        category: metadata.category,
        phase,
        retryable: metadata.retryable,
      },
      details,
    );
  }

  let classification: Classification;
  switch (category) {
    case 'provider':
      classification = classifyProvider(message, status);
      break;
    case 'tool':
      classification = classifyTool(message);
      break;
    case 'permission':
      classification = { error_code: 'permission_error', category: 'permission', retryable: false };
      break;
    case 'config':
      classification = { error_code: 'config_error', category: 'config', retryable: false };
      break;
    case 'gateway':
      classification = { error_code: 'gateway_error', category: 'gateway', retryable: false };
      break;
    default:
      if (typeof genericCode === 'string' && /^[a-z][a-z0-9_]*$/.test(genericCode)) {
        classification = {
          error_code: genericCode,
          category: 'internal',
          retryable: false,
        };
      } else {
        classification = { error_code: 'internal_error', category: 'internal', retryable: false };
      }
  }

  return withDetails(
    {
      error_code: classification.error_code,
      category: classification.category,
      phase: classification.phase ?? phase,
      retryable: classification.retryable,
      ...(classification.http_status !== undefined
        ? { http_status: classification.http_status }
        : {}),
    },
    details,
  );
}

/** 只附加非空 details；envelope 其余字段保持扁平。 */
function withDetails(
  envelope: ErrorEnvelope,
  details: Record<string, unknown> | undefined,
): ErrorEnvelope {
  if (details === undefined || Object.keys(details).length === 0) return envelope;
  return { ...envelope, details };
}
