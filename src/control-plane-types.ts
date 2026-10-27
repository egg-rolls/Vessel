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

/** 与 @vessel-agent/feishu `FeishuPluginOptions` 结构兼容（0.27 起执行面走 AgentService） */
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
  /**
   * 0.27：注入的 AgentService；成员创建与 admit 执行面。
   * 缺失时插件 start() 显式失败。装配层接线前的过渡期以下字段保留为
   * deprecated（插件已不再使用，类型不删以免破坏未迁移调用方）。
   */
  service?: unknown;
  /** 0.27：取消在途 run（装配层接线）；缺省只放弃等待。 */
  cancelRun?: (runId: string, reason?: string) => boolean;
  /** @deprecated 0.27：执行面已迁移到 service.admit；插件不再使用。 */
  provider?: LLMProvider;
  /** @deprecated 0.27：执行面已迁移到 service.admit；插件不再使用。 */
  model?: string;
  /** @deprecated 0.27：执行面已迁移到 service.admit；插件不再使用。 */
  pluginHost?: PluginHost;
  /** @deprecated 0.27：执行面已迁移到 service.admit；插件不再使用。 */
  session?: SessionBackend;
  /** @deprecated 0.27：执行面已迁移到 service.admit；插件不再使用。 */
  contextFactory?: () => ContextManager;
  /** @deprecated 0.27：执行面已迁移到 service.admit；插件不再使用。 */
  runStore?: RunStore;
  /** @deprecated 0.27：并发由 tenant scheduler 统一裁决；插件不再使用。 */
  maxConcurrency?: number;
  /** @deprecated 0.27：并发由 tenant scheduler 统一裁决；插件不再使用。 */
  maxQueueSize?: number;
  /** @deprecated 0.27：同 body 串行由 tenant scheduler 统一裁决；插件不再使用。 */
  perBodySerial?: boolean;
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
