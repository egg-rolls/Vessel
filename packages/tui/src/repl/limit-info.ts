/**
 * 限制与预算可见性（0.14.1 Self Card / limits）。
 * @module @vessel-agent/tui
 *
 * 只读 reducer：有效限制来自 `ctx.config`，当前用量来自进程内事件历史。
 * 所有字段都按 snake_case / camelCase 双拼读取；缺字段保持 undefined，
 * 由展示层显示 `unknown` / `unbounded`，不推测运行时之外的限制。
 */

import { DEFAULT_CONFIG, type VesselConfig } from '@vessel-agent/config';
import type { RunEvent } from '@vessel-agent/core';
import { t } from '../i18n/index.js';

/** 主 agent / 子 agent 的有效限制 */
export interface EffectiveLimits {
  maxIterations?: number;
  maxRuntimeSeconds?: number;
  requestLimit?: number;
  toolCallsLimit?: number;
  inputTokensLimit?: number;
  outputTokensLimit?: number;
  totalCostLimit?: number;
  contextMaxTokens?: number;
  /** 0.17 Phase A 无来源；保留字段兼容旧事件展示 */
  maxDepth?: number;
}

/** 单次 run 的已用量 */
export interface UsageSnapshot {
  requests: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalCost?: number;
  startedAt?: number;
  elapsedMs?: number;
}

/** 80% 预算预警（`agent.limit.warning`） */
export interface LimitWarningInfo {
  scope?: string;
  key?: string;
  current?: number | string;
  max?: number | string;
  source?: string;
  /** 0.8 = 80% 预算 */
  threshold?: number;
  hint?: string;
  ts: number;
  eventType: string;
  runId?: string;
  agentId?: string;
}

/** 结构化限制命中信息（`limit_blocked` envelope） */
export interface LimitBlockInfo {
  errorCode: 'limit_blocked';
  scope?: string;
  key?: string;
  current?: number | string;
  max?: number | string;
  source?: string;
  hint?: string;
  retryable?: boolean;
  ts: number;
  eventType: string;
  runId?: string;
  agentId?: string;
}

/** 剩余预算；undefined = 无限制 */
export interface RemainingBudget {
  iterations?: number;
  runtimeMs?: number;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalCost?: number;
}

/** 子 agent 工具可见性：显式声明优先，否则用已出现的 tool.call.started */
export interface AgentToolsInfo {
  tools?: string[];
  /** true = tools 来自已见工具，而不是事件显式声明 */
  seen: boolean;
}

export interface LimitBlockFilter {
  /** 匹配 event.run_id 之一（子 agent 用 childRunId） */
  runIds?: string[];
  /** 匹配 payload 的 delegateId / agentId */
  agentId?: string;
}

/** 与 AgentNode 的结构子集解耦，避免 repl 反向依赖命令层 */
interface AgentUsageSource {
  id: string;
  childRunId?: string;
  startedAt: number;
  endedAt?: number;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    total_cost?: number;
  };
}

const LIMIT_BLOCK_TYPE_RE = /(^|[._:-])limit[._:-]?blocked($|[._:-])/i;
const LIMIT_WARNING_TYPE_RE = /(^|[._:-])limit[._:-]?warning($|[._:-])/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dataOf(event: RunEvent): Record<string, unknown> {
  return isRecord(event.data) ? event.data : {};
}

function readString(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function readNumber(data: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** 数值字段兼容 `"50"` 形式（跨节点 / 序列化 payload） */
function readNumberLike(
  data: Record<string, unknown>,
  ...keys: string[]
): number | string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
  }
  return undefined;
}

function readBoolean(data: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function readStringArray(data: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = data[key];
    if (!Array.isArray(value)) continue;
    const items = value.filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    );
    if (items.length > 0) return items;
  }
  return undefined;
}

/** 去掉重复的 `subagent.` 前缀（嵌套转发可能出现 subagent.subagent.*） */
function baseType(type: string): string {
  let value = type;
  while (value.startsWith('subagent.')) value = value.slice('subagent.'.length);
  return value;
}

function delegateIdOf(data: Record<string, unknown>): string | undefined {
  return readString(data, 'delegateId', 'delegate_id', 'agentId', 'agent_id');
}

function eventMatchesNode(event: RunEvent, node: AgentUsageSource): boolean {
  if (node.childRunId !== undefined && event.run_id === node.childRunId) return true;
  return delegateIdOf(dataOf(event)) === node.id;
}

