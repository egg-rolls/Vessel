/**
 * Durable run 契约（0.3 C1）
 *
 * `RunStore` 是 run 级检查点的 port；与 `SessionBackend`（会话级历史）并列，
 * 互不依赖。接口放在 types/ 是为了满足依赖方向 D4（kernel 只能依赖 port 类型）。
 *
 * @module @vessel-agent/core/session
 */

import type { ErrorEnvelope } from './error.js';
import type { Message } from './provider.js';

/** 一次 run 的持久化检查点 */
export interface RunCheckpoint {
  run_id: string;
  session_id: string;
  agent_id?: string;
  status: 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
  /**
   * 0.18：不再写完整对话历史（唯一真相源是会话事件日志）。
   * 新 checkpoint 写 `[]`；旧文件仍可能有 messages，读取侧按 legacy 回退。
   */
  messages: Message[];
  /** 0.18：checkpoint 覆盖到的会话事件 seq（唯一真相源游标） */
  event_cursor?: number;
  /** 0.18：失败终态的结构化错误 envelope（与 run.failed 一致） */
  error_envelope?: ErrorEnvelope;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    total_cost?: number;
    /** CONTRACT-0.29 §3：缓存读计数（`prompt_tokens` 的子集；缺省=provider 未上报） */
    cache_read_input_tokens?: number;
    /** CONTRACT-0.29 §3：缓存写计数（`prompt_tokens` 的子集；缺省=provider 未上报） */
    cache_creation_input_tokens?: number;
  };
  /** 已发出的 LLM 请求数；resume 后继续累加 */
  iteration?: number;
  created_at: number;
  updated_at: number;
  error?: string;
  metadata?: Record<string, unknown>;
  /** 0.5：所属 tenant；缺省视为 `default` */
  tenant_id?: string;
}

/** 检查点存储 port */
export interface RunStore {
  save(checkpoint: RunCheckpoint): Promise<void>;
  load(runId: string): Promise<RunCheckpoint | null>;
  list(opts?: {
    status?: RunCheckpoint['status'];
    session_id?: string;
    limit?: number;
    /** 跳过排序后的前 N 条（缺省 0）；与 limit 一起用于全量分页 */
    offset?: number;
  }): Promise<RunCheckpoint[]>;
  delete(runId: string): Promise<void>;
  close?(): Promise<void>;
}

/** resume 的稳定错误码（DECISION-008 Addendum A-1 / B） */
export type RunResumeCode =
  | 'run_not_found'
  | 'run_not_resumable'
  | 'run_already_running'
  | 'run_store_required'
  | 'agent_not_found';

/**
 * resume 失败时抛出的稳定错误。
 * gateway 直接按 `code` 映射协议错误；`runId` 供调用方关联。
 */
export class RunResumeError extends Error {
  readonly code: RunResumeCode;
  readonly runId: string;

  constructor(code: RunResumeCode, runId: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RunResumeError';
    this.code = code;
    this.runId = runId;
  }
}

/**
 * 同一 `AgentRuntime` 已有 active run（0.8 C1）。
 *
 * 继承 `RunResumeError` 以保持既有 `instanceof` 与 `code` 消费方兼容；
 * `message` 固定为 `run_already_running`，调用方按 `code` 分支即可。
 */
export class RunAlreadyRunningError extends RunResumeError {
  constructor(runId: string) {
    super('run_already_running', runId);
    this.name = 'RunAlreadyRunningError';
  }
}

/**
 * @internal 非用户取消的 reason。
 * AgentRuntime 据此把 checkpoint 写成 `interrupted`（可恢复），
 * 其他取消 reason 一律写 `cancelled`。
 *
 * 0.10 R2-18：`AgentRuntime.interrupt('shutdown' | 'timeout')` 使用同名字符串；
 * `interrupt('user')` 不在集合内 → cancelled。
 */
export const RUN_INTERRUPT_REASONS: ReadonlySet<string> = new Set([
  'agent closed',
  'scheduler closed',
  'shutdown',
  'timeout',
]);
