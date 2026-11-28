/**
 * 结构化错误 envelope（0.14 P0，DECISION-025 §1.2）。
 *
 * 事件里的 `error` 仍是人读文本；本类型只描述可分级、可过滤的附加字段。
 * 不携带 prompt / reasoning / 完整工具结果。
 *
 * @module @vessel-agent/core/types
 */

/** 错误来源大类（q-error-e1 裁定③：additive 扩展 agent/model/storage/lifecycle；旧消费者按未知类别兜底 internal 展示） */
export type ErrorCategory =
  | 'provider'
  | 'tool'
  | 'permission'
  | 'config'
  | 'gateway'
  | 'internal'
  | 'agent'
  | 'model'
  | 'storage'
  | 'lifecycle';

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
  /**
   * 分类依据（q-error-e1，D2 边界保真铁律，additive）：
   * - 'type'：instanceof 判型；'registry'：注册表命中；
   * - 'registry-miss'：snake_case 码未注册（可观测漂移信号）；
   * - 'message'：文本/状态兜底（把「猜」变成显式可观测事实）。
   */
  classified_by?: 'type' | 'registry' | 'registry-miss' | 'message';
}

/**
 * 结构化错误协议（q-error-e1，设计 §3.2 / D2，additive）。
 *
 * 不强制单一基类：各包错误类（AgentError/ModelRefError/RpcError/TimelineError…）
 * 逐步满足本形状；跨层边界转换必须先读这些结构化字段，读不到才允许文本兜底
 * 且产物必须标 `classified_by: 'message'`。
 * errorId/at 字段本期只定义不生产（出生点 stamped 属 E2，§3.3）。
 */
export interface VesselErrorShape {
  /** 稳定领域码（snake_case） */
  code: string;
  category?: ErrorCategory;
  retryable?: boolean;
  /** 本层「我在做什么」（人读短语） */
  operation?: string;
  /** 非敏感结构化上下文（脱敏红线同 envelope） */
  details?: Record<string, unknown>;
  /** 原生 Error.cause（ES2022） */
  cause?: unknown;
  /** 出生点 stamped 短 id（E2） */
  errorId?: string;
  /** 构造点 file:line（E2） */
  at?: string;
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
