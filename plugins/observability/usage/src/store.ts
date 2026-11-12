/**
 * Persisted event reader for the Usage plugin.
 *
 * Source of truth is the **session event log** the host writes per session:
 * `<dataDir>/sessions/<sessionId>/events.ndjson`. It replaced the per-run trace
 * (`<dataDir>/events/<run>.jsonl`) for usage: the trace carried every prompt,
 * tool payload and stream chunk (the reference directory was 1.09 GiB over 638
 * runs), while the session log keeps the same `llm.request` / `llm.response` /
 * `run.completed` / `run.failed` events for 124 MiB over 134 sessions. Usage is
 * therefore **not** computed from the trace any more: the two sources are not
 * merged, the trace simply stopped being a usage input.
 *
 * Reading is **incremental**. Both logs are append-only NDJSON: each file
 * remembers the byte offset just past the last *complete* line it consumed, and
 * a later call reads only `[offset, size)`:
 *
 * - every line is parsed exactly once. The offset only ever advances to the end
 *   of a complete line, so no line is parsed twice and no half line is parsed;
 * - a trailing partial line (writer mid-append) is left on disk and re-read on
 *   the next call. Nothing is buffered, so nothing can be lost or duplicated;
 * - a file that shrank (`size < cached size`) was truncated or rotated: its
 *   entry is dropped and the file is read from the top again;
 * - a file that vanished (session deleted) drops its entry;
 * - an unchanged cached file costs **zero bytes and zero parse** — that is the
 *   steady state for a re-render, pagination, or a second tab.
 *
 * Only the four event types usage needs are kept, and each is projected down to
 * the handful of fields the aggregate reads (`projectEventData`): a session log
 * stores message bodies, tool arguments and run output, none of which belong in
 * a usage record, and keeping them would re-inflate memory for nothing.
 *
 * The **day window** decides which files matter; the byte/file budgets are only
 * a safety valve *inside* it. `loadEvents(dir, { cutoff })` considers only the
 * session logs whose mtime is at or after `cutoff`, and then filters the events
 * themselves by `ts >= cutoff`. A session file is not a run file: a long session
 * spans days, so the file-level mtime test is only a coarse sieve — the
 * event-level filter (and, for `until`, `peekFirstTs`) is what makes the range
 * correct.
 *
 * Inside the window, files are visited newest-mtime first and one call is
 * bounded by a byte budget and a file budget (constants below). A call that runs
 * out of budget *within* the window reports `files_truncated: true` together
 * with how many files it did cover; a file that could only be read partially
 * (head dropped, oldest lines trimmed) is counted in `partial_files`. Visit
 * order never changes an aggregate (they are summed per `ts`); it only decides
 * which runs fit the window.
 *
 * The per-file cache is keyed by path and is therefore independent of the day
 * window: switching 7d -> 30d -> 7d re-reads an unchanged file **zero** times,
 * and cache entries are only dropped when the file disappears from disk.
 *
 * Corrupt lines and unreadable files are skipped, matching `readTraceEvents` in
 * core.
 *
 * @module @vessel-agent/plugin-usage
 */

