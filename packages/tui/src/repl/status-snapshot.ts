/**
 * `/status` 只读快照（0.14 P0）。
 * @module @vessel-agent/tui
 *
 * 全部数据来自 `ReplContext` / `ReplState` / 进程内事件历史；不调用 RPC、不写任何状态。
 * 输出首行必须带快照时间（as_of），避免把旧数据当实时。
 */

import type { RunEvent } from '@vessel-agent/core';
import type { ReplState } from '../commands/commands.js';
import { estimateContextUsage } from '../commands/context-command.js';
import { t } from '../i18n/index.js';
import type { ReplContext } from '../repl-context.js';
import { formatDuration } from '../utils/display-labels.js';
import { padToWidth } from '../utils/text-layout.js';
import { buildAgentRegistry } from './agent-registry.js';
import { type CacheStats, formatCacheSummary, readCacheStats } from './cache-metrics.js';
import {
  type EffectiveLimits,
  findLatestLimitBlock,
  findLatestLimitWarnings,
  formatLimitBlock,
  formatLimitWarning,
  type LimitBlockInfo,
  type LimitWarningInfo,
  readEffectiveLimits,
  readRunUsage,
  type UsageSnapshot,
} from './limit-info.js';
import { type AgentQueueSnapshot, readAgentQueue } from './queue-info.js';

/** 与 config / core 一致的默认上下文预算（ADR-064） */
const DEFAULT_CONTEXT_MAX_TOKENS = 1_000_000;
const LABEL_WIDTH = 12;

export interface StatusRun {
  state: 'idle' | 'running';
  runId?: string;
  sessionId?: string;
  startedAt?: number;
}

/** 最近一次 `context.compacted`（E1） */
export interface CompactionSnapshot {
  runId?: string;
  sessionId?: string;
  removed?: number;
  remaining?: number;
  reason?: string;
  ts: number;
}

export interface StatusSnapshot {
  asOf: number;
  run: StatusRun;
  sessionId: string;
  provider: { name: string; model: string; baseUrl: string };
  context: { used: number; max: number; messages: number };
  /** 主 agent 有效限制（配置 + 运行默认） */
  limits: EffectiveLimits;
  /** active run 的已用量；idle 时 undefined（展示为 `-`） */
  usage?: UsageSnapshot;
  /**
   * 会话级 prompt-cache 命中统计（0.29 B4）。
   * 与 `usage` 不同：它从事件历史聚合，**idle 时也有值**（见 cache-metrics.ts 头注释）。
   */
  cache: CacheStats;
  /** active run 最近一次限制命中 */
  limitBlock?: LimitBlockInfo;
  /** active run 每个 key 最新一条 80% 预警 */
  limitWarnings: LimitWarningInfo[];
  permissions: { autoApprove: string[]; pending: number };
  queue: { input: number };
  /** agent 调度队列（E4；与输入队列独立） */
  agentQueue: AgentQueueSnapshot;
  /** 最近一次压缩；从未压缩时 undefined */
  lastCompaction?: CompactionSnapshot;
  instance: {
    version?: string;
    tenantId: string;
    pid: number;
    uptimeMs: number;
    rpc: boolean;
  };
}

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

const TERMINAL_RUN_EVENTS = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
]);

/**
 * 折叠事件历史：最后一个没有终态的 run。子 agent 事件（subagent.*）不参与。
 *
 * 0.27：成员 body 的执行也是 `run.*`。给了 `mainSessionId` 时只认该 body 的 run，
 * 其它 body（成员/并发 body）的事件整体跳过；未给时保持旧行为（最后一个活跃 run）。
 */