interface UsageValues {
  prompt: number;
  completion: number;
  total: number;
  cost?: number;
}

function readUsageValues(data: Record<string, unknown>): UsageValues | undefined {
  const raw = data.usage;
  if (!isRecord(raw)) return undefined;
  const prompt = readNumber(raw, 'prompt_tokens', 'promptTokens') ?? 0;
  const completion = readNumber(raw, 'completion_tokens', 'completionTokens') ?? 0;
  const total = readNumber(raw, 'total_tokens', 'totalTokens') ?? prompt + completion;
  const cost = readNumber(raw, 'total_cost', 'totalCost');
  return { prompt, completion, total, ...(cost !== undefined ? { cost } : {}) };
}

function addUsage(usage: UsageSnapshot, data: Record<string, unknown>): void {
  const values = readUsageValues(data);
  if (values === undefined) return;
  usage.promptTokens += values.prompt;
  usage.completionTokens += values.completion;
  usage.totalTokens += values.total;
  if (values.cost !== undefined) usage.totalCost = (usage.totalCost ?? 0) + values.cost;
}

/** 终值：取实时累计与终值报告的较大者，避免重复计数或缺报 */
function applyFinalUsage(usage: UsageSnapshot, data: Record<string, unknown>): void {
  const values = readUsageValues(data);
  if (values === undefined) return;
  usage.promptTokens = Math.max(usage.promptTokens, values.prompt);
  usage.completionTokens = Math.max(usage.completionTokens, values.completion);
  usage.totalTokens = Math.max(usage.totalTokens, values.total);
  if (values.cost !== undefined) {
    usage.totalCost = Math.max(usage.totalCost ?? 0, values.cost);
  }
}

