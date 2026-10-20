/**
 * Trace 留存与 prune（0.5 F2 / DECISION-010 §2.2、E9）
 *
 * - 不删除 running / interrupted run（有 RunStore 用状态；否则看 trace 是否有终态事件）
 * - retentionDays / maxRuns / maxBytes 可组合
 * - 只 unlink 本目录的 `.jsonl`，不触碰 tenant 其它目录
 *
 * @module @vessel-agent/core/observability
 */

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunEvent } from '../types/event.js';
import type { RunStore } from '../types/run-store.js';
import { parseTraceText } from './read-trace.js';

const DAY_MS = 86_400_000;
const TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled']);

/** prune 选项 */
export interface PruneTraceOptions {
  /** 按最后事件 ts 的天数 */
  retentionDays?: number;
  /** 保留最新 N 个可删 run */
  maxRuns?: number;
  /** 每 tenant 字节上限；0 = 不限 */
  maxBytes?: number;
  /** 状态权威；未提供时按 trace 是否含终态事件判定 */
  runStore?: RunStore;
  now?: number;
}

/** prune 结果（A-4 §11.3 冻结形状） */
export interface PruneTraceResult {
  deleted_runs: number;
  kept_runs: number;
  deleted_bytes: number;
}

interface TraceFileInfo {
  runId: string;
  path: string;
  size: number;
  lastTs: number;
  terminal: boolean;
}

function compareOldestFirst(a: TraceFileInfo, b: TraceFileInfo): number {
  if (a.lastTs !== b.lastTs) return a.lastTs - b.lastTs;
  if (a.runId === b.runId) return 0;
  return a.runId < b.runId ? -1 : 1;
}

function compareNewestFirst(a: TraceFileInfo, b: TraceFileInfo): number {
  return compareOldestFirst(b, a);
}

async function inspectFile(traceDir: string, entry: string): Promise<TraceFileInfo | null> {
  const raw = entry.slice(0, -'.jsonl'.length);
  let runId = raw;
  try {
    runId = decodeURIComponent(raw);
  } catch {
    // 非法编码按原文件名
  }

  const path = join(traceDir, entry);
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }

  let events: RunEvent[] = [];
  try {
    events = parseTraceText(await readFile(path, 'utf8'));
  } catch {
    // 不可读按空 trace 处理
  }

  return {
    runId,
    path,
    size,
    lastTs: events.reduce((max, event) => Math.max(max, event.ts), 0),
    terminal: events.some((event) => TERMINAL_EVENTS.has(event.type)),
  };
}

async function isProtected(file: TraceFileInfo, runStore?: RunStore): Promise<boolean> {
  if (runStore) {
    try {
      const checkpoint = await runStore.load(file.runId);
      if (checkpoint) {
        return checkpoint.status === 'running' || checkpoint.status === 'interrupted';
      }
    } catch {
      // 状态不可读时回退到 trace 终态判定
    }
  }
  return !file.terminal;
}

/** 按天数 / 条数 / 字节数清理 trace 文件 */
export async function pruneTrace(
  traceDir: string,
  options: PruneTraceOptions = {},
): Promise<PruneTraceResult> {
  let entries: string[];
  try {
    entries = await readdir(traceDir);
  } catch {
    return { deleted_runs: 0, kept_runs: 0, deleted_bytes: 0 };
  }

  const files: TraceFileInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl') || entry.startsWith('.')) continue;
    const info = await inspectFile(traceDir, entry);
    if (info) files.push(info);
  }

  if (files.length === 0) {
    return { deleted_runs: 0, kept_runs: 0, deleted_bytes: 0 };
  }

  const candidates: TraceFileInfo[] = [];
  for (const file of files) {
    if (!(await isProtected(file, options.runStore))) candidates.push(file);
  }

  const toDelete = new Set<string>();
  const now = options.now ?? Date.now();

  if (options.retentionDays !== undefined) {
    const days = Number.isFinite(options.retentionDays) ? Math.max(0, options.retentionDays) : 0;
    const cutoff = now - days * DAY_MS;
    for (const file of candidates) {
      if (file.lastTs > 0 && file.lastTs < cutoff) toDelete.add(file.path);
    }
  }

  if (options.maxRuns !== undefined) {
    const keep = Number.isFinite(options.maxRuns) ? Math.max(0, Math.floor(options.maxRuns)) : 0;
    for (const file of [...candidates].sort(compareNewestFirst).slice(keep)) {
      toDelete.add(file.path);
    }
  }

  if (options.maxBytes !== undefined && options.maxBytes > 0) {
    let total = files.reduce((sum, file) => sum + file.size, 0);
    const remaining = candidates
      .filter((file) => !toDelete.has(file.path))
      .sort(compareOldestFirst);
    for (const file of remaining) {
      if (total <= options.maxBytes) break;
      toDelete.add(file.path);
      total -= file.size;
    }
  }

  let deletedRuns = 0;
  let deletedBytes = 0;
  for (const file of files) {
    if (!toDelete.has(file.path)) continue;
    try {
      await unlink(file.path);
      deletedRuns += 1;
      deletedBytes += file.size;
    } catch {
      // 删除失败保留文件，不计入
    }
  }

  return {
    deleted_runs: deletedRuns,
    kept_runs: files.length - deletedRuns,
    deleted_bytes: deletedBytes,
  };
}
