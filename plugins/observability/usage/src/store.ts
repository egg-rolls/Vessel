/**
 * Persisted event reader for the Usage plugin.
 *
 * Source of truth is the trace written by the host in the single root layout:
 * `<dataDir>/events/<run>.jsonl`. 0.49 T5 removed the pre-migration legacy
 * layout (`<dataDir>/tenants/<tenant>/events/<run>.jsonl`); this module no
 * longer reads it. This module is read-only; it never creates, appends, or
 * deletes files.
 *
 * Reading is **incremental**. A live run appends to its trace file every turn,
 * so re-reading whole files on every RPC (the 0.50 behaviour) got slower the
 * longer the log lived: the reference events directory is past 1 GiB with
 * single files up to ~90 MB, and one page open re-read and re-parsed all of it.
 * Each cached file now remembers the byte offset just past the last *complete*
 * line it consumed, and a later call reads only `[offset, size)`:
 *
 * - every line is parsed exactly once. The offset only ever advances to the end
 *   of a complete line, so no line is parsed twice and no half line is parsed;
 * - a trailing partial line (writer mid-append) is left on disk and re-read on
 *   the next call. Nothing is buffered, so nothing can be lost or duplicated;
 * - a file that shrank (`size < cached size`) was truncated or rotated: its
 *   entry is dropped and the file is read from the top again;
 * - a file that vanished (`trace.prune`) drops its entry;
 * - an unchanged cached file costs **zero bytes and zero parse** — that is the
 *   steady state for a re-render, pagination, or a second tab.
 *
 * One call is bounded by a byte budget and a file budget (constants below):
 * files are visited newest-mtime first so the budget lands on the runs a user
 * is looking at, and a call that runs out reports `truncated: true` together
 * with how many run files it did cover. Visit order never changes an aggregate
 * (they are summed per `ts`); it only decides which runs fit the window.
 *
 * Corrupt lines and unreadable files are skipped, matching `readTraceEvents` in
 * core.
 *
 * @module @vessel-agent/plugin-usage
 */

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveSingleTenantPaths } from '@vessel-agent/core';

/** Settings handed to the plugin in `plugin.activate`. */
export interface Settings {
  /** Model id -> USD per 1M tokens. */
  prices: Record<string, Price>;
  /**
   * 兜底模型名：只在事件本身没带 `model` 时使用（旧 trace / 极少数手工构造的事件）。
   * 事件里带的才是请求**实际用的**模型，优先级高于这里 —— 配了本字段不会掩盖真实模型。
   */
  default_model?: string;
}

/** One model's price table. All rates are USD per 1M tokens. */
export interface Price {
  input_per_1m: number;
  output_per_1m: number;
  cache_read_per_1m: number;
  cache_write_per_1m: number;
}

/** A parsed line from a persisted event log. */
export interface RawEvent {
  type: string;
  ts: number;
  run_id: string;
  /** 1-based line number inside the file; used when `seq` is missing. */
  line: number;
  seq?: number;
  data: Record<string, unknown>;
}

/**
 * Outcome of one `loadEvents()` call.
 *
 * `truncated` means the events are an *incomplete* view of `<dataDir>/events`:
 * older run files fell outside the read window, or a covered file could only be
 * read partially (its head dropped, its tail not reached, or its oldest events
 * trimmed). Callers must surface it — a total that silently covers 3 of 600
 * runs is a lie otherwise.
 */
export interface LoadResult {
  /** Parsed usage events, newest file first. */
  events: RawEvent[];
  /** The events do not cover every trace file on disk. */
  truncated: boolean;
  /** Trace files present in `<dataDir>/events`. */
  files_total: number;
  /** Trace files this call covered (a newest-first prefix). */
  files_covered: number;
  /** Bytes actually read from disk by this call. */
  bytes_read: number;
}