function emptyUsage(): UsageSnapshot {
  return { requests: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/**
 * 主 agent 有效限制。
 * 与 bootstrap 一致：limits 整块回退 DEFAULT_CONFIG；termination 逐字段回退
 * （只配置了 maxIterations 时，maxRuntimeSeconds 仍是 300）。
 */
export function readEffectiveLimits(config: VesselConfig | undefined): EffectiveLimits {
  const limits = config?.limits ?? DEFAULT_CONFIG.limits ?? {};
  const termination = config?.termination;
  const maxIterations =
    termination?.maxIterations ?? DEFAULT_CONFIG.termination?.maxIterations ?? 20;
  const maxRuntimeSeconds =
    termination?.maxRuntimeSeconds ?? DEFAULT_CONFIG.termination?.maxRuntimeSeconds;
  const maxContext = config?.context?.maxTokens ?? DEFAULT_CONFIG.context?.maxTokens ?? 1_000_000;
  return {
    maxIterations,
    ...(maxRuntimeSeconds !== undefined ? { maxRuntimeSeconds } : {}),
    ...(limits.requestLimit !== undefined ? { requestLimit: limits.requestLimit } : {}),
    ...(limits.toolCallsLimit !== undefined ? { toolCallsLimit: limits.toolCallsLimit } : {}),
    ...(limits.inputTokensLimit !== undefined ? { inputTokensLimit: limits.inputTokensLimit } : {}),
    ...(limits.outputTokensLimit !== undefined
      ? { outputTokensLimit: limits.outputTokensLimit }
      : {}),
    ...(limits.totalCostLimit !== undefined ? { totalCostLimit: limits.totalCostLimit } : {}),
    contextMaxTokens: maxContext,
  };
}

/**
 * 子 agent（AgentService 成员）有效限制。
 * 成员设置来自 `agent.*`；缺省与 bootstrap 一致回退 DEFAULT_CONFIG。
 * `maxDepth` 在 0.17 Phase A 没有来源，省略。
 */
export function readDelegateLimits(config: VesselConfig | undefined): EffectiveLimits {
  const agent = config?.agent;
  const termination = agent?.termination;
  const limits = agent?.limits ?? DEFAULT_CONFIG.limits ?? {};
  const maxIterations =
    termination?.maxIterations ?? DEFAULT_CONFIG.termination?.maxIterations ?? 20;
  const maxRuntimeSeconds =
    termination?.maxRuntimeSeconds ?? DEFAULT_CONFIG.termination?.maxRuntimeSeconds;
  return {
    maxIterations,
    ...(maxRuntimeSeconds !== undefined ? { maxRuntimeSeconds } : {}),
    ...(limits.requestLimit !== undefined ? { requestLimit: limits.requestLimit } : {}),
    ...(limits.toolCallsLimit !== undefined ? { toolCallsLimit: limits.toolCallsLimit } : {}),
    ...(limits.inputTokensLimit !== undefined ? { inputTokensLimit: limits.inputTokensLimit } : {}),
    ...(limits.outputTokensLimit !== undefined
      ? { outputTokensLimit: limits.outputTokensLimit }
      : {}),
    ...(limits.totalCostLimit !== undefined ? { totalCostLimit: limits.totalCostLimit } : {}),
  };
}

/**
 * 折叠单个顶层 run 的用量。只认精确 `run_id`（子 agent 事件使用子 run id，不会混入）。
 * `run.completed.iterations` 作为 requests 的兜底。
 */
export function readRunUsage(
  events: RunEvent[],
  runId: string | undefined,
  now?: number,
): UsageSnapshot {
  const usage = emptyUsage();
  if (runId === undefined) return usage;

  for (const event of events) {
    if (event.run_id !== runId) continue;
    const type = event.type;
    const data = dataOf(event);

    if (type === 'run.started' || type === 'run.resumed') {
      usage.startedAt ??= event.ts;
      continue;
    }
    if (type === 'llm.response') {
      usage.requests += 1;
      addUsage(usage, data);
      continue;
    }
    if (type === 'tool.call.started') {
      usage.toolCalls += 1;
      continue;
    }
    if (type === 'run.completed') {
      const iterations = readNumber(data, 'iterations');
      if (iterations !== undefined) usage.requests = Math.max(usage.requests, iterations);
    }
  }

  if (usage.startedAt !== undefined && now !== undefined) {
    usage.elapsedMs = Math.max(0, now - usage.startedAt);
  }
  return usage;
}

/**
 * 折叠子 agent 用量：优先按 childRunId 过滤，其次按 payload 的 delegateId/agentId。
 * `delegate.completed.usage` 作为终值，与实时累计取较大者，避免重复计数。
 */
export function readAgentUsage(
  events: RunEvent[],
  node: AgentUsageSource,
  now: number,
): UsageSnapshot {
  const usage = emptyUsage();
  usage.startedAt = node.startedAt;

  for (const event of events) {
    if (!eventMatchesNode(event, node)) continue;
    const data = dataOf(event);
    const type = baseType(event.type);

    if (type === 'llm.response') {
      usage.requests += 1;
      addUsage(usage, data);
      continue;
    }
    if (type === 'tool.call.started') {
      usage.toolCalls += 1;
      continue;
    }
    if (type === 'run.completed') {
      const iterations = readNumber(data, 'iterations');
      if (iterations !== undefined) usage.requests = Math.max(usage.requests, iterations);
      continue;
    }
    if (type === 'delegate.completed') {
      applyFinalUsage(usage, data);
    }
  }

  if (node.usage) {
    usage.promptTokens = Math.max(usage.promptTokens, node.usage.prompt_tokens ?? 0);
    usage.completionTokens = Math.max(usage.completionTokens, node.usage.completion_tokens ?? 0);
    usage.totalTokens = Math.max(
      usage.totalTokens,
      node.usage.total_tokens ?? usage.promptTokens + usage.completionTokens,
    );
    if (node.usage.total_cost !== undefined) {
      usage.totalCost = Math.max(usage.totalCost ?? 0, node.usage.total_cost);
    }
  }

  usage.elapsedMs = Math.max(0, (node.endedAt ?? now) - node.startedAt);
  return usage;
}

/**
 * 子 agent 可见工具：`delegate.started` / `run.started` 的 `tools|tool_names` 显式声明
 * 优先；否则汇总该节点已出现的 `tool.call.started.tool_name` 并标记 seen。
 */
export function readAgentTools(events: RunEvent[], node: AgentUsageSource): AgentToolsInfo {
  const seen = new Set<string>();
  for (const event of events) {
    if (!eventMatchesNode(event, node)) continue;
    const data = dataOf(event);
    const type = baseType(event.type);

    if (type === 'delegate.started' || type === 'run.started') {
      const explicit = readStringArray(data, 'tools', 'tool_names', 'toolNames');
      if (explicit !== undefined) return { tools: explicit, seen: false };
    }
    if (type === 'tool.call.started') {
      const tool = readString(data, 'tool_name', 'toolName');
      if (tool !== undefined) seen.add(tool);
    }
  }
  return seen.size > 0 ? { tools: [...seen], seen: true } : { seen: false };
}

function limitPayload(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidates = [data];
  for (const key of ['details', 'envelope', 'error', 'limit'] as const) {
    const value = data[key];
    if (isRecord(value)) candidates.push(value);
  }
  for (const candidate of candidates) {
    const code = readString(candidate, 'error_code', 'errorCode', 'code', 'type');
    if (code === 'limit_blocked') return candidate;
  }
  return undefined;
}

function pickString(
  sources: Array<Record<string, unknown>>,
  ...keys: string[]
): string | undefined {
  for (const source of sources) {
    const value = readString(source, ...keys);
    if (value !== undefined) return value;
  }
  return undefined;
}

function pickNumberLike(
  sources: Array<Record<string, unknown>>,
  ...keys: string[]
): number | string | undefined {
  for (const source of sources) {
    const value = readNumberLike(source, ...keys);
    if (value !== undefined) return value;
  }
  return undefined;
}

function pickBoolean(
  sources: Array<Record<string, unknown>>,
  ...keys: string[]
): boolean | undefined {
  for (const source of sources) {
    const value = readBoolean(source, ...keys);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * 从单个事件提取限制命中信息。
 * 兼容 `limit.blocked` / `agent.limit.blocked` 事件，以及任意 error envelope 中的
 * `error_code|code = limit_blocked`（可嵌在 details / envelope / error / limit）。
 */
export function readLimitBlock(event: RunEvent): LimitBlockInfo | undefined {
  const data = dataOf(event);
  const nested = limitPayload(data);
  const typeMatches = LIMIT_BLOCK_TYPE_RE.test(event.type);
  if (nested === undefined && !typeMatches) return undefined;

  const sources = nested === undefined ? [data] : [nested, data];
  const scope = pickString(sources, 'scope', 'limit_scope', 'limitScope');
  const key = pickString(sources, 'key', 'limit_key', 'limitKey');
  const current = pickNumberLike(sources, 'current', 'current_value', 'currentValue', 'used');
  const max = pickNumberLike(sources, 'max', 'max_value', 'maxValue', 'limit');
  const source = pickString(sources, 'source', 'config_source', 'configSource');
  const hint = pickString(sources, 'hint', 'suggestion', 'retry_hint', 'retryHint');
  const retryable = pickBoolean(sources, 'retryable');
  const agentId = pickString(sources, 'delegateId', 'delegate_id', 'agentId', 'agent_id');

  return {
    errorCode: 'limit_blocked',
    ...(scope !== undefined ? { scope } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(current !== undefined ? { current } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(hint !== undefined ? { hint } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ts: event.ts,
    eventType: event.type,
    ...(event.run_id !== undefined ? { runId: event.run_id } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
  };
}

/**
 * 最新的匹配限制命中事件（按事件顺序倒序扫描）。
 * runIds 与 agentId 同时给出时任一匹配即可；都不给时返回最新一条。
 */
export function findLatestLimitBlock(
  events: RunEvent[],
  filter: LimitBlockFilter = {},
): LimitBlockInfo | undefined {
  const runIds = new Set(filter.runIds ?? []);
  const hasRunFilter = runIds.size > 0;
  const hasAgentFilter = filter.agentId !== undefined;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    const block = readLimitBlock(event);
    if (!block) continue;
    if (hasRunFilter || hasAgentFilter) {
      const runMatch = hasRunFilter && runIds.has(event.run_id);
      const agentMatch = hasAgentFilter && block.agentId === filter.agentId;
      if (!runMatch && !agentMatch) continue;
    }
    return block;
  }
  return undefined;
}

/**
 * 从单个事件提取 80% 预算预警。
 * 只认 `agent.limit.warning` / `limit.warning` 一类事件；不读 error envelope。
 */
export function readLimitWarning(event: RunEvent): LimitWarningInfo | undefined {
  if (!LIMIT_WARNING_TYPE_RE.test(event.type)) return undefined;
  const data = dataOf(event);
  const scope = pickString([data], 'scope', 'limit_scope', 'limitScope');
  const key = pickString([data], 'key', 'limit_key', 'limitKey');
  const current = pickNumberLike([data], 'current', 'current_value', 'currentValue', 'used');
  const max = pickNumberLike([data], 'max', 'max_value', 'maxValue', 'limit');
  const source = pickString([data], 'source', 'config_source', 'configSource');
  const threshold = readNumber(data, 'threshold');
  const hint = pickString([data], 'hint', 'suggestion', 'retry_hint', 'retryHint');
  const agentId = pickString([data], 'delegateId', 'delegate_id', 'agentId', 'agent_id');

  return {
    ...(scope !== undefined ? { scope } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(current !== undefined ? { current } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(hint !== undefined ? { hint } : {}),
    ts: event.ts,
    eventType: event.type,
    ...(event.run_id !== undefined ? { runId: event.run_id } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
  };
}

/**
 * 每个 key 只保留最新一条预警（E2：每 run 每 key 一次）。
 * key 缺失时按 scope 归组，避免同一事件类型刷屏。
 */
export function findLatestLimitWarnings(
  events: RunEvent[],
  filter: LimitBlockFilter = {},
): LimitWarningInfo[] {
  const runIds = new Set(filter.runIds ?? []);
  const hasRunFilter = runIds.size > 0;
  const hasAgentFilter = filter.agentId !== undefined;
  const latest = new Map<string, LimitWarningInfo>();

  for (const event of events) {
    const warning = readLimitWarning(event);
    if (!warning) continue;
    if (hasRunFilter || hasAgentFilter) {
      const runMatch = hasRunFilter && runIds.has(event.run_id);
      const agentMatch = hasAgentFilter && warning.agentId === filter.agentId;
      if (!runMatch && !agentMatch) continue;
    }
    const group = `${warning.scope ?? ''}\u0000${warning.key ?? ''}`;
    latest.set(group, warning);
  }

  return [...latest.values()].sort((a, b) => a.ts - b.ts);
}

function left(max: number | undefined, used: number | undefined): number | undefined {
  if (max === undefined) return undefined;
  return Math.max(0, max - (used ?? 0));
}

/** 剩余预算：只对已配置的上限计算；无上限保持 undefined。 */
export function remainingBudget(limits: EffectiveLimits, usage: UsageSnapshot): RemainingBudget {
  return {
    ...(limits.maxIterations !== undefined
      ? { iterations: left(limits.maxIterations, usage.requests) }
      : {}),
    ...(limits.maxRuntimeSeconds !== undefined
      ? { runtimeMs: left(limits.maxRuntimeSeconds * 1000, usage.elapsedMs) }
      : {}),
    ...(limits.toolCallsLimit !== undefined
      ? { toolCalls: left(limits.toolCallsLimit, usage.toolCalls) }
      : {}),
    ...(limits.inputTokensLimit !== undefined
      ? { inputTokens: left(limits.inputTokensLimit, usage.promptTokens) }
      : {}),
    ...(limits.outputTokensLimit !== undefined
      ? { outputTokens: left(limits.outputTokensLimit, usage.completionTokens) }
      : {}),
    ...(limits.totalCostLimit !== undefined
      ? { totalCost: left(limits.totalCostLimit, usage.totalCost) }
      : {}),
  };
}

/** 命中信息的统一短文本：`scope/key current/max · source · hint · retryable`。 */
export function formatLimitBlock(info: LimitBlockInfo): string {
  const unknown = t('limits.unknown');
  const parts = [
    t('agents.blockedValue', {
      scope: info.scope ?? unknown,
      key: info.key ?? unknown,
      current: info.current ?? unknown,
      max: info.max ?? unknown,
    }),
  ];
  if (info.source !== undefined) parts.push(info.source);
  if (info.hint !== undefined) parts.push(info.hint);
  if (info.retryable !== undefined) {
    parts.push(info.retryable ? t('errors.retryable') : t('errors.notRetryable'));
  }
  return parts.join(' · ');
}

/** 预警短文本：`scope/key current/max · 80% threshold · source · hint`。 */
export function formatLimitWarning(info: LimitWarningInfo): string {
  const unknown = t('limits.unknown');
  const threshold =
    info.threshold === undefined
      ? unknown
      : `${Math.round((info.threshold <= 1 ? info.threshold * 100 : info.threshold) * 10) / 10}%`;
  const parts = [
    t('limits.warningValue', {
      scope: info.scope ?? unknown,
      key: info.key ?? unknown,
      current: info.current ?? unknown,
      max: info.max ?? unknown,
      threshold,
    }),
  ];
  if (info.source !== undefined) parts.push(info.source);
  if (info.hint !== undefined) parts.push(info.hint);
  return parts.join(' · ');
}
