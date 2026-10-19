/**
 * REPL 上下文契约——egg-rolls（壳）与 emma（REPL）的接缝
 * @module @vessel/tui
 *
 * 使用方式：
 *   // cli.ts（egg-rolls 壳）
 *   import { startRepl, type ReplContext } from '@vessel/tui';
 *   const ctx: ReplContext = { ... };
 *   await startRepl(ctx);
 *
 * ReplContext 类型由 emma 定义，egg-rolls 认可。本文件是 draft proposal。
 */

import type { VesselConfig } from '@vessel/config';
import type {
  ContextManager,
  EventStream,
  PluginHost,
  RunnableAgent,
  SessionBackend,
} from '@vessel/core';

// ── 0.3 T1：注入控制面（tui 定义结构，asm 实现；tui 不 import 任何实现） ──

/** MCP server 展示态（与 gateway /v1/mcp/servers 同形状，Addendum B §9.1） */
export interface McpServerSummary {
  name: string;
  status: 'connected' | 'failed' | 'disabled';
  /** 注册到 PluginHost 的完整工具名 */
  tools: string[];
  error?: string;
}

/** MCP 控制面（asm 注入；未配置 mcp_servers 时不注入） */
export interface McpControl {
  list(): Promise<McpServerSummary[]>;
  /** 重连单个 server；未知 name 抛 Error & { code: 'mcp_server_not_found' } */
  reconnect(name: string): Promise<McpServerSummary>;
  /** 权限弹窗用：完整工具名 -> 来源 server + 原始工具名；非 MCP/无法判定返回 null */
  toolSource(toolName: string): { server: string; tool: string } | null;
}

/** 单条 durable run（asm 注入；`updated_at` 倒序、同值 `run_id` 升序由数据层保证） */
export interface DurableRunSummary {
  run_id: string;
  session_id: string;
  agent_id?: string;
  status: 'running' | 'interrupted';
  updated_at: number;
  iteration?: number;
  preview?: string;
}

/** 恢复后的 run 结局（约定 `done` 不 reject） */
export type DurableRunOutcome =
  | { status: 'completed'; message?: string }
  | { status: 'failed'; error: unknown }
  | { status: 'cancelled' };

/** `/runs resume` 返回的句柄；REPL 层据此接管运行态与取消 */
export interface DurableRunHandle {
  runId: string;
  sessionId: string;
  /** 恰好 resolve 一次；失败走 status:'failed'，不 reject */
  done: Promise<DurableRunOutcome>;
  /** 幂等；映射到 core RunHandle.cancel() */
  cancel(): void;
}

/** durable run 控制面（asm 注入；durable 未启用或不支持恢复时不注入） */
export interface DurableRunsControl {
  list(opts?: {
    status?: 'running' | 'interrupted';
    session_id?: string;
    limit?: number;
  }): Promise<DurableRunSummary[]>;
  /**
   * 返回时 run 已启动。稳定 code：
   * run_not_found / run_not_resumable / run_already_running / durable_disabled
   */
  resume(runId: string): Promise<DurableRunHandle>;
}

// ── 0.4 T2：workflow 控制面（tui 定义结构，asm 适配并注入；引擎契约见 DECISION-009 §5.1.4） ──

export type WorkflowRunStatusLike =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type WorkflowStepStatusLike =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface WorkflowRunSummaryLike {
  workflow_run_id: string;
  workflow_name: string;
  status: WorkflowRunStatusLike;
  step_count: number;
  completed_steps: number;
  started_at: number;
  updated_at: number;
  error?: string;
}

export interface WorkflowStepSummaryLike {
  id: string;
  type: 'agent' | 'tool';
  status: WorkflowStepStatusLike;
  attempts: number;
  started_at?: number;
  finished_at?: number;
  error?: string;
  /** 引擎已截断到 200 字符 */
  output_preview?: string;
}

export interface WorkflowRunDetailLike extends WorkflowRunSummaryLike {
  definition_path: string;
  inputs: Record<string, string>;
  steps: WorkflowStepSummaryLike[];
}

export interface WorkflowOutcomeLike {
  workflow_run_id: string;
  status: WorkflowRunStatusLike;
  error?: string;
}

