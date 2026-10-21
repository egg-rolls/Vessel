/**
 * Diagnostics 纯函数：错误事件筛选 / 分类 / 摘要与 runtime 队列行。
 *
 * 默认只展示 run/tool/agent 级错误；`ui.errorLevel: all` 或
 * `observability.showProcessErrors: true` 才包含 process/shutdown/hook/plugin。
 */
import type { RunEvent, RuntimeHealth, SchedulerRunSummary } from '../gateway/types';
import type { ErrorVisibility } from './error-visibility';

export type DiagnosticCategory =
  | 'process'
  | 'shutdown'
  | 'hook'
  | 'plugin'
  | 'run'
  | 'tool'
  | 'agent';

export interface DiagnosticGate {
  errorLevel: ErrorVisibility;
  showProcessErrors: boolean;
}

export const USER_ERROR_TYPES = ['run.failed', 'tool.call.failed', 'agent.run.failed'] as const;

export const DIAGNOSTIC_ERROR_TYPES = [
  'process.error',
  'shutdown.failed',
  'hook.error',
  'hook.failed',
  'plugin.error',
  'plugin.failed',
  'plugin.init.failed',
  'plugin.dispose.failed',
  'mcp.warning',
] as const;

export const DIAGNOSTIC_EVENT_TYPES: readonly string[] = [
  ...USER_ERROR_TYPES,
  ...DIAGNOSTIC_ERROR_TYPES,
];

export function includesDiagnostics(gate: DiagnosticGate): boolean {
  return gate.errorLevel === 'all' || gate.showProcessErrors;
}

export function diagnosticCategoryOf(type: string): DiagnosticCategory {
  if (type.startsWith('process.')) return 'process';
  if (type.startsWith('shutdown.')) return 'shutdown';
  if (type.startsWith('hook.')) return 'hook';
  if (type.startsWith('plugin.') || type.startsWith('mcp.')) return 'plugin';
  if (type.startsWith('tool.')) return 'tool';
  if (type.startsWith('agent.')) return 'agent';
  return 'run';
}

export interface DiagnosticEntry {
  type: string;
  ts: number;
  run_id: string;
  category: DiagnosticCategory;
  message?: string;
  errorCode?: string;
  phase?: string;
  retryable?: boolean;
  httpStatus?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 只保留可展示字段；不带 stack / prompt。 */
export function summarizeDiagnosticEvent(event: RunEvent): DiagnosticEntry {
  const data = isRecord(event.data) ? event.data : {};
  const httpStatus = data.http_status ?? data.httpStatus;
  return {
    type: event.type,
    ts: event.ts,
    run_id: event.run_id || '-',
    category: diagnosticCategoryOf(event.type),
    ...(textField(data, 'error') !== undefined ? { message: textField(data, 'error') } : {}),
    ...(textField(data, 'error_code') !== undefined
      ? { errorCode: textField(data, 'error_code') }
      : {}),
    ...(textField(data, 'phase') !== undefined ? { phase: textField(data, 'phase') } : {}),
    ...(typeof data.retryable === 'boolean' ? { retryable: data.retryable } : {}),
    ...(typeof httpStatus === 'number' && Number.isFinite(httpStatus) ? { httpStatus } : {}),
  };
}

/** 按 gate 过滤后，最新在前。 */
export function diagnosticEntries(
  events: readonly RunEvent[],
  gate: DiagnosticGate,
): DiagnosticEntry[] {
  const allowed = new Set<string>(
    includesDiagnostics(gate) ? DIAGNOSTIC_EVENT_TYPES : [...USER_ERROR_TYPES],
  );
  return events
    .filter((event) => allowed.has(event.type))
    .map(summarizeDiagnosticEvent)
    .sort((a, b) => b.ts - a.ts || (a.run_id < b.run_id ? 1 : a.run_id > b.run_id ? -1 : 0));
}

/** 队列面板行：queued 在前、running 在后（保持服务端顺序）。 */
export function runtimeQueueRows(runtime: RuntimeHealth | undefined): SchedulerRunSummary[] {
  if (!runtime) return [];
  return [...runtime.scheduler.queued, ...runtime.scheduler.running];
}