export function findActiveRun(events: RunEvent[], mainSessionId?: string): StatusRun {
  let active: StatusRun = { state: 'idle' };
  for (const event of events) {
    if (event.type.startsWith('subagent.')) continue;
    const data = dataOf(event);
    if (mainSessionId !== undefined) {
      const sessionId = readString(data, 'session_id', 'sessionId');
      if (sessionId !== undefined && sessionId !== mainSessionId) continue;
    }
    if (event.type === 'run.started' || event.type === 'run.resumed') {
      active = {
        state: 'running',
        runId: event.run_id,
        ...(readString(data, 'session_id') !== undefined
          ? { sessionId: readString(data, 'session_id') }
          : {}),
        startedAt: event.ts,
      };
      continue;
    }
    if (TERMINAL_RUN_EVENTS.has(event.type) && active.runId === event.run_id) {
      active = { state: 'idle' };
    }
  }
  return active;
}

/** 事件历史里尚未应答的权限请求数（requestId 配对，run 终态清空同 run 的请求） */
export function countPendingPermissions(events: RunEvent[]): number {
  const pending = new Map<string, string>();
  for (const event of events) {
    const data = dataOf(event);
    const requestId = readString(data, 'requestId', 'request_id');
    if (event.type === 'tool.permission.request' && requestId !== undefined) {
      pending.set(requestId, event.run_id);
      continue;
    }
    if (event.type === 'tool.permission.response' && requestId !== undefined) {
      pending.delete(requestId);
      continue;
    }
    if (TERMINAL_RUN_EVENTS.has(event.type)) {
      for (const [id, runId] of pending) {
        if (runId === event.run_id) pending.delete(id);
      }
    }
  }
  return pending.size;
}

function baseType(type: string): string {
  let value = type;
  while (value.startsWith('subagent.')) value = value.slice('subagent.'.length);
  return value;
}

