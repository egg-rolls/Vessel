/**
 * Durable run 契约（0.3 C1）
 *
 * `RunRecordStore` 是 run 级记录（每 run 一条增量 checkpoint）的 port；
 * 与 `SessionStore`（会话壳：元数据 + 消息投影）并列，互不依赖。
 * 接口放在 types/ 是为了满足依赖方向 D4（kernel 只能依赖 port 类型）。
 *
 * @module @vessel-agent/core/run-record-store
 */

import type { ErrorEnvelope } from './error.js';
import type { Message } from './provider.js';

/** Run 状态 */
export type RunStatus = 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';

/** 一次 run 的 usage 快照 */
export interface RunUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  total_cost?: number;
  /** CONTRACT-0.29 §3：缓存读计数（`prompt_tokens` 的子集；缺省=provider 未上报） */
  cache_read_input_tokens?: number;
  /** CONTRACT-0.29 §3：缓存写计数（`prompt_tokens` 的子集；缺省=provider 未上报） */
  cache_creation_input_tokens?: number;
}

/**
 * 一次 run 的持久记录。
 *
 * 正常写者只有 Run；resume 所需的进度（status/usage/iteration/event_cursor）
 * 都收敛在这里。`legacy_messages` 是只读兼容字段（旧 checkpoint 的
 * `messages`），新写者不写历史（磁盘仍镜像 `messages: []` 以兼容旧 reader）。
 */
export interface RunRecord {
  run_id: string;
  session_id: string;
  agent_id?: string;
  status: RunStatus;
  usage?: RunUsage;
  /** 已发出的 LLM 请求数；resume 后继续累加 */
  iteration?: number;
  error?: string;
  /** 失败终态的结构化错误 envelope（与 run.failed 一致） */
  error_envelope?: ErrorEnvelope;
  /** 指向 SessionEventLog 的 seq（唯一真相源游标） */
  event_cursor?: number;
  created_at: number;
  updated_at: number;
  /** 0.5：所属 tenant；缺省视为 `default` */
  tenant_id?: string;
  /** 本次 run 的 git branch */
  branch?: string;
  metadata?: Record<string, unknown>;
  /** @internal one-release read-only legacy compatibility (old `messages`). */
  legacy_messages?: Message[];
}

/** Run 记录存储 port */
export interface RunRecordStore {
  save(record: RunRecord): Promise<void>;
  load(runId: string): Promise<RunRecord | null>;
  list(opts?: {
    status?: RunStatus;
    session_id?: string;
    limit?: number;
    /** 跳过排序后的前 N 条（缺省 0）；与 limit 一起用于全量分页 */
    offset?: number;
  }): Promise<RunRecord[]>;
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
 * 同一 `ExecutionUnit` 已有 active run（0.8 C1）。
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
 * ExecutionUnit 据此把 RunRecord 写成 `interrupted`（可恢复），
 * 其他取消 reason 一律写 `cancelled`。
 *
 * 0.10 R2-18：`ExecutionUnit.interrupt('shutdown' | 'timeout')` 使用同名字符串；
 * `interrupt('user')` 不在集合内 → cancelled。
 */
export const RUN_INTERRUPT_REASONS: ReadonlySet<string> = new Set([
  'agent closed',
  'scheduler closed',
  'shutdown',
  'timeout',
]);