/** start / resume 的返回；done 恰好 resolve 一次，失败不 reject（用 status/error 表达） */
export interface WorkflowStartResultLike {
  workflowRunId: string;
  done: Promise<WorkflowOutcomeLike>;
}

/**
 * workflow 控制面（asm 注入；未启用时不注入）。
 * name 只在 workflow.dir 下解析，调用方不得传任意路径。
 */
export interface WorkflowsControl {
  listRuns(opts?: {
    status?: WorkflowRunStatusLike;
    limit?: number;
  }): Promise<WorkflowRunSummaryLike[]>;
  /** 未知 id 返回 null（也允许抛 workflow_not_found） */
  getRun(workflowRunId: string): Promise<WorkflowRunDetailLike | null>;
  start(name: string, opts?: { inputs?: Record<string, string> }): Promise<WorkflowStartResultLike>;
  resume(workflowRunId: string): Promise<WorkflowStartResultLike>;
  /** 主动取消；幂等 */
  cancel(workflowRunId: string): Promise<void>;
}

/** /workflows run|resume：命令交给 REPL 的运行态句柄 */
export interface WorkflowRunHandle {
  workflowRunId: string;
  done: Promise<WorkflowOutcomeLike>;
  cancel(): Promise<void>;
}

// ── 0.4 T2：metrics / feishu 控制面 ──

export interface MetricsSnapshotLike {
  runs: { started: number; completed: number; failed: number; cancelled: number };
  tool_calls: { total: number; failed: number };
  llm: { requests: number; prompt_tokens: number; completion_tokens: number; total_tokens: number };
  duration_ms: { total: number; max: number; avg: number };
  updated_at: number;
}

export interface FeishuStatusLike {
  connected: boolean;
  appIdMasked: string;
  active_chats: number;
  queued_messages: number;
  last_error?: string;
}

/** feishu 已启用即注入；未连接时 connected=false，last_error 照常展示 */
export interface FeishuControlLike {
  status(): FeishuStatusLike;
}

// ── 0.6.1 E7：权限持久化（tui 定义结构，asm 写用户 YAML） ──

/**
 * `permission.auto_approve`（YAML）的读写控制面。
 * asm 注入后，TUI 的 "always" 与 `/permissions add|remove` 才可跨进程生效。
 */
export interface PermissionsControl {
  /** 当前持久化的免确认工具名（用户 YAML） */
  list(): Promise<string[]>;
  /** 写入用户 YAML；已存在时幂等 */
  add(toolName: string): Promise<void>;
  /** 从用户 YAML 移除；不存在时幂等 */
  remove(toolName: string): Promise<void>;
  /** 用户配置文件路径（展示用） */
  path?(): string;
}

// ── 0.5 F3：统一 RPC 入口与 tenant（tui 定义结构，asm 注入实现） ──

/** 冻结错误码集合（DECISION-010 §2.3 / Addendum A-3 §10.2） */
export type RpcErrorCodeLike =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_params'
  | 'tenant_locked'
  | 'quota_exceeded'
  | 'conflict'
  | 'internal';

/** RPC 失败对象形状（asm 的 RpcClientError 结构兼容） */
export interface RpcErrorLike {
  code: RpcErrorCodeLike;
  message: string;
  details?: unknown;
}

/** 订阅通知（A-3 §10.3 冻结） */
export interface RpcEventNotificationLike {
  method: 'events.event';
  /** RunEvent；缺字段时按可选处理（A-4 §11.1） */
  params: unknown;
}

/**
 * RPC 客户端（E16；A-3 §10.2 / A-4 §11.6）。
 * vessel 自身 bootstrap 在 local 与 http 两种模式下都必须注入。
 */
export interface RpcClientLike {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  subscribe(handler: (notification: RpcEventNotificationLike) => void): () => void;
}

/** 启动时解析出的 tenant（只用于展示；不参与数据访问） */
export interface TenantInfoLike {
  tenant_id: string;
  data_dir?: string;
}

/** tenant 元数据（A-4 §11.3 / asm TenantMeta 形状） */
export interface TenantQuotaLike {
  max_sessions?: number;
  max_runs_per_day?: number;
  max_concurrent_runs?: number;
  max_storage_bytes?: number;
}

export interface TenantSummaryLike {
  tenant_id: string;
  name?: string;
  created_at?: number;
  status?: 'active' | 'disabled';
  quota?: TenantQuotaLike;
}

