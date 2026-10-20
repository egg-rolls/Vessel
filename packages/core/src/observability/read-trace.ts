/**
 * Trace 读取（0.5 F2 / Addendum A-3 §10.3）
 *
 * 只读；跳过损坏行；按 `(seq ?? ts)` 升序。供 `events.list` 与
 * `rebuildMetrics` / `pruneTrace` 共用。
 *
 * @module @vessel-agent/core/observability
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunEvent } from '../types/event.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** events.list 过滤参数（A-3 §10.3 冻结） */
export interface ReadTraceOptions {
  run_id?: string;
  /** 同一 run 内 seq > since_seq */
  since_seq?: number;
  /** event.ts >= since_ts */
  since_ts?: number;
  /** 精确匹配 */
  types?: string[];
  /** 前缀匹配；与 types 互斥 */
  type_prefix?: string;
  /** 默认 50，最大 500 */
  limit?: number;
}

/** 轻量结构校验 */
export function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.type === 'string' &&
    typeof record.run_id === 'string' &&
    typeof record.ts === 'number'
  );
}

/** 解析 JSONL 文本；损坏行跳过 */
export function parseTraceText(text: string): RunEvent[] {
  const events: RunEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRunEvent(parsed)) events.push(parsed);
    } catch {
      // 损坏行跳过，不阻塞前序事件
    }
  }
  return events;
}

function resolveLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 0), MAX_LIMIT);
}

function sortKey(event: RunEvent): number {
  return typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : event.ts;
}

function compare(a: RunEvent, b: RunEvent): number {
  const keyDiff = sortKey(a) - sortKey(b);
  if (keyDiff !== 0) return keyDiff;
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.run_id === b.run_id) return 0;
  return a.run_id < b.run_id ? -1 : 1;
}

/** 列出 trace 目录下的 run 文件名（解码 run_id） */
export async function listTraceRuns(traceDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(traceDir);
  } catch {
    return [];
  }

  const runIds: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl') || entry.startsWith('.')) continue;
    const raw = entry.slice(0, -'.jsonl'.length);
    if (raw === '') continue;
    try {
      runIds.push(decodeURIComponent(raw));
    } catch {
      runIds.push(raw);
    }
  }
  return runIds;
}

/** trace 文件路径 */
export function traceFilePath(traceDir: string, runId: string): string {
  return join(traceDir, `${encodeURIComponent(runId)}.jsonl`);
}

/** 读取某 run 的全部事件（内部用，不做过滤/排序之外的裁剪） */
export async function readRunTrace(traceDir: string, runId: string): Promise<RunEvent[]> {
  try {
    return parseTraceText(await readFile(traceFilePath(traceDir, runId), 'utf8'));
  } catch {
    return [];
  }
}

/**
 * 按 A-3 §10.3 过滤读取 trace。
 *
 * - 损坏行跳过；
 * - `since_seq` 只对带 seq 的事件生效；
 * - 结果按 `(seq ?? ts)` 升序，`limit` 默认 50 / 最大 500；
 * - `types` 与 `type_prefix` 同时给出 → 抛 `invalid_params`。
 */
export async function readTraceEvents(
  traceDir: string,
  options: ReadTraceOptions = {},
): Promise<RunEvent[]> {
  if (options.types !== undefined && options.type_prefix !== undefined) {
    throw new Error('invalid_params: types and type_prefix are mutually exclusive');
  }

  const limit = resolveLimit(options.limit);
  if (limit === 0) return [];

  const runIds = options.run_id !== undefined ? [options.run_id] : await listTraceRuns(traceDir);

  const matched: RunEvent[] = [];
  for (const runId of runIds) {
    const events = await readRunTrace(traceDir, runId);
    for (const event of events) {
      if (event.run_id !== runId) continue;
      if (options.since_seq !== undefined) {
        if (typeof event.seq !== 'number' || event.seq <= options.since_seq) continue;
      }
      if (options.since_ts !== undefined && event.ts < options.since_ts) continue;
      if (options.types !== undefined && !options.types.includes(event.type)) continue;
      if (options.type_prefix !== undefined && !event.type.startsWith(options.type_prefix)) {
        continue;
      }
      matched.push(event);
    }
  }

  matched.sort(compare);
  return matched.slice(0, limit);
}