import { type Dirent, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
 * One run's usage, aggregated from its request records.
 *
 * This is the shape the persistent index stores (`usage/index.ndjson`, one line
 * per run) and the shape `summary` / `leaderboard` aggregate over: run-level
 * totals are all those two pages need, and reading one small line per run beats
 * re-reading session logs. `logs` still works from the per-request records,
 * because a request row cannot be reconstructed from a run total.
 *
 * `ts_start` / `ts_end` are the first and last record of the run. A range filter
 * uses `ts_end` — the instant the run finished — so a run that straddles
 * midnight counts on the day it ended (see `filterRunsByDays` for why that is
 * the only day-bucketing a run-level index can do).
 */
export interface RunSummary {
  run_id: string;
  session_id?: string;
  model: string;
  ts_start: number;
  ts_end: number;
  /** Answered requests (`llm.response` records). */
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** Priced requests only; absent when nothing in the run had a price. */
  cost?: number;
  /** Requests in this run whose model has no configured price. */
  unpriced_requests: number;
  /** The run ended in `run.failed`. */
  status: 'ok' | 'failed';
}

/**
 * Which slice of the trace a call should look at.
 *
 * `cutoff` is the start of the selected range (`daysCutoff(now, days)`, or an
 * explicit `since`). Files older than it are not opened, and events older than it
 * are not returned, so the lower bound is enforced on event time rather than on
 * the read budget. Omitted means "no lower bound".
 *
 * `until` is the (exclusive) end of an explicit range. A file's mtime is after
 * all of its events, so mtime alone cannot exclude a file written after `until`;
 * instead the reader peeks each such file's **first line** and drops it when the
 * run provably starts at or after `until` (`dropAfterUntil`, `peekFirstTs` — a
 * real read of real bytes, not a heuristic). The remaining candidates are
 * visited from the one nearest `until` outwards, so the budget lands on the runs
 * around the end of the requested interval. The record-level `[since, until)`
 * filter lives in `listLogs` (`aggregate.ts`).
 *
 * Either bound makes the call "range-bounded", which is what selects the larger
 * window budget (see `WINDOW_BUDGET_BYTES`).
 */
export interface LoadOptions {
  cutoff?: number;
  until?: number;
}

/**
 * Outcome of one `loadEvents()` call.
 *
 * Two different kinds of incompleteness used to share one `truncated` bool; they
 * are now reported apart, because they mean different things to a reader:
 *
 * - `files_truncated`: some trace file *inside* the window was not read at all
 *   (byte budget, file cap, or it vanished mid-call). Runs on disk are missing
 *   from the totals;
 * - `partial_files`: this many covered files were only partially read (head
 *   dropped for an outsized file, or its oldest events trimmed from the cache).
 *   Those runs are counted, but their numbers can be short.
 *
 * `truncated` is kept as `files_truncated || partial_files > 0` for callers that
 * only want "is this view complete". A file outside the *day* window is **not**
 * a truncation — the user asked for that range.
 */
export interface LoadResult {
  /**
   * Parsed usage events, grouped by file in visit order: newest file first, or —
   * when an `until` bound was given — from the file nearest that bound outwards.
   */
  events: RawEvent[];
  /** The events do not cover every trace file in the window (compat shorthand). */
  truncated: boolean;
  /** In-window trace files that contributed nothing to this result. */
  files_truncated: boolean;
  /** Covered files that were only partially read. */
  partial_files: number;
  /** Trace files present in `<dataDir>/events` (regardless of the window). */
  files_total: number;
  /**
   * Trace files the range actually covers: after the lower-bound filter and,
   * with an `until` bound, after the authoritative first-line judgement
   * (`dropAfterUntil`). `files_total` without any bound.
   */
  files_in_window: number;
  /** Trace files this call covered (a newest-first prefix of the window). */
  files_covered: number;
  /**
   * Bytes read into the event cache by this call. First-line peeks (`until`
   * bound only) are not included: they are a separate probe of at most
   * `FIRST_LINE_BYTES` per file and never come out of the read budget.
   */
  bytes_read: number;
}

/**
 * Event types this plugin folds into usage records (`buildRecords`) plus the two
 * run-level events the index/validation needs. Everything else in a session log
 * — `tool.call.*`, `llm.stream.*`, `message.injected`, `user.message`,
 * `run.started`, … — is dropped while parsing: tool calls alone are ~19k lines
 * per reference directory and carry arguments/output we never bill for.
 *
 * `run.completed` is **not** turned into a request record (that would double
 * count retries against the `llm.request`/`llm.response` pairing); it is kept so
 * the reader can validate a run's paired total against the host's own
 * `run.completed.usage` and so the index can record a run that never produced a
 * response.
 */
export const USAGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'llm.request',
  'llm.response',
  'run.completed',
  'run.failed',
]);

/**
 * Per-type whitelist of `data` fields kept in memory.
 *
 * A session log stores what the model said, which tools ran and each run's final
 * output; none of that belongs to a usage record. Projecting the payload down to
 * these keys is what keeps ~124 MiB of session logs from becoming ~124 MiB of
 * heap (the aggregate reads exactly these fields, and the index adds nothing).
 * Anything not listed is dropped at parse time and never retained.
 */
const EVENT_DATA_FIELDS: Record<string, readonly string[]> = {
  'llm.request': ['run_id', 'session_id', 'model', 'estimated_tokens', 'context_max', 'attempt'],
  'llm.response': ['run_id', 'session_id', 'usage'],
  'run.completed': ['run_id', 'session_id', 'usage', 'duration_ms', 'iterations'],
  'run.failed': ['run_id', 'session_id', 'error', 'error_code', 'duration_ms'],
};