/**
 * Event types this plugin folds into usage records (`buildRecords` reads no
 * other type). Everything else on the trace — `context.changed`, `hook.*`,
 * `tool.call.*`, `run.checkpoint` — is dropped while parsing: those lines are
 * the bulk of a trace (one `context.changed` can carry a whole prompt, and
 * lines up to ~180 KB were measured), and keeping them only inflates memory.
 * The set mirrors `vessel.contributes.events` in this plugin's package.json.
 */
export const USAGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'llm.request',
  'llm.response',
  'run.failed',
]);

/**
 * Read budget and retention caps.
 *
 * `maxBytesPerCall` (16 MiB) is the whole I/O a single RPC may do. The reference
 * directory is ~1.09 GiB / 210k lines; reading it whole measured 6.3 s (and
 * 14.9 s once the file cache was cold), while a 16 MiB first call measured
 * ~0.37 s and covered 49 of 614 run files (1.7k events). 16 MiB is the top of
 * the 8–16 MiB range because trace lines are large in practice — `llm.request`
 * averages ~7.7 KB and one `context.changed` can be 180 KB — so a smaller cap
 * would cover only a handful of runs while saving a fraction of that time.
 *
 * `maxBytesPerFile` (2 MiB) is what a single trace file may contribute per
 * call, so one outsized run cannot eat the whole window; a bigger file is read
 * from its newest 2 MiB (head dropped, flagged as partial). Subsequent appends
 * to it are still read incrementally, so only pre-existing history is lost.
 *
 * `maxFilesPerCall` (256) bounds per-call `stat`/parse bookkeeping for
 * directories made of thousands of tiny traces.
 *
 * `maxRetainedBytesPerFile` (4 MiB) and `maxRetainedBytesTotal` (32 MiB) bound
 * memory. A window is billed at most 16 MiB of file bytes, so in steady state
 * the cache holds ~that much; 32 MiB leaves room for the appended growth of a
 * long-running trace before whole files are evicted LRU-style. Retained bytes
 * are raw trace bytes (the parsed objects are roughly 2–3× that), so the cache
 * is estimable instead of growing with the number of runs on disk. Non-usage
 * event types are not retained at all (see `USAGE_EVENT_TYPES`).
 */
export interface ReadLimits {
  maxBytesPerCall: number;
  maxBytesPerFile: number;
  maxFilesPerCall: number;
  maxRetainedBytesPerFile: number;
  maxRetainedBytesTotal: number;
  maxCachedFiles: number;
}

export const DEFAULT_LIMITS: ReadLimits = {
  maxBytesPerCall: 16 * 1024 * 1024,
  maxBytesPerFile: 2 * 1024 * 1024,
  maxFilesPerCall: 256,
  maxRetainedBytesPerFile: 4 * 1024 * 1024,
  maxRetainedBytesTotal: 32 * 1024 * 1024,
  maxCachedFiles: 256,
};

