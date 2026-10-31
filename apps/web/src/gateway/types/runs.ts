import type { Message } from './sessions';

/** Run 事件（type 为开放字符串协议） */
export interface RunEvent {
  type: string;
  run_id: string;
  data: Record<string, unknown>;
  ts: number;
  /**
   * trace 落盘时分配的 per-run 序号（`events.list` 会返回）。
   * 实时 WS 事件通常没有该字段；分页时只能依赖 trace 事件。
   */
  seq?: number;
  /** 0.6：事件来源节点（events.list 会返回；实时流可能缺省）。 */
  node_id?: string;
}

/** LLM 流式 chunk（对应 core 的 StreamChunk） */
export interface StreamChunk {
  /** `reasoning_delta` 仅在 `ui.showReasoning: true` 时由 core 发出（0.11.1，additive）。 */
  type: 'text_delta' | 'reasoning_delta' | 'tool_call_delta' | 'finish';
  delta?: string;
  tool_call_index?: number;
  tool_call_id?: string;
  tool_call_name?: string;
  arguments_delta?: string;
  finish_reason?: string;
  usage?: Usage;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  total_cost?: number;
}

/** LLM 工具 Schema（对应 `llm.request.data.tools`） */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** 运行状态（/v1/runs/:id、run.get；durable checkpoint 是其中的超集） */
export interface RunStatus {
  run_id: string;
  /**
   * 0.26 及更早：gateway 引擎 id → core run id（trace 事件用 core run id）。
   * 0.27 统一 run id 后服务端不再返回；读侧保留 `core_run_id ?? run_id` 兼容旧 gateway。
   */
  core_run_id?: string;
  session_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  output?: string;
  error?: string;
  usage?: Usage;
  started_at?: number;
  completed_at?: number;
  queue_position?: number;
  /** 0.14 / 0.15 E6：run.failed 结构化 envelope（additive）。 */
  error_code?: string;
  category?: string;
  phase?: string;
  retryable?: boolean;
  http_status?: number;
  details?: Record<string, unknown>;
  /** 0.27：live/durable 都带执行该 run 的 agent（body = `session_id`）。 */
  agent_id?: string;
  iteration?: number;
  updated_at?: number;
  preview?: string;
  messages?: Message[];
}

/**
 * `runs.start` 受理结果（0.27 additive）。
 *
 * 服务端解析 session → agent/body 后回填 `agent_id` / `session_id`（body id）；
 * 未传 `session_id` 时它就是 main primary body。旧 gateway 不返回，读侧按可选处理。
 */
export interface RunStartResult {
  run_id: string;
  status: RunStatus['status'];
  queue_position?: number;
  agent_id?: string;
  session_id?: string;
}

/** health.get 的 runtime.scheduler 条目（0.15 E6）。 */
export interface SchedulerRunSummary {
  run_id: string;
  agent_id?: string;
  session_id?: string;
  status: string;
  queue_position?: number;
  queued_at?: number;
  started_at?: number;
  wait_reason?: string;
}

export interface RuntimeHealth {
  active_run_id?: string;
  scheduler: {
    as_of: number;
    queued: SchedulerRunSummary[];
    running: SchedulerRunSummary[];
    stats: {
      queued: number;
      running: number;
      completed: number;
      failed: number;
      cancelled: number;
    };
  };
}

/** durable run 摘要（GET /v1/durable/runs） */
export interface DurableRunSummary {
  run_id: string;
  session_id: string;
  agent_id?: string;
  status: 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
  iteration?: number;
  updated_at: number;
  preview?: string;
}

export interface DurableRunsResponse {
  runs: DurableRunSummary[];
}

/** 进程内聚合快照（GET /v1/metrics） */
export interface MetricsSnapshot {
  runs: { started: number; completed: number; failed: number; cancelled: number };
  tool_calls: { total: number; failed: number };
  llm: {
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /**
     * 缓存读取 token 累计（CONTRACT-0.29 §3）。
     *
     * `undefined` = 该批事件没有任何缓存数据（provider 不支持缓存）。
     * 面板必须显示「不可用」，**不能**当成 0% 命中率。
     */
    cache_read_tokens?: number;
    /** 缓存写入 token 累计；`undefined` 语义同上 */
    cache_creation_tokens?: number;
  };
  duration_ms: { total: number; max: number; avg: number };
  updated_at: number;
}

export interface MetricsResponse {
  metrics: MetricsSnapshot;
}

export interface RunsResponse {
  runs: RunStatus[];
}

export interface RunResponse {
  run: RunStatus;
}

export interface ResumeRunResponse {
  run_id: string;
  status: 'queued';
}

export interface EventsResponse {
  events: RunEvent[];
}