/**
 * One call may read this much from disk.
 *
 * On the session-log source the whole corpus is ~125 MiB / 134 files (the old
 * per-run trace was 1.09 GiB / 638 files), so the budget is set above it: reading
 * everything whole measured 526-875 ms and produced 18k request records with
 * zero truncation. The point of the number is the same as before — a total must
 * not silently cover part of the range — but the range now fits, including
 * "all time".
 *
 * The cap is still a cap. A corpus that grows past it (or a range over a far
 * busier installation) truncates honestly: `files_truncated` is set and the UI
 * says "the newest N of M files in this range".
 */
export const WINDOW_BUDGET_BYTES = 192 * 1024 * 1024;

/**
 * Read budget and retention caps.
 *
 * `maxBytesPerCall` (192 MiB) is the whole I/O a single RPC may do when no range
 * is selected ("all time", and the Logs page). It equals `WINDOW_BUDGET_BYTES`:
 * the session-log corpus fits in one call today, so "all time" is complete
 * instead of a newest-first sample, which is what the old trace source could
 * never do (1.09 GiB).
 *
 * `maxBytesPerWindowCall` (`WINDOW_BUDGET_BYTES`, 192 MiB) is used when a range
 * is selected; see that constant.
 *
 * `maxBytesPerFile` (16 MiB) is what a single session log may contribute per
 * call, so one very long session cannot eat the whole budget; a bigger file is
 * read from its newest 16 MiB (head dropped, flagged as partial). The largest
 * reference session is 6.3 MiB, so nothing is partial today; subsequent appends
 * are still read incrementally, so only pre-existing history would be lost.
 *
 * `maxFilesPerCall` (1024) bounds per-call `stat`/parse bookkeeping. One stat
 * per session is the dominant warm-call cost (~0.3 ms each on Windows), and a
 * session file is much larger than a trace file, so the cap is well above the
 * session count of the reference directory (134).
 *
 * `maxRetainedBytesPerFile` (32 MiB) and `maxRetainedBytesTotal` (192 MiB) bound
 * memory, and the total must clear the read budget or "complete" would be an
 * illusion: reading 192 MiB and retaining less would evict part of the very
 * window that was just read. Retained bytes are raw *usage-event* line bytes
 * only — every other event type and every heavy field (message bodies, tool
 * arguments, run output) is dropped at parse time (`EVENT_DATA_FIELDS`) — so a
 * full read retains appreciably less than it reads: 124.8 MiB read retained
 * 46.8 MiB across 134 sessions (28.7k events). Worst case heap is roughly 2-3x
 * the retained bytes, bounded by the total cap and not by the number of sessions
 * on disk.
 */
export interface ReadLimits {
  maxBytesPerCall: number;
  maxBytesPerWindowCall: number;
  maxBytesPerFile: number;
  maxFilesPerCall: number;
  maxRetainedBytesPerFile: number;
  maxRetainedBytesTotal: number;
  maxCachedFiles: number;
}

export const DEFAULT_LIMITS: ReadLimits = {
  maxBytesPerCall: WINDOW_BUDGET_BYTES,
  maxBytesPerWindowCall: WINDOW_BUDGET_BYTES,
  maxBytesPerFile: 16 * 1024 * 1024,
  maxFilesPerCall: 1024,
  maxRetainedBytesPerFile: 32 * 1024 * 1024,
  maxRetainedBytesTotal: 192 * 1024 * 1024,
  maxCachedFiles: 1024,
};