/** One trace file as listed on disk in a single call. */
interface FileInfo {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

/** A retained event plus the trace bytes it was parsed from (memory accounting). */
interface CachedEvent {
  event: RawEvent;
  bytes: number;
}

/**
 * Per-file cursor. `offset` is the byte position just past the last complete
 * line consumed; `size` is the file size that offset was derived from. There is
 * deliberately no buffered tail: the partial line stays on disk and is re-read
 * (a few hundred bytes at most) instead of being held here.
 */
interface CachedFile {
  size: number;
  offset: number;
  events: CachedEvent[];
  /** Sum of `CachedEvent.bytes`. */
  retained: number;
  /** Complete lines consumed so far; feeds `RawEvent.line`. */
  line: number;
  /** The retained events are an incomplete view of this file. */
  partial: boolean;
  /** LRU stamp. */
  usedAt: number;
}

interface ParsedSettings {
  ok: boolean;
  settings: Settings;
  error?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parsePrice(model: string, value: unknown): Price | string {
  if (!isRecord(value)) return `prices.${model} must be an object`;
  const input = value.input_per_1m;
  const output = value.output_per_1m;
  const cacheRead = value.cache_read_per_1m;
  const cacheWrite = value.cache_write_per_1m;
  if (!finiteNonNegative(input)) {
    return `prices.${model}.input_per_1m must be a non-negative number`;
  }
  if (!finiteNonNegative(output)) {
    return `prices.${model}.output_per_1m must be a non-negative number`;
  }
  if (!finiteNonNegative(cacheRead)) {
    return `prices.${model}.cache_read_per_1m must be a non-negative number`;
  }
  if (!finiteNonNegative(cacheWrite)) {
    return `prices.${model}.cache_write_per_1m must be a non-negative number`;
  }
  return {
    input_per_1m: input,
    output_per_1m: output,
    cache_read_per_1m: cacheRead,
    cache_write_per_1m: cacheWrite,
  };
}

/**
 * Validate `plugin.activate.settings`.
 *
 * Fail-closed: a malformed `prices` table rejects activation instead of
 * silently rendering a cost that the user did not configure. Absent settings
 * are valid and yield an empty price table.
 */
export function parseSettings(raw: unknown): ParsedSettings {
  if (raw === undefined || raw === null) return { ok: true, settings: { prices: {} } };
  if (!isRecord(raw))
    return { ok: false, settings: { prices: {} }, error: 'settings must be an object' };

  const prices: Record<string, Price> = {};
  if (raw.prices !== undefined) {
    if (!isRecord(raw.prices)) {
      return { ok: false, settings: { prices: {} }, error: 'prices must be an object' };
    }
    for (const [model, value] of Object.entries(raw.prices)) {
      if (model.length === 0) {
        return { ok: false, settings: { prices: {} }, error: 'prices keys must be non-empty' };
      }
      const price = parsePrice(model, value);
      if (typeof price === 'string') {
        return { ok: false, settings: { prices: {} }, error: price };
      }
      prices[model] = price;
    }
  }

  let defaultModel: string | undefined;
  if (raw.default_model !== undefined) {
    if (typeof raw.default_model !== 'string' || raw.default_model.length === 0) {
      return {
        ok: false,
        settings: { prices: {} },
        error: 'default_model must be a non-empty string',
      };
    }
    defaultModel = raw.default_model;
  }

  return {
    ok: true,
    settings: {
      prices,
      ...(defaultModel !== undefined ? { default_model: defaultModel } : {}),
    },
  };
}

function parseLine(line: string, lineNumber: number): RawEvent | undefined {
  if (line.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (typeof parsed.type !== 'string' || parsed.type.length === 0) return undefined;
  if (typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) return undefined;

  const data = isRecord(parsed.data) ? parsed.data : {};
  const runId =
    typeof parsed.run_id === 'string' && parsed.run_id.length > 0
      ? parsed.run_id
      : typeof data.run_id === 'string' && data.run_id.length > 0
        ? data.run_id
        : undefined;
  if (runId === undefined) return undefined;

  const seq =
    typeof parsed.seq === 'number' && Number.isFinite(parsed.seq) ? parsed.seq : undefined;
  return {
    type: parsed.type,
    ts: parsed.ts,
    run_id: runId,
    line: lineNumber,
    ...(seq !== undefined ? { seq } : {}),
    data,
  };
}

const NEWLINE = 0x0a;

/** How many trace files one `loadEvents()` stats at a time. */
const STAT_BATCH = 32;

/** Read up to `length` bytes at `start`; always returns what the file actually had. */
async function readRange(path: string, start: number, length: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    return filled === length ? buffer : buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

function emptyResult(filesTotal = 0): LoadResult {
  return { events: [], truncated: false, files_total: filesTotal, files_covered: 0, bytes_read: 0 };
}

/**
 * Read-only event store with an incremental, byte-budgeted reader.
 *
 * One instance per activation; the cache is dropped when the host activates the
 * plugin in a different data directory. Limits are injectable so the probe can
 * exercise the budget paths without writing 16 MiB of fixtures.
 */
export class EventStore {
  private readonly cache = new Map<string, CachedFile>();
  private readonly limits: ReadLimits;
  private clock = 0;

  constructor(limits: ReadLimits = DEFAULT_LIMITS) {
    this.limits = limits;
  }

  /** Drop cached files (called on activate/deactivate). */
  reset(): void {
    this.cache.clear();
  }

  /** Load events from the root `<dataDir>/events/*.jsonl` files (read-only). */
  async loadEvents(dataDir: string): Promise<LoadResult> {
    const dir = resolveSingleTenantPaths(dataDir).events_dir;
    const files = await this.list(dir);
    if (files.length === 0) {
      this.cache.clear();
      return emptyResult();
    }

    // Newest first: the budget must land on the runs the user is looking at.
    // A file is billed by `min(size, maxBytesPerFile)` — the part of it any call
    // can ever read — so the window is a function of what is on disk rather than
    // of what happens to be cached. That keeps two calls on an unchanged
    // directory identical instead of each one silently widening the window.
    const window: FileInfo[] = [];
    let billed = 0;
    for (const file of files) {
      if (window.length >= this.limits.maxFilesPerCall) break;
      const cost = Math.min(file.size, this.limits.maxBytesPerFile);
      if (billed + cost > this.limits.maxBytesPerCall) break;
      window.push(file);
      billed += cost;
    }

    // Anything not in the window leaves the cache: a pruned file is gone, and an
    // out-of-window file would only sit in memory until LRU drops it.
    const covered = new Set(window.map((file) => file.path));
    for (const path of [...this.cache.keys()]) {
      if (!covered.has(path)) this.cache.delete(path);
    }

    // Second budget, on bytes actually read: a window can only exceed the
    // billing above when files grew since the previous call, and that growth
    // must not become an unbounded read.
    let bytesRead = 0;
    for (const file of window) {
      const budget = this.limits.maxBytesPerCall - bytesRead;
      if (budget <= 0) break;
      bytesRead += await this.refresh(file, budget);
    }

    this.evict();

    let truncated = window.length < files.length;
    const events: RawEvent[] = [];
    for (const file of window) {
      const entry = this.cache.get(file.path);
      if (entry === undefined) {
        // Unreadable this call (vanished, locked): the view is incomplete.
        truncated = true;
        continue;
      }
      if (entry.partial) truncated = true;
      for (const cached of entry.events) events.push(cached.event);
    }
    return {
      events,
      truncated,
      files_total: files.length,
      files_covered: window.length,
      bytes_read: bytesRead,
    };
  }

  /**
   * Bring one file up to date and return the bytes read from disk.
   *
   * Zero bytes for an unchanged file is the whole point of the cache: the trace
   * files are append-only, so an unchanged size means there is no new byte, and
   * an mtime bump alone cannot have added a line (a same-size rewrite is not
   * something the trace writer does).
   */
  private async refresh(file: FileInfo, budget: number): Promise<number> {
    const cached = this.cache.get(file.path);
    if (cached !== undefined) {
      if (file.size < cached.size) {
        // Truncate/rotate: the offset points past the end, read from the top.
        this.cache.delete(file.path);
      } else {
        cached.usedAt = ++this.clock;
        if (file.size === cached.size) return 0;
      }
    }

    const entry = this.cache.get(file.path);
    const limit = Math.max(1, Math.min(this.limits.maxBytesPerFile, budget));
    // A fresh, outsized file is read from its newest bytes; the extra byte lets
    // us tell "window starts right after a newline" from "window cuts a line".
    const start = entry === undefined ? Math.max(0, file.size - limit - 1) : entry.offset;
    const want = Math.min(file.size - start, limit + 1);
    if (want <= 0) return 0;

    let buffer: Buffer;
    try {
      buffer = await readRange(file.path, start, want);
    } catch {
      this.cache.delete(file.path);
      return 0;
    }
    if (buffer.length === 0) return 0;

    let body = buffer;
    let dropped = 0;
    if (entry === undefined && start > 0) {
      const newline = body.indexOf(NEWLINE);
      if (newline === -1) {
        // No complete line in the window (a single line bigger than the cap):
        // skip to the end and remember that this file is only partially seen.
        dropped = body.length;
        body = body.subarray(body.length);
      } else {
        dropped = newline + 1;
        body = body.subarray(dropped);
      }
    }

    const target: CachedFile = entry ?? {
      size: file.size,
      offset: 0,
      events: [],
      retained: 0,
      line: 0,
      partial: false,
      usedAt: 0,
    };
    if (entry === undefined) target.partial = start > 0;

    let cursor = 0;
    for (;;) {
      const newline = body.indexOf(NEWLINE, cursor);
      if (newline === -1) break;
      const raw = body.subarray(cursor, newline);
      cursor = newline + 1;
      target.line += 1;
      // `parseLine` gets the whole line (including a trailing '\r', which JSON
      // tolerates) so numbering matches the pre-incremental reader.
      const event = parseLine(raw.toString('utf8'), target.line);
      if (event !== undefined && USAGE_EVENT_TYPES.has(event.type)) {
        target.events.push({ event, bytes: raw.length });
        target.retained += raw.length;
      }
    }

    target.size = start + buffer.length;
    // `offset` only ever lands on a line boundary; the bytes after it are an
    // unfinished line that the next call re-reads from disk.
    target.offset = start + dropped + cursor;
    // The read stopped at the per-file cap, so complete lines are still unread.
    if (start + buffer.length < file.size) {
      target.partial = true;
      if (cursor === 0 && dropped === 0) {
        // Not a single newline in the whole read: one line is longer than the
        // per-file cap. Re-reading the same window forever would make no
        // progress, so skip past it; the rest of that line is dropped like any
        // other corrupt line.
        target.offset = start + buffer.length;
      }
    }

    // Sliding window per file: a run that keeps appending forever must not grow
    // the cache forever. Dropping the oldest events of that file costs nothing
    // on disk (they are behind `offset`) but makes the file's view partial.
    while (target.retained > this.limits.maxRetainedBytesPerFile && target.events.length > 1) {
      const oldest = target.events.shift();
      if (oldest === undefined) break;
      target.retained -= oldest.bytes;
      target.partial = true;
    }

    target.usedAt = ++this.clock;
    this.cache.set(file.path, target);
    return buffer.length;
  }

  /** Enforce the cache caps by evicting whole files, least recently used first. */
  private evict(): void {
    let retained = 0;
    for (const entry of this.cache.values()) retained += entry.retained;
    if (
      this.cache.size <= this.limits.maxCachedFiles &&
      retained <= this.limits.maxRetainedBytesTotal
    ) {
      return;
    }
    // Cost of an eviction is a full re-read of that file on a later call.
    const byAge = [...this.cache.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [path, entry] of byAge) {
      if (
        this.cache.size <= this.limits.maxCachedFiles &&
        retained <= this.limits.maxRetainedBytesTotal
      ) {
        break;
      }
      this.cache.delete(path);
      retained -= entry.retained;
    }
  }

  /** List `<dir>/*.jsonl`, newest mtime first (name as a stable tie-break). */
  private async list(dir: string): Promise<FileInfo[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }

    const candidates = names.filter((name) => name.endsWith('.jsonl') && !name.startsWith('.'));
    const files: FileInfo[] = [];
    // One `stat` per file is the dominant cost of a warm call on Windows
    // (~0.3 ms each over 600 files), so walk the list in small parallel batches
    // instead of awaiting one file at a time.
    for (let index = 0; index < candidates.length; index += STAT_BATCH) {
      const batch = candidates.slice(index, index + STAT_BATCH);
      const infos = await Promise.all(
        batch.map(async (name): Promise<FileInfo | undefined> => {
          const path = join(dir, name);
          try {
            const info = await stat(path);
            if (!info.isFile()) return undefined;
            return { path, name, size: info.size, mtimeMs: info.mtimeMs };
          } catch {
            // Deleted between readdir and stat: forget it.
            this.cache.delete(path);
            return undefined;
          }
        }),
      );
      for (const info of infos) if (info !== undefined) files.push(info);
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
    return files;
  }
}
