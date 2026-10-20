/**
 * @vessel-agent/workflow 公开类型与冻结控制面。
 *
 * 字段名按 DECISION-009 §5.1.4 / Addendum B / Addendum C 冻结，不得单方面改名。
 */

import type {
  EventStream,
  Plugin,
  PluginHost,
  RunnableAgent,
  RuntimeHost,
  ToolPipeline,
} from '@vessel-agent/core';

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

export type WorkflowWhenStatus = 'completed' | 'failed' | 'skipped';

export type WorkflowOnError = 'fail' | 'continue';

export interface WorkflowRunSummary {
  workflow_run_id: string;
  workflow_name: string;
  status: WorkflowRunStatus;
  step_count: number;
  completed_steps: number;
  started_at: number;
  updated_at: number;
  error?: string;
  /** 0.5：可选；缺失视为 default。 */
  tenant_id?: string;
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

export interface WorkflowControls {
  listRuns(opts?: { status?: WorkflowRunStatus; limit?: number }): Promise<WorkflowRunSummary[]>;
  getRun(workflowRunId: string): Promise<WorkflowRunDetail | null>;
  /** definitionPath 必须是绝对路径或相对 workflow.dir 解析后的路径；调用方负责约束来源。 */
  start(
    definitionPath: string,
    opts?: { inputs?: Record<string, string> },
  ): Promise<{ workflowRunId: string; done: Promise<WorkflowOutcome> }>;
  resume(workflowRunId: string): Promise<{ workflowRunId: string; done: Promise<WorkflowOutcome> }>;
  cancel(workflowRunId: string): Promise<void>;
}

export type WorkflowErrorCode =
  | 'workflow_not_found'
  | 'workflow_invalid'
  | 'workflow_already_running'
  | 'workflow_not_resumable'
  | 'workflow_cancelled'
  | 'workflow_disabled';

export interface WorkflowRetry {
  max_attempts?: number;
  backoff_ms?: number;
}

export interface WorkflowWhen {
  step: string;
  status?: WorkflowWhenStatus;
  contains?: string;
  equals?: string;
}

export interface WorkflowStepDefinition {
  id: string;
  type: 'agent' | 'tool';
  agent?: string;
  prompt?: string;
  tool?: string;
  args?: Record<string, unknown>;
  depends_on?: string[];
  when?: WorkflowWhen;
  retry?: WorkflowRetry;
  on_error?: WorkflowOnError;
}

export interface WorkflowDefaults {
  agent?: string;
  max_parallel?: number;
  step_timeout_ms?: number;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  version?: number;
  defaults?: WorkflowDefaults;
  steps: WorkflowStepDefinition[];
  on_error?: WorkflowOnError;
}

export interface ResolvedWorkflowConfig {
  enabled: boolean;
  /** workflow.dir：定义文件目录（绝对路径）。 */
  dir: string;
  /** workflow.path：run 记录目录（绝对路径）。 */
  path: string;
  maxParallel: number;
  stepTimeoutMs: number;
}

/** 文件操作最小接口；测试可注入 rename 失败等行为。 */
export interface WorkflowDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface WorkflowFs {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string, options: { withFileTypes: true }): Promise<WorkflowDirent[]>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  realpath(path: string): Promise<string>;
}

export interface WorkflowEngineOptions {
  /** Host 模式：agent step 使用 Host 中已有成员。 */
  host?: RuntimeHost;
  /** 单 agent 回退：所有 agent step 串行，session 固定 workflow:<run_id>。 */
  runtime?: RunnableAgent;
  /** 工具来源（冻结签名必填）。 */
  pluginHost: PluginHost;
  /**
   * 0.8.2 Wave 2B1：统一工具执行管道（可选）。
   * 注入时 `type: tool` 步骤走 pipeline（permission/hook/guardrail/handler）；
   * 缺省保留旧的直接 handler 路径（兼容嵌入方）。
   */
  toolPipeline?: ToolPipeline;
  config: ResolvedWorkflowConfig;
  events: EventStream;
  /**
   * 0.5：tenant 作用域（可选）。缺省 = 0.4 兼容，不写 tenant_id、可读全部旧 record。
   * 路径由 asm 解析；引擎不追加 tenants/<id>。
   */
  tenantId?: string;
  /** 测试注入。 */
  fs?: WorkflowFs;
}

export interface WorkflowEngine extends Plugin, WorkflowControls {
  /** SIGINT/SIGTERM：把运行中的 run 落盘为 interrupted（不是用户 cancel）。 */
  interruptAll(reason?: string): Promise<void>;
  /** 等待进行中的写入落盘；不改变 run 状态。 */
  close(): Promise<void>;
}

/** 内部 step 状态（持久化用）。 */
export interface WorkflowStepState {
  id: string;
  type: 'agent' | 'tool';
  status: WorkflowStepStatus;
  attempts: number;
  started_at?: number;
  finished_at?: number;
  error?: string;
  output: string;
  output_preview?: string;
}

/** 内部 run 文件（一 run 一 JSON）。 */
export interface WorkflowRunFile {
  schema_version: 1;
  workflow_run_id: string;
  workflow_name: string;
  definition_path: string;
  definition: WorkflowDefinition;
  inputs: Record<string, string>;
  status: WorkflowRunStatus;
  steps: WorkflowStepState[];
  started_at: number;
  updated_at: number;
  finished_at?: number;
  error?: string;
  /** 0.5：可选；缺失视为 default（旧 record 可读）。 */
  tenant_id?: string;
}