/** 最新一次 `context.compacted`；字段缺失保持 undefined（展示层显示 unknown）。 */
export function findLatestCompaction(events: RunEvent[]): CompactionSnapshot | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || baseType(event.type) !== 'context.compacted') continue;
    const data = dataOf(event);
    const value = (...keys: string[]): number | undefined => {
      for (const key of keys) {
        const raw = data[key];
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      }
      return undefined;
    };
    const text = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const raw = data[key];
        if (typeof raw === 'string' && raw.length > 0) return raw;
      }
      return undefined;
    };
    const runId = text('run_id', 'runId') ?? event.run_id;
    const sessionId = text('session_id', 'sessionId');
    const removed = value('removed');
    const remaining = value('remaining');
    const reason = text('reason');
    return {
      ...(runId !== undefined ? { runId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(removed !== undefined ? { removed } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ts: event.ts,
    };
  }
  return undefined;
}

export function buildStatusSnapshot(
  ctx: ReplContext,
  state: ReplState,
  now: number = Date.now(),
): StatusSnapshot {
  const events = ctx.events.getHistory();
  const maxTokens = ctx.config.context?.maxTokens ?? DEFAULT_CONTEXT_MAX_TOKENS;
  const messages = ctx.context.messages;
  const estimated = estimateContextUsage(messages, { maxTokens });
  const used = ctx.context.tokenCount > 0 ? ctx.context.tokenCount : estimated.totalTokens;
  const autoApprove = ctx.config.permission?.autoApprove ?? [];
  // 状态栏只关心 REPL 自己的会话（main primary body）：成员 body 的 run 不计入
  // 「当前 run」的 usage / limit，但仍在 agentQueue.running 里体现为成员正在跑。
  const run = findActiveRun(events, state.currentSessionId);
  const runId = run.state === 'running' ? run.runId : undefined;
  const usage = runId !== undefined ? readRunUsage(events, runId, now) : undefined;
  const limitBlock =
    runId !== undefined ? findLatestLimitBlock(events, { runIds: [runId] }) : undefined;
  const limitWarnings =
    runId !== undefined ? findLatestLimitWarnings(events, { runIds: [runId] }) : [];
  const queued = readAgentQueue(events);
  const queuedIds = new Set(queued.entries.map((entry) => entry.id));
  const runningAgents = buildAgentRegistry(events).filter(
    (node) => node.state === 'running' && !queuedIds.has(node.id),
  ).length;
  const agentQueue = { ...queued, running: runningAgents };
  const lastCompaction = findLatestCompaction(events);
  // 会话级聚合：不受 active run 影响，idle 时同样成立（BRIEF §2）。
  const cache = readCacheStats(events, state.currentSessionId);

  return {
    asOf: now,
    run,
    sessionId: state.currentSessionId,
    provider: {
      name: ctx.provider.name,
      model: ctx.provider.model,
      baseUrl: ctx.provider.baseUrl,
    },
    context: {
      used,
      max: maxTokens,
      messages: messages.length,
    },
    limits: readEffectiveLimits(ctx.config),
    ...(usage !== undefined ? { usage } : {}),
    cache,
    ...(limitBlock !== undefined ? { limitBlock } : {}),
    limitWarnings,
    permissions: {
      autoApprove: [...autoApprove],
      pending: countPendingPermissions(events),
    },
    queue: {
      input: state.queuedCount ?? 0,
    },
    agentQueue,
    ...(lastCompaction !== undefined ? { lastCompaction } : {}),
    instance: {
      ...(ctx.version !== undefined ? { version: ctx.version } : {}),
      tenantId: ctx.tenant?.tenant_id ?? 'default',
      pid: process.pid,
      uptimeMs: Math.floor(process.uptime() * 1000),
      rpc: ctx.rpc !== undefined,
    },
  };
}

/** 本地时间 `YYYY-MM-DD HH:mm:ss`（不依赖平台 locale 格式） */
export function formatSnapshotTime(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function groupNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function line(label: string, value: string): string {
  return `  ${padToWidth(label, LABEL_WIDTH)} ${value}`;
}

function continuation(value: string): string {
  return `  ${' '.repeat(LABEL_WIDTH)} ${value}`;
}

function truncateList(values: string[], maxWidth: number): string {
  const joined = values.join(', ');
  return joined.length <= maxWidth ? joined : `${joined.slice(0, Math.max(0, maxWidth - 1))}…`;
}

/** 上限值：未配置 = unbounded（保持配置值可见，不推测） */
function limitMax(max: number | undefined): string {
  return max === undefined ? t('limits.unbounded') : groupNumber(max);
}

/** 已用值：idle 显示 `-`；运行中但事件没给字段时显示 unknown */
function usedValue(running: boolean, used: number | undefined): string {
  if (!running) return t('status.noUsage');
  return used === undefined ? t('limits.unknown') : groupNumber(used);
}

function formatCost(value: number): string {
  return value.toFixed(4);
}

/** 纯函数：快照 -> 一屏文本（label 全部走 t()） */
export function formatStatusSnapshot(snapshot: StatusSnapshot): string {
  const { run } = snapshot;
  const runValue =
    run.state === 'running' && run.runId !== undefined
      ? t('status.runActive', {
          id: run.runId,
          elapsed:
            run.startedAt !== undefined
              ? formatDuration(snapshot.asOf - run.startedAt)
              : t('status.unknown'),
        })
      : t('status.runIdle');

  const percent =
    snapshot.context.max > 0 ? Math.round((snapshot.context.used / snapshot.context.max) * 100) : 0;
  const contextValue = t('status.contextValue', {
    used: groupNumber(snapshot.context.used),
    max: groupNumber(snapshot.context.max),
    percent,
    messages: snapshot.context.messages,
  });

  const usage = snapshot.usage;
  const running = usage !== undefined;
  const limitsValue = t('status.limitsValue', {
    iterations: usedValue(running, usage?.requests),
    maxIterations: limitMax(snapshot.limits.maxIterations),
    tools: usedValue(running, usage?.toolCalls),
    maxTools: limitMax(snapshot.limits.toolCallsLimit),
    runtime:
      running && usage?.elapsedMs !== undefined
        ? formatDuration(usage.elapsedMs)
        : t('status.noUsage'),
    maxRuntime:
      snapshot.limits.maxRuntimeSeconds !== undefined
        ? formatDuration(snapshot.limits.maxRuntimeSeconds * 1000)
        : t('limits.unbounded'),
  });
  const budgetValue = t('status.budgetValue', {
    input: usedValue(running, usage?.promptTokens),
    maxInput: limitMax(snapshot.limits.inputTokensLimit),
    output: usedValue(running, usage?.completionTokens),
    maxOutput: limitMax(snapshot.limits.outputTokensLimit),
    context: groupNumber(snapshot.context.used),
    maxContext: groupNumber(snapshot.context.max),
    cost: running
      ? usage?.totalCost !== undefined
        ? formatCost(usage.totalCost)
        : t('limits.unknown')
      : t('status.noUsage'),
    maxCost:
      snapshot.limits.totalCostLimit !== undefined
        ? formatCost(snapshot.limits.totalCostLimit)
        : t('limits.unbounded'),
  });

  const tools = truncateList(snapshot.permissions.autoApprove, 48);
  const permissionsValue =
    tools.length > 0
      ? t('status.permissionsValue', {
          auto: snapshot.permissions.autoApprove.length,
          tools,
          pending: snapshot.permissions.pending,
        })
      : t('status.permissionsValueNoTools', {
          auto: snapshot.permissions.autoApprove.length,
          pending: snapshot.permissions.pending,
        });

  const instanceParts = [
    snapshot.instance.version !== undefined
      ? t('status.version', { version: snapshot.instance.version })
      : undefined,
    t('status.instanceTenant', { tenant: snapshot.instance.tenantId }),
    t('status.pid', { pid: snapshot.instance.pid }),
    t('status.uptime', { uptime: formatDuration(snapshot.instance.uptimeMs) }),
    snapshot.instance.rpc ? t('status.rpc') : t('status.embedded'),
  ].filter((part): part is string => part !== undefined);

  return [
    '',
    t('status.header', { time: formatSnapshotTime(snapshot.asOf) }),
    line(t('status.label.run'), runValue),
    line(t('status.label.session'), snapshot.sessionId),
    line(
      t('status.label.provider'),
      `${snapshot.provider.name} · ${snapshot.provider.model} · ${snapshot.provider.baseUrl}`,
    ),
    line(t('status.label.context'), contextValue),
    line(t('status.label.limits'), limitsValue),
    line(t('status.label.budget'), budgetValue),
    // 0.29：会话级缓存命中。idle 时 budget 全是 `-`，这一行仍然有值。
    line(t('status.label.cache'), formatCacheSummary(snapshot.cache)),
    ...(snapshot.limitBlock !== undefined
      ? [`  ${t('status.limitBlocked', { value: formatLimitBlock(snapshot.limitBlock) })}`]
      : []),
    line(t('status.label.permissions'), permissionsValue),
    line(t('status.label.queue'), t('status.queueValue', { count: snapshot.queue.input })),
    line(t('status.label.instance'), instanceParts.join(' · ')),
    line(
      t('status.label.agentQueue'),
      t('status.agentQueueValue', {
        queued: snapshot.agentQueue.queued,
        running: snapshot.agentQueue.running,
      }),
    ),
    ...snapshot.agentQueue.entries.map((entry) =>
      continuation(
        t('status.agentQueueEntry', {
          id: entry.id,
          position: entry.position ?? t('limits.unknown'),
          reason: entry.waitReason ?? t('limits.unknown'),
        }),
      ),
    ),
    ...snapshot.limitWarnings.map(
      (warning) => `  ${t('status.limitWarning', { value: formatLimitWarning(warning) })}`,
    ),
    ...(snapshot.lastCompaction !== undefined
      ? [
          line(
            t('status.label.compaction'),
            t('status.compactionValue', {
              removed:
                snapshot.lastCompaction.removed !== undefined
                  ? groupNumber(snapshot.lastCompaction.removed)
                  : t('limits.unknown'),
              remaining:
                snapshot.lastCompaction.remaining !== undefined
                  ? groupNumber(snapshot.lastCompaction.remaining)
                  : t('limits.unknown'),
              reason: snapshot.lastCompaction.reason ?? t('limits.unknown'),
            }),
          ),
        ]
      : []),
    '',
  ].join('\n');
}