/** One trace file as listed on disk in a single call. */
interface FileInfo {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

/**
 * Files ordered by how close their mtime is to `until`, closest first.
 *
 * Only the visit order changes, never the content: a file written after `until`
 * can still hold events before it, so no candidate can be dropped, but the byte
 * budget is finite — spending it on the runs around the requested end bound is
 * what makes a historical interval ("yesterday 10:00-12:00") return rows at all.
 * Ties go newest-first, then by name so the order is stable across calls.
 */
function nearestFirst(files: FileInfo[], until: number): FileInfo[] {
  return [...files].sort(
    (a, b) =>
      Math.abs(a.mtimeMs - until) - Math.abs(b.mtimeMs - until) ||
      b.mtimeMs - a.mtimeMs ||
      a.name.localeCompare(b.name),
  );
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

/**
 * Project an event's `data` down to the fields usage reads (see
 * `EVENT_DATA_FIELDS`). Unknown types are dropped by the caller before this runs,
 * so a missing entry means "keep nothing".
 */
function projectEventData(type: string, data: Record<string, unknown>): Record<string, unknown> {
  const fields = EVENT_DATA_FIELDS[type];
  if (fields === undefined) return {};
  const kept: Record<string, unknown> = {};
  for (const field of fields) {
    const value = data[field];
    if (value !== undefined) kept[field] = value;
  }
  return kept;
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
    data: projectEventData(parsed.type, data),
  };
}

const NEWLINE = 0x0a;

/** The per-session log file inside `<dataDir>/sessions/<sessionId>/`. */
const SESSION_LOG = 'events.ndjson';


/** How many bytes of a file's top are read to find its first event. */
const FIRST_LINE_BYTES = 8 * 1024;

/**
 * `ts` of the first event in a trace file, or `undefined` when it cannot be read.
 *
 * This is **not** a heuristic: the bytes read are the file's own first line, so
 * the answer is the run's real start instant. It is used to prove that a file
 * lies entirely after an `until` bound (`firstTs >= until`) and can therefore be
 * skipped without reading it. Every failure path returns `undefined`, i.e. "no
 * judgement" — an empty file, a first line longer than the peek window, a torn
 * or unparsable line, a permission error. Callers must treat `undefined` as
 * "keep the file": reading a few extra KiB is cheap, losing rows is not.
 */
async function peekFirstTs(path: string): Promise<number | undefined> {
  let buffer: Buffer;
  try {
    buffer = await readRange(path, 0, FIRST_LINE_BYTES);
  } catch {
    return undefined;
  }
  if (buffer.length === 0) return undefined;
  const newline = buffer.indexOf(NEWLINE);
  // `-1`: the first line is longer than the peek window; `0`: it is empty.
  if (newline <= 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const ts = parsed.ts;
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : undefined;
}

/** Cached first-event instant of one file, keyed by the size/mtime it was read at. */
interface FirstTsEntry {
  size: number;
  mtimeMs: number;
  ts: number | undefined;
}

/**
 * How many first-event instants are kept.
 *
 * This cache is nothing like the event cache: one entry is a path plus three
 * numbers (~200 bytes), so 4096 files cost well under a megabyte. It must be
 * generous: a busy directory has far more run files than `maxCachedFiles`, and a
 * cache smaller than the candidate set thrashes — every lookup would evict the
 * entry the next lookup needs and re-peek all of them (measured: 466 peeks per
 * call instead of 0).
 */
const MAX_FIRST_TS_ENTRIES = 4096;

/**
 * How far before `cutoff` a file's mtime may sit and still be opened.
 *
 * The file-level window is only an I/O filter; the authoritative filter is the
 * per-event `ts >= cutoff` pass (`collectWindowEvents`). Some file systems store
 * mtime with a granularity coarser than the millisecond the trace uses (and
 * Windows can round down), so a run whose last event is a moment *after* the
 * cutoff may have an mtime a hair *before* it. Reading such a file costs a few
 * KiB and its pre-cutoff events are dropped anyway; not reading it would lose
 * real data.
 */
const MTIME_SLACK_MS = 2_000;

/**
 * Events of `entry` at or after `cutoff`.
 *
 * A request that started before the window and was answered inside it is kept
 * as attribution context: `buildRecords` folds a `llm.request` into the
 * `llm.response` that answers it, so dropping the request would strip the
 * in-window row of its model (and its duration). The carried request never
 * becomes a record of its own — records are minted from the response /
 * `run.failed` event — so every row in the result is still within the window.
 *
 * Carrying is per file: one run writes one trace file, so a request and its
 * response always live together.
 */
function collectWindowEvents(events: CachedEvent[], cutoff: number, into: RawEvent[]): void {
  const pending = new Map<string, RawEvent>();
  for (const cached of events) {
    const event = cached.event;
    if (event.ts >= cutoff) {
      if (event.type === 'llm.request') {
        // A newer in-window request supersedes any pre-window one still
        // unanswered: carrying the older one would hand the answer the wrong
        // model and a duration measured from the wrong request.
        pending.delete(event.run_id);
      } else {
        const carried = pending.get(event.run_id);
        if (carried !== undefined) {
          pending.delete(event.run_id);
          into.push(carried);
        }
      }
      into.push(event);
      continue;
    }
    // Before the window: only useful as the context of an in-window answer.
    if (event.type === 'llm.request') pending.set(event.run_id, event);
    else pending.delete(event.run_id);
  }
}

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
  return {
    events: [],
    truncated: false,
    files_truncated: false,
    partial_files: 0,
    files_total: filesTotal,
    files_in_window: 0,
    files_covered: 0,
    bytes_read: 0,
  };
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
  /** First-event instant per file, keyed by the size/mtime it was read at. */
  private readonly firstTs = new Map<string, FirstTsEntry>();
  /** First-line peeks actually performed (cache misses). Read by the probe. */
  private peeks = 0;

  constructor(limits: ReadLimits = DEFAULT_LIMITS) {
    this.limits = limits;
  }

  /**
   * How many first-line peeks this store has performed from disk.
   *
   * Diagnostics: a peek is one small read per *file that changed*, so this
   * counter staying flat across two range queries is the cache working.
   */
  get firstLinePeeks(): number {
    return this.peeks;
  }

  /** Drop cached files (called on activate/deactivate). */
  reset(): void {
    this.cache.clear();
    this.firstTs.clear();
  }

  /**
   * Load events from the root `<dataDir>/events/*.jsonl` files (read-only).
   *
   * `options.cutoff` / `options.until` narrow the view to one range; see
   * `LoadOptions`, `LoadResult` and the module docs for how the window, the
   * budgets and the per-file cache interact.
   */
  async loadEvents(dataDir: string, options: LoadOptions = {}): Promise<LoadResult> {
    const cutoff = options.cutoff;
    const until = options.until;
    // Either bound means the caller asked for a *range*, which is what selects
    // the larger window budget (a range is a "real total", not a sample).
    const bounded = cutoff !== undefined || until !== undefined;
    const dir = resolveSingleTenantPaths(dataDir).sessions_dir;
    const files = await this.list(dir);
    if (files.length === 0) {
      this.cache.clear();
      return emptyResult();
    }

    // Range window, lower bound. A trace file's mtime is its last append, so it
    // is at or after every event `ts` inside it: a file older than the lower
    // bound cannot hold an in-range event (modulo `MTIME_SLACK_MS`).
    const byCutoff =
      cutoff === undefined
        ? files
        : files.filter((file) => file.mtimeMs >= cutoff - MTIME_SLACK_MS);

    // Range window, upper bound. mtime says nothing useful about the *start* of
    // a run, so files written after `until` stay candidates — unless their first
    // event already proves they are entirely after the range (`dropAfterUntil`).
    const inWindow = until === undefined ? byCutoff : await this.dropAfterUntil(byCutoff, until);

    // A selected range means "the real total for these N days": it gets the
    // larger window budget so the range fits instead of being silently sampled.
    // Without a range ("all time") the small per-call budget still applies.
    const budget = bounded
      ? Math.max(this.limits.maxBytesPerCall, this.limits.maxBytesPerWindowCall)
      : this.limits.maxBytesPerCall;

    // Visit order decides which runs fit the budget; it never changes an
    // aggregate (they are summed per `ts`). Normally newest first, so the budget
    // lands on the runs the user is looking at. With an explicit `until` the
    // interesting runs are the ones *around* that end bound, so candidates are
    // visited from the file nearest `until` outwards — otherwise "yesterday
    // 10:00-12:00" would spend the whole budget on today's files and return
    // nothing. A file is billed by `min(size, maxBytesPerFile)` — the part of it
    // any call can ever read — so the window is a function of what is on disk
    // rather than of what happens to be cached. That keeps two calls on an
    // unchanged directory identical instead of each one silently widening it.
    const candidates = until === undefined ? inWindow : nearestFirst(inWindow, until);
    const window: FileInfo[] = [];
    let billed = 0;
    for (const file of candidates) {
      if (window.length >= this.limits.maxFilesPerCall) break;
      const cost = Math.min(file.size, this.limits.maxBytesPerFile);
      if (billed + cost > budget) break;
      window.push(file);
      billed += cost;
    }

    // Cache retention follows the *directory*, not the range: switching the day
    // range (or narrowing to a custom interval) must not throw away bytes that
    // are still on disk, or 7d -> 30d -> 7d would re-read the same files twice
    // more. Only a file that vanished (trace pruning) drops its entry; `evict()`
    // bounds the rest by LRU.
    const onDisk = new Set(files.map((file) => file.path));
    for (const path of [...this.cache.keys()]) {
      if (!onDisk.has(path)) this.cache.delete(path);
    }
    for (const path of [...this.firstTs.keys()]) {
      if (!onDisk.has(path)) this.firstTs.delete(path);
    }

    // Second budget, on bytes actually read: a window can only exceed the
    // billing above when files grew since the previous call, and that growth
    // must not become an unbounded read.
    let bytesRead = 0;
    for (const file of window) {
      const remaining = budget - bytesRead;
      if (remaining <= 0) break;
      bytesRead += await this.refresh(file, remaining);
    }

    this.evict();

    const events: RawEvent[] = [];
    let partialFiles = 0;
    let unreadable = 0;
    for (const file of window) {
      const entry = this.cache.get(file.path);
      if (entry === undefined) {
        // Unreadable this call (vanished, locked): the view is incomplete.
        unreadable += 1;
        continue;
      }
      if (entry.partial) partialFiles += 1;
      if (cutoff === undefined) {
        for (const cached of entry.events) events.push(cached.event);
      } else {
        collectWindowEvents(entry.events, cutoff, events);
      }
    }
    const filesTruncated = window.length < inWindow.length || unreadable > 0;
    return {
      events,
      truncated: filesTruncated || partialFiles > 0,
      files_truncated: filesTruncated,
      partial_files: partialFiles,
      files_total: files.length,
      files_in_window: inWindow.length,
      files_covered: window.length,
      bytes_read: bytesRead,
    };
  }

  /**
   * Drop the candidates that provably hold nothing before `until`.
   *
   * A file whose mtime is at or before `until` holds only events at or before
   * its mtime, so it is kept without any extra I/O. For the rest (files written
   * after `until`), the first line is read: its `ts` is the run's real start, so
   * `firstTs >= until` proves the whole file lies after the range and it is
   * dropped **before the byte budget is spent on it**. An unreadable or
   * unjudgeable file is kept (see `peekFirstTs`), which degrades to the older
   * behaviour of "read it and filter its records".
   *
   * Results are cached by `(path, size, mtime)`: trace files are append-only, so
   * the first line never changes and a re-render or a second range query costs
   * zero peeks.
   */
  private async dropAfterUntil(files: FileInfo[], until: number): Promise<FileInfo[]> {
    const kept: FileInfo[] = [];
    const needPeek: FileInfo[] = [];
    for (const file of files) {
      if (file.mtimeMs <= until) kept.push(file);
      else needPeek.push(file);
    }

    // Peek in small parallel batches: one open+read+close per file is otherwise
    // the dominant cost when a whole day of runs sits after the range.
    for (let index = 0; index < needPeek.length; index += STAT_BATCH) {
      const batch = needPeek.slice(index, index + STAT_BATCH);
      const peeks = await Promise.all(batch.map((file) => this.firstTimestamp(file)));
      for (const [offset, ts] of peeks.entries()) {
        const file = batch[offset];
        if (file === undefined) continue;
        // `undefined` = no judgement (keep); `ts >= until` = provably after.
        if (ts !== undefined && ts >= until) continue;
        kept.push(file);
      }
    }
    return kept;
  }

  /** Cached first-event instant of one file; peeks only when the file changed. */
  private async firstTimestamp(file: FileInfo): Promise<number | undefined> {
    const cached = this.firstTs.get(file.path);
    if (cached !== undefined && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
      return cached.ts;
    }
    this.peeks += 1;
    const ts = await peekFirstTs(file.path);
    if (this.firstTs.size >= MAX_FIRST_TS_ENTRIES) {
      const oldest = this.firstTs.keys().next();
      if (oldest.done !== true) this.firstTs.delete(oldest.value);
    }
    this.firstTs.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, ts });
    return ts;
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
    if (want <= 0) {
      // Nothing to read (a trace file the host created but has not written yet).
      // Record it as covered anyway: an empty file is not a file we failed to
      // read, and `files_truncated` must not call it one.
      this.cache.set(file.path, {
        size: file.size,
        offset: 0,
        events: [],
        retained: 0,
        line: 0,
        partial: false,
        usedAt: ++this.clock,
      });
      return 0;
    }

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

