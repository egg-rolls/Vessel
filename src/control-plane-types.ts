/**
 * 0.4 控制面结构类型（asm 侧）。
 *
 * 这些类型与 ext / tui / web 冻结的公开形状结构性兼容；asm 不静态 import
 * `@vessel-agent/evals` / `@vessel-agent/feishu` 的实现，避免并行分支
 * 在包尚未合入时 typecheck 失败。
 */

import type {
  ContextManager,
  EventStream,
  LLMProvider,
  Plugin,
  PluginHost,
  RunStore,
  SessionBackend,
} from '../packages/core/src/index';

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

/** 与 @vessel-agent/evals `EvalRunOptions` 结构一致（去掉 suitePath） */
export interface EvalRunOptionsLike {
  /** suite 名解析目录 */
  suiteDir?: string;
  /** 报告目录；写盘由 @vessel-agent/evals report.ts 负责 */
  outDir?: string;
  /** --out 覆盖 */
  outPath?: string;
  filterTags?: string[];
  allowNetwork?: boolean;
  /** 存在即视为网络 provider */
  providerFactory?: () => LLMProvider;
  model?: string;
  enabled?: boolean;
  /** 0.5：tenant 作用域（A-6 §13.4）。 */
  tenantId?: string;
  /** 0.5：`eval.run.*` 事件出口；缺失不发（0.4 兼容）。 */
  events?: EventStream;
}

/** `createEvalsPlugin()` 返回 Plugin + runner 合体 */
export interface EvalRunnerLike {
  runSuite(suitePath: string, options?: EvalRunOptionsLike): Promise<EvalReport>;
  getLatest(suite: string): Promise<EvalReport | null>;
}

export interface EvalsModuleLike {
  createEvalsPlugin(options?: {
    outDir?: string;
    enabled?: boolean;
    tenantId?: string;
    events?: EventStream;
  }): Plugin & EvalRunnerLike;
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

/** 与 @vessel-agent/feishu `FeishuPluginOptions` 结构一致 */
export interface FeishuChannelOptionsLike {
  /** 与 @vessel-agent/feishu `FeishuConfig` 一致（env 已由 config loader 合并） */
  config: {
    enabled?: boolean;
    appId?: string;
    appSecret?: string;
    domain?: 'feishu' | 'lark';
    allowedChatIds?: string[];
    sessionPrefix?: string;
    replyTimeoutMs?: number;
    maxReplyChars?: number;
    maxMembers?: number;
  };
  events: EventStream;
  provider: LLMProvider;
  model: string;
  pluginHost: PluginHost;
  session: SessionBackend;
  contextFactory?: () => ContextManager;
  runStore?: RunStore;
  maxConcurrency?: number;
  maxQueueSize?: number;
  perAgentSerial?: boolean;
  transport?: unknown;
  /** 0.5：tenant 作用域（A-6 §13.4）；缺省不写 tenant_id。 */
  tenantId?: string;
  /** 0.5：tenant 实例显式 `{}`，避免 ambient VESSEL_FEISHU_* 串用。 */
  env?: Record<string, string | undefined>;
}

export interface FeishuPluginLike extends Plugin, FeishuChannelLike {
  close(): Promise<void>;
}

export interface FeishuModuleLike {
  createFeishuPlugin(options: FeishuChannelOptionsLike): FeishuPluginLike;
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
  /** 0.5 A6-09：清空累计（gateway `metrics.reset`） */
  reset?(): void;
}
