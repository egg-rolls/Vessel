/**
 * Trace 留存与 prune（0.5 F2 / DECISION-010 §2.2、E9）
 *
 * - 不删除 running / interrupted run（有 RunRecordStore 用状态；否则看 trace 是否有终态事件）
 * - retentionDays / maxRuns / maxBytes 可组合
 * - 只 unlink 本目录的 `.jsonl`，不触碰 tenant 其它目录
 *
 * 快速路径（0.35 S4）：readdir + stat 预筛。retention 只看 mtime 可能过期的文件，
 * 无候选时零解析；maxRuns / maxBytes 超限时回退全量解析（旧语义）。
 *
 * @module @vessel-agent/core/observability
 */

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunEvent } from '../types/event.js';
import type { RunRecordStore } from '../types/run-record-store.js';
import { parseTraceText } from './read-trace.js';

const DAY_MS = 86_400_000;
const TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled']);
/** stat 有界并发；避免 Windows 上数百次串行 stat 变成新瓶颈 */
const STAT_CONCURRENCY = 32;

/** prune 选项 */
export interface PruneTraceOptions {
  /** 按最后事件 ts 的天数 */
  retentionDays?: number;
  /** 保留最新 N 个可删 run */
  maxRuns?: number;
  /** 每 tenant 字节上限；0 = 不限 */
  maxBytes?: number;
  /** 状态权威；未提供时按 trace 是否含终态事件判定 */
  runStore?: RunRecordStore;
  now?: number;
}

/** prune 结果（A-4 §11.3 冻结形状） */
export interface PruneTraceResult {
  deleted_runs: number;
  kept_runs: number;
  deleted_bytes: number;
}

interface TraceFileStat {
  runId: string;
  path: string;
  size: number;
  mtimeMs: number;
}

interface TraceFileInfo extends TraceFileStat {
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

function isTraceEntry(entry: string): boolean {
  return entry.endsWith('.jsonl') && !entry.startsWith('.');
}

async function statTraceFile(traceDir: string, entry: string): Promise<TraceFileStat | null> {
  const raw = entry.slice(0, -'.jsonl'.length);
  let runId = raw;
  try {
    runId = decodeURIComponent(raw);
  } catch {
    // 非法编码按原文件名
  }

  const path = join(traceDir, entry);
  try {
    const info = await stat(path);
    return { runId, path, size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

async function parseTraceFile(file: TraceFileStat): Promise<TraceFileInfo> {
  let events: RunEvent[] = [];
  try {
    events = parseTraceText(await readFile(file.path, 'utf8'));
  } catch {
    // 不可读按空 trace 处理
  }

  return {
    ...file,
    lastTs: events.reduce((max, event) => Math.max(max, event.ts), 0),
    terminal: events.some((event) => TERMINAL_EVENTS.has(event.type)),
  };
}

/** stat + 解析（回退全量路径用；与旧实现一致） */
async function inspectFile(traceDir: string, entry: string): Promise<TraceFileInfo | null> {
  const info = await statTraceFile(traceDir, entry);
  return info ? parseTraceFile(info) : null;
}

/** 有界并发 stat；保持 readdir 顺序 */
async function statTraceFiles(traceDir: string, entries: string[]): Promise<TraceFileStat[]> {
  const files: TraceFileStat[] = [];
  for (let start = 0; start < entries.length; start += STAT_CONCURRENCY) {
    const batch = entries.slice(start, start + STAT_CONCURRENCY);
    const infos = await Promise.all(
      batch.map((entry) => (isTraceEntry(entry) ? statTraceFile(traceDir, entry) : null)),
    );
    for (const info of infos) {
      if (info) files.push(info);
    }
  }
  return files;
}

async function isProtected(file: TraceFileInfo, runStore?: RunRecordStore): Promise<boolean> {
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

  const stats = await statTraceFiles(traceDir, entries);
  if (stats.length === 0) {
    return { deleted_runs: 0, kept_runs: 0, deleted_bytes: 0 };
  }

  const now = options.now ?? Date.now();
  const cutoff =
    options.retentionDays === undefined
      ? undefined
      : now -
        (Number.isFinite(options.retentionDays) ? Math.max(0, options.retentionDays) : 0) * DAY_MS;
  const keepRuns =
    options.maxRuns === undefined
      ? undefined
      : Number.isFinite(options.maxRuns)
        ? Math.max(0, Math.floor(options.maxRuns))
        : 0;
  const maxBytes = options.maxBytes;

  const totalBytes = stats.reduce((sum, file) => sum + file.size, 0);
  const fullScan =
    (keepRuns !== undefined && stats.length > keepRuns) ||
    (maxBytes !== undefined && maxBytes > 0 && totalBytes > maxBytes) ||
    // mtime 晚于 now（时钟漂移 / 固定 now 的夹具）时不能把 mtime 当作最后写入时间
    (cutoff !== undefined && stats.some((file) => file.mtimeMs > now));

  const toDelete = new Set<string>();
  let allFiles: TraceFileStat[] = stats;

  if (fullScan) {
    const files: TraceFileInfo[] = [];
    for (const entry of entries) {
      if (!isTraceEntry(entry)) continue;
      const info = await inspectFile(traceDir, entry);
      if (info) files.push(info);
    }
    if (files.length === 0) {
      return { deleted_runs: 0, kept_runs: 0, deleted_bytes: 0 };
    }
    allFiles = files;

    const candidates: TraceFileInfo[] = [];
    for (const file of files) {
      if (!(await isProtected(file, options.runStore))) candidates.push(file);
    }

    if (cutoff !== undefined) {
      for (const file of candidates) {
        if (file.lastTs > 0 && file.lastTs < cutoff) toDelete.add(file.path);
      }
    }

    if (keepRuns !== undefined) {
      for (const file of [...candidates].sort(compareNewestFirst).slice(keepRuns)) {
        toDelete.add(file.path);
      }
    }

    if (maxBytes !== undefined && maxBytes > 0) {
      let total = files.reduce((sum, file) => sum + file.size, 0);
      const remaining = candidates
        .filter((file) => !toDelete.has(file.path))
        .sort(compareOldestFirst);
      for (const file of remaining) {
        if (total <= maxBytes) break;
        toDelete.add(file.path);
        total -= file.size;
      }
    }
  } else if (cutoff !== undefined) {
    // 快速路径：mtime 预筛可能过期的文件，只解析候选；用真实 lastTs 复核
    const maybeExpired = stats.filter((file) => file.mtimeMs <= cutoff);
    for (const info of maybeExpired) {
      const file = await parseTraceFile(info);
      if (await isProtected(file, options.runStore)) continue;
      if (file.lastTs > 0 && file.lastTs < cutoff) toDelete.add(file.path);
    }
  }

  let deletedRuns = 0;
  let deletedBytes = 0;
  for (const file of allFiles) {
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
    kept_runs: allFiles.length - deletedRuns,
    deleted_bytes: deletedBytes,
  };
}