/** capability manifest（A-3 / DECISION-010 §2.3） */
export interface CapabilityMethodLike {
  name: string;
  permission: 'read' | 'write' | 'admin';
  params_schema?: unknown;
  result_schema?: unknown;
}

export interface CapabilityToolLike {
  name: string;
  description?: string;
}

export interface CapabilityPluginLike {
  name: string;
  enabled: boolean;
}

export interface CapabilityManifestLike {
  version: string;
  config_schema_version: number;
  methods: CapabilityMethodLike[];
  tools: CapabilityToolLike[];
  plugins: CapabilityPluginLike[];
}

/** REPL 上下文——cli.ts 壳构造，传给 startRepl() */
export interface ReplContext {
  // ── 核心能力（egg-rolls 构造并注入）──────────────────

  /** 可运行 agent——REPL 只依赖 A10 的最小结构类型（不绑定 AgentRuntime） */
  runtime: RunnableAgent;

  /**
   * 插件宿主——工具与插件的唯一来源（C9）。
   * /tools 读 pluginHost.listTools()；/plugins 读壳注入的 plugins 名单。
   */
  pluginHost: PluginHost;

  /** 会话后端——/resume、/history 的增删改查 */
  session: SessionBackend;

  /** 事件流——StreamOutput / StateTracker 订阅，获取 LlmStreamChunk + 工具调用事件 */
  events: EventStream;

  /** 上下文管理器--/new、/resume 切会话时 clear()，让 runtime.run() 重新从 SessionBackend 载入历史 */
  context: ContextManager;

  // ── 可变状态（REPL 读写，壳感知变化）────────────────

  /** 当前会话 ID——/resume、/new 会改；chat 传此 ID 给 runtime.run() */
  currentSessionId: string;

  /** 会话切换回调——REPL 执行 /resume 或 /new 后通知壳更新 currentSessionId */
  onSessionChange: (sessionId: string) => void;

  // ── 显示信息（REPL 只读）────────────────────────────

  /** Provider 信息——状态栏显示 "OpenAI | gpt-4 | api.openai.com" */
  provider: {
    name: string;
    model: string;
    baseUrl: string;
  };

  /** 已加载插件名——状态栏显示（如 "basic-tools, hook-logging"） */
  plugins: string[];

  /** 当前配置（只读）——状态栏/system prompt 引用 */
  config: VesselConfig;

  // ── 工具函数（跨壳/REPL 共用）───────────────────────

  /** 生成新会话 ID——格式 {YYYYMMDD_HHMMSS}_{6hex}（照搬 Hermes） */
  newSessionId: () => string;

  // ── 生命周期 ───────────────────────────────────────

  /** 退出回调——/exit 时调，壳负责 runtime.dispose() + process.exit() */
  onExit: () => void;

  // ── 0.3 能力控制面（asm 注入；未启用时保持 undefined） ──

  /** MCP 状态与重连；未配置 mcp_servers 时不注入 */
  mcp?: McpControl;

  /** durable run 列表与恢复；durable 未启用或不支持恢复时不注入 */
  runs?: DurableRunsControl;

  // ── 0.4 能力控制面（asm 注入；未启用时保持 undefined） ──

  /** workflow 列表 / 详情 / 启动 / 恢复 / 取消；workflow 未启用时不注入 */
  workflows?: WorkflowsControl;

  /** 进程内 metrics 快照；observability.metrics 关闭时不注入 */
  metrics?: () => MetricsSnapshotLike;

  /** 飞书渠道状态；feishu 未启用时不注入（已启用但未连接仍注入） */
  feishu?: FeishuControlLike;

  // ── 0.5 注入面（vessel bootstrap 必须注入；旧字段只服务第三方嵌入） ──

  /** 统一 RPC 入口（LocalRpcClient / HttpRpcClient）；TUI 的数据访问都走它 */
  rpc?: RpcClientLike;

  /** 当前 tenant；缺失时按 default 展示 */
  tenant?: TenantInfoLike;

  /** 版本号（启动头展示）；缺失时省略 vX */
  version?: string;

  /** 权限持久化写回；未注入时 "always" 只在当前进程生效 */
  permissions?: PermissionsControl;
}
