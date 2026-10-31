/**
 * `runs.*` 控制面端口（0.27 统一 agent / body 模型）。
 *
 * serve 不再持有执行队列、runtime 入口或 core run → job 的映射：
 * - live 运行态只读 scheduler snapshot（queued + running）；
 * - `runs.start` / `runs.cancel` 由 app 侧适配器转成 `AgentService.admit` /
 *   `scheduler.cancel(runId)`；
 * - durable 读 / 恢复仍走 `DurableGatewayOptions`（每 body runStore）。
 *
 * 结构类型：app 侧把 AgentService / scheduler 适配成此接口注入；
 * serve 不依赖 `@vessel-agent/agent`（分包方向不可倒置）。
 *
 * @module @vessel-agent/serve
 */

/** run 状态（与 core `RunStatus` / `RunSnapshot.state` 同值）。 */
export type RunControlStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** scheduler snapshot 中的单条 live run（`agent_id` / `session_id` 都是统一口径）。 */
export interface LiveRunSnapshotLike {
  run_id: string;
  /** agent 持久身份 id（不再借用 core run id）。 */
  agent_id: string;
  /** body / session id（`body_id ≡ session_id`）。 */
  session_id: string;
  status: RunControlStatus;
  /** FIFO 队列位置（1 起；仅 queued 时有）。 */
  queue_position?: number;
  /** 等待原因（仅 queued 时有；值域同 core WaitReason）。 */
  wait_reason?: string;
  queued_at?: number;
  started_at?: number;
}

/** scheduler 计数（与 core `SchedulerStats` 同值）。 */
export interface RunControlStatsLike {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

/** 单个 tenant 的 live scheduler 快照。 */
export interface RunControlSnapshotLike {
  as_of: number;
  queued: LiveRunSnapshotLike[];
  running: LiveRunSnapshotLike[];
  stats?: RunControlStatsLike;
}

/** `runs.start` 的统一入口参数（D4：session 先解析 agent/body）。 */
export interface RunStartLikeInput {
  input: string;
  /** 缺省 = `main`（或已绑定 session 的 agent）。 */
  agent_id?: string;
  /** 已绑定 body；未绑定则归 `agent_id` 并惰性创建 body。 */
  session_id?: string;
}

/** `runs.start` 的受理结果。 */
export interface RunStartLikeResult {
  run_id: string;
  status: RunControlStatus;
  queue_position?: number;
}

/** 注入的 per-tenant run 控制面。 */
export interface RunControlLike {
  readonly tenantId: string;
  /** 统一入口：app 侧必须转成同一个 `AgentService.admit`。 */
  start(input: RunStartLikeInput): Promise<RunStartLikeResult>;
  /** `scheduler.cancel(runId)`；未知 / 已终态返回 false。 */
  cancel(runId: string, reason?: string): boolean | Promise<boolean>;
  /** 该 tenant 的 live scheduler 快照；可序列化、无副作用。 */
  snapshot(): RunControlSnapshotLike;
}
