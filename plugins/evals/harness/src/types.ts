/**
 * @vessel/evals 公开类型（DECISION-009 §5.2 / Addendum B §11.2）。
 */

import type { LLMProvider, Plugin, RunnableAgent, ToolCall } from '@vessel/core';

export type EvalCaseStatus = 'passed' | 'failed' | 'error' | 'skipped';

export type EvalAssertionType =
  | 'output_contains'
  | 'output_matches'
  | 'no_error'
  | 'tool_called'
  | 'tool_not_called'
  | 'max_duration_ms'
  | 'max_iterations'
  | 'usage_under';

export interface EvalAssertion {
  type: EvalAssertionType;
  value?: unknown;
}

export interface EvalMockResponse {
  content: string;
  /** Addendum B §11.2.1 批准：用于离线触发 tool_called/tool_not_called。 */
  tool_calls?: ToolCall[];
}

export interface EvalMock {
  responses: EvalMockResponse[];
}

export type EvalSessionMode = 'fresh' | 'shared';

export interface EvalCase {
  id: string;
  input: string;
  tags?: string[];
  timeout_ms?: number;
  session?: EvalSessionMode;
  mock?: EvalMock;
  expect: EvalAssertion[];
}

export interface EvalDefaults {
  timeout_ms?: number;
  tags?: string[];
  session?: EvalSessionMode;
}

export interface EvalSuite {
  name: string;
  description?: string;
  defaults?: EvalDefaults;
  cases: EvalCase[];
}

export interface EvalAssertionResult {
  type: string;
  ok: boolean;
  detail?: string;
}

export interface EvalUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface EvalCaseResult {
  id: string;
  status: EvalCaseStatus;
  duration_ms: number;
  assertions: EvalAssertionResult[];
  output?: string;
  usage?: EvalUsage;
  error?: string;
  /** Addendum B §11.2.1 批准的 additive 字段（如 mock_exhausted）。 */
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
  /** 0.5：可选；缺失视为 default。报告正文不脱敏（A-4 §11.4 已知限制）。 */
  tenant_id?: string;
}

export interface EvalCaseContext {
  suite: EvalSuite;
  testCase: EvalCase;
  session: EvalSessionMode;
  index: number;
  sharedRuntime?: RunnableAgent;
}

export type EvalRuntimeFactory = (context: EvalCaseContext) => Promise<RunnableAgent>;

export interface EvalRunOptions {
  /** suite 文件路径，或（提供 suiteDir 时）单段 suite 名。 */
  suitePath: string;
  /** suite 名解析目录。 */
  suiteDir?: string;
  /** 报告目录；与 outPath 二选一。 */
  outDir?: string;
  /** 显式报告路径，覆盖 outDir。 */
  outPath?: string;
  filterTags?: string[];
  /** 只有 CLI --allow-network 才应传 true。 */
  allowNetwork?: boolean;
  /** 存在即视为网络 provider。 */
  providerFactory?: () => LLMProvider;
  createRuntime?: EvalRuntimeFactory;
  plugins?: Plugin[];
  model?: string;
  /** config.evals.enabled；false → eval_invalid。 */
  enabled?: boolean;
  /** 测试注入。 */
  now?: () => number;
  /** 测试注入：报告文件名时间戳。 */
  timestamp?: string;
  /** 0.5：tenant 作用域（可选）；缺失不写 tenant_id。 */
  tenantId?: string;
  /** 0.5：事件出口（可选）；缺失不发 eval.run.* 事件（0.4 兼容）。 */
  events?: import('@vessel/core').EventStream;
}

export interface EvalRunner {
  runSuite(suitePath: string, options?: Omit<EvalRunOptions, 'suitePath'>): Promise<EvalReport>;
  getLatest(suite: string): Promise<EvalReport | null>;
}

export interface EvalPlugin extends Plugin, EvalRunner {}

export interface EvalPluginOptions {
  outDir?: string;
  enabled?: boolean;
  /** 0.5：tenant 作用域（可选）。 */
  tenantId?: string;
  /** 0.5：eval.run.* 事件出口（可选）；缺失不发。 */
  events?: import('@vessel/core').EventStream;
}

export type EvalErrorCode = 'eval_not_found' | 'eval_invalid' | 'eval_network_required';