  /**
   * List the session logs, newest mtime first (name as a stable tie-break).
   *
   * Delegates to `listSessionFiles` so the reader and the index fingerprint see
   * exactly the same file set, then forgets cache entries for files that are
   * gone (a deleted session).
   */
  private async list(dir: string): Promise<FileInfo[]> {
    const files = await listSessionFiles(dir);
    const onDisk = new Set(files.map((file) => file.path));
    for (const path of [...this.cache.keys()]) {
      if (!onDisk.has(path)) this.cache.delete(path);
    }
    for (const path of [...this.firstTs.keys()]) {
      if (!onDisk.has(path)) this.firstTs.delete(path);
    }
    return files;
  }
}

/**
 * List `<sessionsDir>/<sessionId>/events.ndjson`, newest mtime first.
 *
 * One level deeper than the old trace directory: a session owns one file, not a
 * run. `<sessionId>.json` (the session index) and every other entry are ignored
 * — usage never reads session metadata.
 */
async function listSessionFiles(dir: string): Promise<FileInfo[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
  const files: FileInfo[] = [];
  // One `stat` per session is the dominant cost of a warm call on Windows
  // (~0.3 ms each), so walk the list in small parallel batches instead of
  // awaiting one file at a time.
  for (let index = 0; index < names.length; index += STAT_BATCH) {
    const batch = names.slice(index, index + STAT_BATCH);
    const infos = await Promise.all(
      batch.map(async (name): Promise<FileInfo | undefined> => {
        const path = join(dir, name, SESSION_LOG);
        try {
          const info = await stat(path);
          if (!info.isFile()) return undefined;
          return { path, name, size: info.size, mtimeMs: info.mtimeMs };
        } catch {
          // Deleted between readdir and stat: forget it.
          return undefined;
        }
      }),
    );
    for (const info of infos) if (info !== undefined) files.push(info);
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return files;
}

// ── persistent usage index ──────────────────────────────────────────────────

/**
 * Format version of `usage/index.ndjson`. Bumping it makes every existing index
 * stale, which is the intended upgrade path: the file is a cache, so the reader
 * rebuilds it from the session logs instead of trying to migrate it.
 */
export const USAGE_INDEX_VERSION = 1;

const USAGE_INDEX_DIR = 'usage';
const USAGE_INDEX_NAME = 'index.ndjson';
const INDEX_HEADER_KIND = 'index';
const INDEX_ENTRY_KIND = 'run';

/** Cheap fingerprint of the session logs an index was built from. */
export interface IndexSources {
  files: number;
  bytes: number;
  max_mtime: number;
}

/**
 * Staleness check for a persisted index: `files:bytes:max_mtime`.
 *
 * One `stat` sweep produces it, so a reader can decide whether the index still
 * describes the session logs on disk without parsing a single event. Any change
 * to any session (append, new session, deleted session) changes it, and a changed
 * fingerprint only ever costs a rebuild — the logs stay the truth.
 */
export function sourceSignature(sources: IndexSources): string {
  return `${sources.files}:${sources.bytes}:${sources.max_mtime}`;
}

export interface IndexHeader {
  kind: typeof INDEX_HEADER_KIND;
  v: number;
  generated_at: number;
  runs: number;
  sources: IndexSources;
}

export interface UsageIndex {
  header: IndexHeader;
  runs: RunSummary[];
}

/** The plugin's own subdirectory: `<dataDir>/usage/index.ndjson`. */
export function usageIndexPath(dataDir: string): string {
  return join(resolveSingleTenantPaths(dataDir).root, USAGE_INDEX_DIR, USAGE_INDEX_NAME);
}

/**
 * Write `text` to `path` atomically: temp file in the same directory, fsync,
 * then a rename over the target.
 *
 * Rename is the only atomic step, so a reader either sees the previous file or
 * the new one, never a half-written index. Two processes writing at once both
 * rename successfully and the loser's content is simply replaced — the index is
 * derived data, so the cost of losing that race is one rebuild, never a wrong
 * answer. (Core has its own helper; a plugin may not import internals, and this
 * is the ~30 lines it takes.)
 */
async function writeFileAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Persist one line per run plus a header carrying the format version, the build
 * time and the source fingerprint the index was derived from.
 *
 * Callers must **not** write an index built from a truncated read: a partial
 * index would then look authoritative on every later call. The fingerprint is
 * what makes staleness detectable without re-reading a single event.
 */
export async function writeUsageIndex(
  dataDir: string,
  runs: RunSummary[],
  sources: IndexSources,
): Promise<void> {
  const path = usageIndexPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  const header: IndexHeader = {
    kind: INDEX_HEADER_KIND,
    v: USAGE_INDEX_VERSION,
    generated_at: Date.now(),
    runs: runs.length,
    sources,
  };
  const lines = [JSON.stringify(header)];
  for (const run of runs) {
    lines.push(JSON.stringify({ v: USAGE_INDEX_VERSION, kind: INDEX_ENTRY_KIND, ...run }));
  }
  await writeFileAtomic(path, `${lines.join('\n')}\n`);
}

/** One index line -> `RunSummary`; `undefined` when a required field is missing. */
function parseIndexEntry(value: Record<string, unknown>): RunSummary | undefined {
  const runId = value.run_id;
  const model = value.model;
  const tsStart = value.ts_start;
  const tsEnd = value.ts_end;
  const requests = value.requests;
  const prompt = value.prompt_tokens;
  const completion = value.completion_tokens;
  const status = value.status;
  if (typeof runId !== 'string' || runId === '') return undefined;
  if (typeof model !== 'string' || model === '') return undefined;
  if (typeof tsStart !== 'number' || typeof tsEnd !== 'number') return undefined;
  if (typeof requests !== 'number' || typeof prompt !== 'number') return undefined;
  if (typeof completion !== 'number') return undefined;
  if (status !== 'ok' && status !== 'failed') return undefined;

  const sessionId = value.session_id;
  const cacheRead = value.cache_read_input_tokens;
  const cacheWrite = value.cache_creation_input_tokens;
  const cost = value.cost;
  const unpriced = value.unpriced_requests;
  return {
    run_id: runId,
    ...(typeof sessionId === 'string' && sessionId !== '' ? { session_id: sessionId } : {}),
    model,
    ts_start: tsStart,
    ts_end: tsEnd,
    requests,
    prompt_tokens: prompt,
    completion_tokens: completion,
    ...(typeof cacheRead === 'number' ? { cache_read_input_tokens: cacheRead } : {}),
    ...(typeof cacheWrite === 'number' ? { cache_creation_input_tokens: cacheWrite } : {}),
    ...(typeof cost === 'number' ? { cost } : {}),
    unpriced_requests: typeof unpriced === 'number' ? unpriced : 0,
    status,
  };
}

/**
 * Read the index, or `undefined` when it is missing, unreadable, written by
 * another format version, or corrupt.
 *
 * Every failure means "no index", never "no data": the caller rebuilds from the
 * session logs (the source of truth) and overwrites the file.
 */
export async function readUsageIndex(dataDir: string): Promise<UsageIndex | undefined> {
  let text: string;
  try {
    text = await readFile(usageIndexPath(dataDir), 'utf8');
  } catch {
    return undefined;
  }
  const lines = text.split('\n');
  const first = lines[0];
  if (first === undefined || first.trim() === '') return undefined;
  let header: unknown;
  try {
    header = JSON.parse(first);
  } catch {
    return undefined;
  }
  if (!isRecord(header)) return undefined;
  if (header.kind !== INDEX_HEADER_KIND) return undefined;
  if (header.v !== USAGE_INDEX_VERSION) return undefined;
  const sources = header.sources;
  if (!isRecord(sources)) return undefined;
  const files = sources.files;
  const bytes = sources.bytes;
  const maxMtime = sources.max_mtime;
  const generatedAt = header.generated_at;
  if (typeof files !== 'number' || typeof bytes !== 'number') return undefined;
  if (typeof maxMtime !== 'number' || typeof generatedAt !== 'number') return undefined;

  const runs: RunSummary[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A torn line means a torn file: rebuild instead of serving half an index.
      return undefined;
    }
    if (!isRecord(parsed) || parsed.v !== USAGE_INDEX_VERSION) return undefined;
    const run = parseIndexEntry(parsed);
    if (run === undefined) return undefined;
    runs.push(run);
  }
  return {
    header: {
      kind: INDEX_HEADER_KIND,
      v: USAGE_INDEX_VERSION,
      generated_at: generatedAt,
      runs: runs.length,
      sources: { files, bytes, max_mtime: maxMtime },
    },
    runs,
  };
}

/**
 * Fingerprint the session logs without reading them: file count, total bytes and
 * the newest mtime. One `stat` per session (~0.3 ms on Windows; 134 sessions in
 * the reference directory), and it is what lets the reader trust a persisted
 * index without parsing a single event.
 */
export async function readSessionSources(dataDir: string): Promise<IndexSources> {
  const dir = resolveSingleTenantPaths(dataDir).sessions_dir;
  const files = await listSessionFiles(dir);
  let bytes = 0;
  let maxMtime = 0;
  for (const file of files) {
    bytes += file.size;
    if (file.mtimeMs > maxMtime) maxMtime = file.mtimeMs;
  }
  return { files: files.length, bytes, max_mtime: maxMtime };
}
