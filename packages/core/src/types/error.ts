/**
 * 结构化错误 envelope（0.14 P0，DECISION-025 §1.2）。
 *
 * 事件里的 `error` 仍是人读文本；本类型只描述可分级、可过滤的附加字段。
 * 不携带 prompt / reasoning / 完整工具结果。
 *
 * @module @vessel-agent/core/types
 */

/** 错误来源大类 */
export type ErrorCategory = 'provider' | 'tool' | 'permission' | 'config' | 'gateway' | 'internal';

/** 错误发生的执行阶段 */
export type ErrorPhase =
  | 'input'
  | 'llm'
  | 'tool'
  | 'permission'
  | 'finalize'
  | 'checkpoint'
  | 'shutdown'
  | 'run';

/**
 * 结构化错误 envelope（additive）。
 *
 * `run.failed` / `tool.call.failed` 在保留原 `error` 文本的同时展开这些字段。
 */
export interface ErrorEnvelope {
  /** 稳定错误码（snake_case），如 `permission_timeout` / `provider_rate_limit` */
  error_code: string;
  category: ErrorCategory;
  phase: ErrorPhase;
  retryable: boolean;
  /** provider HTTP 状态码（能从错误对象或消息中识别时） */
  http_status?: number;
  /** 调用方补充的非敏感细节（不得包含 prompt / reasoning） */
  details?: Record<string, unknown>;
}

/** `toErrorEnvelope` 的可选提示；调用方比错误对象更清楚阶段/来源时可覆盖推断 */
export interface ToErrorEnvelopeOptions {
  /** 当前执行阶段；错误类型有更强语义时（如权限错误）会被覆盖 */
  phase?: ErrorPhase;
  /** 来源大类提示（如 gateway 装配层）；缺省按错误与阶段推断 */
  category?: ErrorCategory;
  /** 非敏感补充信息 */
  details?: Record<string, unknown>;
}
