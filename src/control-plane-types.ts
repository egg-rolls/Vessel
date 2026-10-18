/**
 * 0.4 控制面结构类型（asm 侧）。
 *
 * 这些类型与 ext / tui / web 冻结的公开形状结构性兼容；asm 不静态 import
 * `@vessel/workflow` / `@vessel/evals` / `@vessel/feishu` 的实现，避免并行分支
 * 在包尚未合入时 typecheck 失败。
 */

import type {
  ContextManager,
  EventStream,
  LLMProvider,
  Plugin,
  PluginHost,
  RunnableAgent,
  RunStore,
  RuntimeHost,
  SessionBackend,
} from '../packages/core/src/index';

// ── workflow ────────────────────────────────────

export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type WorkflowStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface WorkflowRunSummary {
  workflow_run_id: string;
  workflow_name: string;
  status: WorkflowRunStatus;
  step_count: number;
  completed_steps: number;
  started_at: number;
  updated_at: number;
  error?: string;
}

export interface WorkflowStepSummary {
  id: string;
  type: 'agent' | 'tool';
  status: WorkflowStepStatus;
  attempts: number;
  started_at?: number;
  finished_at?: number;
  error?: string;
  output_preview?: string;
}

export interface WorkflowRunDetail extends WorkflowRunSummary {
  definition_path: string;
  inputs: Record<string, string>;
  steps: WorkflowStepSummary[];
}

export interface WorkflowOutcome {
  workflow_run_id: string;
  status: WorkflowRunStatus;
  error?: string;
}

export interface WorkflowStartResult {
  workflowRunId: string;
  done: Promise<WorkflowOutcome>;
}

/** 引擎路径接口（gateway / CLI 使用） */
export interface WorkflowControlsLike {
  listRuns(opts?: { status?: WorkflowRunStatus; limit?: number }): Promise<WorkflowRunSummary[]>;
  getRun(workflowRunId: string): Promise<WorkflowRunDetail | null>;
  start(
    definitionPath: string,
    opts?: { inputs?: Record<string, string> },
  ): Promise<WorkflowStartResult>;
  resume(workflowRunId: string): Promise<WorkflowStartResult>;
  cancel(workflowRunId: string): Promise<void>;
}

export interface WorkflowEngineLike extends Plugin, WorkflowControlsLike {
  close(): Promise<void>;
  interruptAll(reason?: string): Promise<void>;
}

export interface ResolvedWorkflowConfigLike {
  enabled: boolean;
  /** 定义目录（绝对路径） */
  dir: string;
  /** run 记录目录（绝对路径） */
  path: string;
  maxParallel: number;
  stepTimeoutMs: number;
}

export interface WorkflowEngineOptionsLike {
  host?: RuntimeHost;
  runtime?: RunnableAgent;
  pluginHost: PluginHost;
  config: ResolvedWorkflowConfigLike;
  events: EventStream;
}

export interface WorkflowModuleLike {
  createWorkflowEngine(options: WorkflowEngineOptionsLike): WorkflowEngineLike;
}

// ── evals ───────────────────────────────────────

export type EvalCaseStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface EvalAssertionResult {
  type: string;
  ok: boolean;
  detail?: string;
}

export interface EvalCaseResult {
  id: string;
  status: EvalCaseStatus;
  duration_ms: number;
  assertions: EvalAssertionResult[];
  output?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  error?: string;
  warnings?: string[];
}

export interface EvalReport {
  suite: string;
  network: boolean;
  started_at: number;
  finished_at: number;
  duration_ms: number;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  cases: EvalCaseResult[];
}

export interface EvalRunOptionsLike {
  suitePath: string;
  /** 报告目录；写盘由 @vessel/evals report.ts 负责 */
  outDir: string;
  /** --out 覆盖 */
  out?: string;
  filters?: string[];
  network: boolean;
  provider?: LLMProvider;
}

export interface EvalRunnerLike {
  runSuite(options: EvalRunOptionsLike): Promise<EvalReport>;
  getLatest(suite: string): Promise<EvalReport | null>;
  findLatestReport?(suite: string): Promise<EvalReport | null>;
}

export interface EvalsModuleLike {
  createEvalsPlugin(options?: { outDir?: string }): {
    plugin: Plugin;
    runner: EvalRunnerLike;
  };
}

// ── feishu ──────────────────────────────────────

export interface FeishuStatus {
  connected: boolean;
  appIdMasked: string;
  active_chats: number;
  queued_messages: number;
  last_error?: string;
}

export interface FeishuChannelLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): FeishuStatus;
}

export interface FeishuSchedulerOptions {
  maxConcurrency: number;
  maxQueueSize: number;
  perAgentSerial: boolean;
}

export interface FeishuChannelOptionsLike {
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
  allowedChatIds: string[];
  sessionPrefix: string;
  replyTimeoutMs: number;
  maxReplyChars: number;
  maxMembers: number;
  provider: LLMProvider;
  model: string;
  pluginHost: PluginHost;
  session: SessionBackend;
  events: EventStream;
  runStore?: RunStore;
  contextFactory?: () => ContextManager;
  scheduler: FeishuSchedulerOptions;
  transport?: unknown;
}

export interface FeishuModuleLike {
  createFeishuChannel(options: FeishuChannelOptionsLike): FeishuChannelLike;
}

// ── observability ───────────────────────────────

export interface MetricsSnapshotLike {
  runs: { started: number; completed: number; failed: number; cancelled: number };
  tool_calls: { total: number; failed: number };
  llm: { requests: number; prompt_tokens: number; completion_tokens: number; total_tokens: number };
  duration_ms: { total: number; max: number; avg: number };
  updated_at: number;
}

export interface MetricsControlLike {
  snapshot(): MetricsSnapshotLike;
  dispose(): void;
}
