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

/** 与 config / core 一致的默认上下文预算（ADR-064） */
const DEFAULT_CONTEXT_MAX_TOKENS = 1_000_000;
const LABEL_WIDTH = 12;

export interface StatusRun {
  state: 'idle' | 'running';
  runId?: string;
  sessionId?: string;
  startedAt?: number;
}

export interface StatusSnapshot {
  asOf: number;
  run: StatusRun;
  sessionId: string;
  provider: { name: string; model: string; baseUrl: string };
  context: { used: number; max: number; messages: number };
  permissions: { autoApprove: string[]; pending: number };
  queue: { input: number };
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

/** 折叠事件历史：最后一个没有终态的顶层 run。子 agent 事件（subagent.*）不参与。 */
export function findActiveRun(events: RunEvent[]): StatusRun {
  let active: StatusRun = { state: 'idle' };
  for (const event of events) {
    if (event.type.startsWith('subagent.')) continue;
    if (event.type === 'run.started' || event.type === 'run.resumed') {
      const data = dataOf(event);
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

  return {
    asOf: now,
    run: findActiveRun(events),
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
    permissions: {
      autoApprove: [...autoApprove],
      pending: countPendingPermissions(events),
    },
    queue: {
      input: state.queuedCount ?? 0,
    },
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

function truncateList(values: string[], maxWidth: number): string {
  const joined = values.join(', ');
  return joined.length <= maxWidth ? joined : `${joined.slice(0, Math.max(0, maxWidth - 1))}…`;
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
    line(t('status.label.permissions'), permissionsValue),
    line(t('status.label.queue'), t('status.queueValue', { count: snapshot.queue.input })),
    line(t('status.label.instance'), instanceParts.join(' · ')),
    '',
  ].join('\n');
}
