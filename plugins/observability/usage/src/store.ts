/**
 * Persisted usage source for the Usage plugin: the session **timeline**.
 *
 * ## Why this changed (0.56)
 *
 * The reader used to parse `<dataDir>/sessions/<id>/events.ndjson`. Vessel
 * stopped writing that file in 0.54 (the timeline became the only durable event
 * sink) and cannot parse it any more (`legacy_session_unsupported`), so the old
 * source was a file that never grows: every number on the Usage / Logs pages
 * silently described the 0.54 cutover instead of the present. This module now
 * reads the timeline.
 *
 * ## What is read, and what is deliberately not
 *
 * | path (inside `<sessions>/<id>/`) | read? | why |
 * | --- | --- | --- |
 * | `wal.log` | **yes — the only source** | one line per non-chunk event, CRC32 per line |
 * | `wal.blocks/*.wblk` | no | chunk frames only (`llm.stream.chunk` / `*.llm.stream.chunk`): stream deltas, no token counters. Reading them would add ~88 MiB of decodes on the reference 200k-seq session and buy exactly zero usage fields |
 * | `timeline.ndjson` | no | archive **copy** of a `wal.log` prefix (`archiveNow()` appends, never truncates `wal.log` — "copy, not move"), so reading both would double count every archived event |
 * | `timeline.idx/*` | no | derived index (ADR-105 §5): rebuildable, never evidence |
 * | `holes.ndjson` | no | declares seq ranges the writer could not persist — that is *absence*, not data; there is nothing to add to a total |
 * | `events.ndjson` | no | pre-0.54 format, unreadable by 0.55+; such a session is reported as unreadable instead of being counted as zero |
 *
 * Because `wal.log` always covers `1..wal_head` and every event type usage needs
 * (`llm.request` / `llm.response` / `run.completed` / `run.failed`) is a fact
 * line, no block, archive or index read is needed for a total. That claim is the
 * same one `TimelineEventLog.readTailMatches` relies on; if a usage field ever
 * lands in the chunk family, this table is what has to change — and then the read
 * must go through core's range read (`readTimelineRange`), not a hand-rolled
 * block scan.
 *
 * ## Bounds (the point of this rewrite)
 *
 * A query never reads a whole session timeline into memory, and never reads an
 * unbounded amount of disk:
 *
 * - **One session** is read into at most `maxBytesPerFile` (64 MiB) of raw
 *   `wal.log` — the tail when the file is bigger, and then the session is
 *   reported as `partial_files`, never silently shortened. The biggest real
 *   session today is 8.0 MiB of `wal.log` (20万 seq session: the seq space is
 *   dominated by chunk frames, which live in blocks), i.e. 8x headroom.
 * - **One call** is capped by `maxBytesPerCall` (512 MiB) and
 *   `maxFilesPerCall` (4096 sessions). The reference corpus is 327 timelines /
 *   417 MiB and a full sweep measures ~6.9 s end to end (read + `JSON.parse`, a
 *   Windows filesystem, one core) => ~60 MB/s, so the ceiling is ~9 s of worker
 *   time. A *range* query opens only the sessions whose mtime is inside the
 *   range, which is a handful.
 * - **Retained memory** is projected usage events only (`EVENT_DATA_FIELDS`),
 *   capped by `maxRetainedBytesTotal` (192 MiB of raw usage-line bytes ~= 0.4-0.6
 *   GiB of heap worst case) with whole-session LRU eviction. Cache entries are
 *   keyed by `path` and stamp `(size, mtime)`: an unchanged session costs **zero
 *   bytes and zero parse**, which is the steady state for a re-render, pagination
 *   or a second tab.
 *
 * ## Incrementality
 *
 * A changed session re-reads that session whole (bounded by `maxBytesPerFile`)
 * instead of resuming from a byte offset. The old offset cursor bought a few KiB
 * per append at the cost of a per-file state machine; a whole-session re-read is
 * one file that is already bounded, and it cannot drift out of sync with the
 * writer. `usage/index.ndjson` (v2) is what keeps this cheap across queries: it
 * remembers the `(size, mtime)` each session was last read at, so `summary` /
 * `leaderboard` re-read only the sessions that changed since the last call.
 *
 * @module @vessel-agent/plugin-usage
 */

import type { Dirent } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
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

/** A usage event projected out of one `wal.log` line. */
export interface RawEvent {
  type: string;
  ts: number;
  run_id: string;
  /**
   * Physical line index inside the read window (1-based), used only when `seq`
   * is missing. A timeline record always carries `seq`, so this is a fallback for
   * hand-built fixtures, not a real ordering key.
   */
  line: number;
  seq?: number;
  data: Record<string, unknown>;
}

/**
 * One run's usage, aggregated from its request records.
 *
 * This is the shape the persistent index stores (one line per run) and the shape
 * `summary` / `leaderboard` aggregate over: run-level totals are all those two
 * pages need, and reading one small line per run beats re-reading session
 * timelines. `logs` still works from the per-request records, because a request
 * row cannot be reconstructed from a run total.
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
 * Which slice of a session timeline a call should look at.
 *
 * `cutoff` is the start of the selected range (`daysCutoff(now, days)`, or an
 * explicit `since`). Sessions whose `wal.log` mtime is older than it are not
 * opened (mtime is the last append, i.e. at or after every `ts` inside the file),
 * and events older than it are not returned, so the lower bound is enforced on
 * event time rather than on the read budget. Omitted means "no lower bound".
 *
 * `until` is the (exclusive) end of an explicit range. A file's mtime is after
 * all of its events, so mtime alone cannot exclude a session written after
 * `until`; instead the reader peeks each such file's **first line** and drops it
 * when the session provably starts at or after `until` (`dropAfterUntil`,
 * `peekFirstTs` — a real read of real bytes, not a heuristic). The remaining
 * candidates are visited from the one nearest `until` outwards, so the budget
 * lands on the sessions around the end of the requested interval. The record-level
 * `[since, until)` filter lives in `listLogs` (`aggregate.ts`).
 */
export interface LoadOptions {
  cutoff?: number;
  until?: number;
}

/**
 * Outcome of one `loadEvents()` call.
 *
 * Two different kinds of incompleteness are reported apart, because they mean
 * different things to a reader:
 *
 * - `files_truncated`: some session timeline in the window was not read at all
 *   (per-call byte budget, session cap, or it vanished mid-call). Runs on disk are
 *   missing from the totals;
 * - `partial_files`: this many covered timelines were only partially read (the
 *   timeline is bigger than `maxBytesPerFile`, so only its tail was scanned).
 *   Those runs are counted, but their numbers can be short.
 *
 * `truncated` is kept as `files_truncated || partial_files > 0` for callers that
 * only want "is this view complete". A session outside the *range* is **not** a
 * truncation — the user asked for that range.
 *
 * `dirs_total` / `legacy_files` are the degradation probes: session directories
 * on disk, and how many of them have no readable timeline (pre-0.54 format).
 */
export interface LoadResult {
  /** Parsed usage events, grouped by session in visit order: newest first, or — when an `until` bound was given — from the session nearest that bound outwards. */
  events: RawEvent[];
  /** The events do not cover every session timeline in the window (compat shorthand). */
  truncated: boolean;
  /** In-window timelines that contributed nothing to this result. */
  files_truncated: boolean;
  /** Covered timelines that were only partially read. */
  partial_files: number;
  /** Session timelines present in `<dataDir>/sessions` (regardless of the range). */
  files_total: number;
  /** Timelines the range actually covers, after the lower-bound filter and, with an `until` bound, the authoritative first-line judgement. */
  files_in_window: number;
  /** Timelines this call covered (a newest-first prefix of the window). */
  files_covered: number;
  /** Bytes read from `wal.log` files by this call. */
  bytes_read: number;
  /** First-line peeks performed by this call (0 unless `until` ruled sessions out). */
  peeks: number;
  /** Session directories on disk (readable timeline or not). */
  dirs_total: number;
  /** Session directories with no readable timeline (pre-0.54 `events.ndjson` only). */
  legacy_files: number;
}

/**
 * One session timeline as listed on disk in a single call.
 *
 * `id` is the directory name (the encoded session id); `path` is its `wal.log`.
 */
export interface SessionFile {
  id: string;
  path: string;
  size: number;
  mtimeMs: number;
}

/** Usage events of one session timeline, plus what reading it cost. */
export interface SessionRead {
  events: RawEvent[];
  /** Bytes read from disk (0 when the cached copy was still valid). */
  bytes_read: number;
  /** The timeline is bigger than `maxBytesPerFile`: only its tail was scanned. */
  partial: boolean;
}

/** One `scanSessions()` pass: the timelines, the session dirs, and the fingerprint. */
export interface SessionScan {
  files: SessionFile[];
  /** Session directories on disk (readable timeline or not). */
  dirs: number;
  /** Session directories with no readable timeline (pre-0.54 `events.ndjson` only). */
  legacy: number;
  sources: IndexSources;
}

/**
 * Event types this plugin folds into usage records (`buildRecords`) plus the two
 * run-level events the index/validation needs. Everything else in a timeline —
 * `tool.call.*`, `llm.stream.summary`, `message.injected`, `user.message`,
 * `run.started`, … — is dropped while parsing: tool calls alone are ~19k lines
 * per reference directory and carry arguments/output we never bill for, and
 * chunk frames are not even in `wal.log`.
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
 * A timeline stores what the model said, which tools ran and each run's final
 * error; none of that belongs to a usage record. Projecting the payload down to
 * these keys is what keeps 417 MiB of timelines from becoming 417 MiB of heap
 * (the aggregate reads exactly these fields, and the index adds nothing).
 *
 * `run.failed.data.error` is the one field worth naming: it is the largest field
 * in the corpus (~1.5 KiB/line, a serialized provider exception, sometimes with
 * nested JSON in `data.error.message`), no view reads it, and keeping it would
 * cost more memory than every token counter in the corpus. Dropped on purpose.
 */
const EVENT_DATA_FIELDS: Record<string, readonly string[]> = {
  'llm.request': ['run_id', 'session_id', 'model'],
  'llm.response': ['run_id', 'session_id', 'usage'],
  'run.completed': ['run_id', 'session_id', 'usage', 'duration_ms', 'iterations'],
  'run.failed': ['run_id', 'session_id', 'duration_ms'],
};

/**
 * Read budget and retention caps.
 *
 * Every number is a real bound, not a knob to wave away: reading one session
 * timeline is bounded per file, a whole call is bounded in bytes and in session
 * count, and retained memory is bounded by LRU eviction. What gets cut is always
 * reported (`files_truncated` / `partial_files`), never silently dropped — a
 * total that covers 43 of 176 sessions must not look like the total.
 *
 * The arithmetic behind the defaults (measured on the reference data directory:
 * 327 timelines, 417 MiB, 282k lines, one Windows filesystem, ~60 MB/s end to
 * end including `JSON.parse`):
 *
 * - `maxBytesPerFile` 64 MiB — biggest real `wal.log` is 8.0 MiB, so 8x headroom;
 *   beyond it the tail is scanned and the session is counted in `partial_files`;
 * - `maxBytesPerCall` 512 MiB — one full sweep of the reference corpus (an index
 *   rebuild) fits with room to spare (~9 s ceiling);
 * - `maxFilesPerCall` 4096 — far above any real directory, there to stop a
 *   pathological one from turning into an unbounded loop;
 * - retained bytes are raw *usage-line* bytes only (every other event type and
 *   every heavy field is dropped at parse time), so the reference corpus retains
 *   ~156 MiB of lines across 327 sessions when everything is cached.
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
  maxBytesPerCall: 512 * 1024 * 1024,
  maxBytesPerFile: 64 * 1024 * 1024,
  maxFilesPerCall: 4096,
  // 192 MiB of retained usage-line bytes (~0.4-0.6 GiB heap at 2-3x), 32 MiB per
  // session so one runaway session cannot take the whole cap.
  maxRetainedBytesPerFile: 32 * 1024 * 1024,
  maxRetainedBytesTotal: 192 * 1024 * 1024,
  maxCachedFiles: 1024,
};

/** The timeline fact file inside `<dataDir>/sessions/<sessionId>/`. */
const WAL_LOG = 'wal.log';

/** The pre-0.54 event log: recognised only to report the session as unreadable. */
const LEGACY_LOG = 'events.ndjson';

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

/** CRC32 (IEEE 802.3, the zlib polynomial) as 8 lowercase hex digits. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * CRC32 of one string, matching the writer's per-line `crc` (`timeline/wal.ts`).
 *
 * The plugin cannot import core internals (package exports), so this is the ~15
 * lines it takes. It is the format's own checksum, not a second opinion: a line
 * that fails it is dropped exactly like a line that fails to parse.
 */
function crc32Hex(input: string): string {
  const bytes = Buffer.from(input, 'utf8');
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

/**
 * One `wal.log` line -> a usage event, or `undefined`.
 *
 * Order matters for cost: the type is read first, so the ~60% of lines that are
 * not usage events are rejected before the CRC is recomputed (a `JSON.stringify`
 * per line is real work at 282k lines). Every line that can reach a total is
 * CRC-verified against its own body, so a corrupted line can never contribute a
 * number; it is dropped silently, exactly like an unparsable line.
 *
 * A line without a trailing newline is never handed to this function (the writer
 * was mid-append); see `parseTimelineBuffer`.
 */
function parseTimelineLine(line: string, lineNumber: number): RawEvent | undefined {
  if (line.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const type = parsed.type;
  if (typeof type !== 'string' || !USAGE_EVENT_TYPES.has(type)) return undefined;
  if (typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) return undefined;
  const expected = parsed.crc;
  if (typeof expected !== 'string' || expected.length === 0) return undefined;
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) {
    if (key === 'crc') continue;
    body[key] = parsed[key];
  }
  if (crc32Hex(JSON.stringify(body)) !== expected) return undefined;

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
    type,
    ts: parsed.ts,
    run_id: runId,
    line: lineNumber,
    ...(seq !== undefined ? { seq } : {}),
    data: projectEventData(type, data),
  };
}

const NEWLINE = 0x0a;

/** How many bytes of a file's top are read to find its first event. */
const FIRST_LINE_BYTES = 8 * 1024;

/**
 * `ts` of the first event in a session timeline, or `undefined` when it cannot be
 * read.
 *
 * This is **not** a heuristic: the bytes read are the file's own first line, so
 * the answer is the session's real start instant. It is used to prove that a
 * session lies entirely after an `until` bound (`firstTs >= until` plus the
 * ordering slack) and can therefore be skipped without reading it. Every failure
 * path returns `undefined`, i.e. "no judgement" — an empty file, a first line
 * longer than the peek window, a torn or unparsable line, a permission error.
 * Callers must treat `undefined` as "keep the session": reading a few extra KiB
 * is cheap, losing rows is not.
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
 * generous: a busy directory has far more sessions than `maxCachedFiles`, and a
 * cache smaller than the candidate set thrashes — every lookup would evict the
 * entry the next lookup needs and re-peek all of them (measured on the old
 * source: 466 peeks per call instead of 0).
 */
const MAX_FIRST_TS_ENTRIES = 4096;

/**
 * How far before `cutoff` a session's mtime may sit and still be opened.
 *
 * The file-level window is only an I/O filter; the authoritative filter is the
 * per-event `ts >= cutoff` pass (`selectWindow`). Some file systems store mtime
 * with a granularity coarser than the millisecond the timeline uses (and Windows
 * can round down), so a session whose last event is a moment *after* the cutoff
 * may have an mtime a hair *before* it. Reading such a file costs a few KiB and
 * its pre-cutoff events are dropped anyway; not reading it would lose real data.
 */
const MTIME_SLACK_MS = 2_000;

/**
 * How far after `until` a session's first event must be before the session is
 * dropped without reading it.
 *
 * `timeline_seq` is **write order**, not event time (`ts` of two records written
 * in the same flush can arrive out of order, ADR-105 §3 I5), so "the first line's
 * `ts` is after the range" does not *prove* that no later line is inside it. The
 * slack is what makes the shortcut safe in practice: a real session that starts
 * more than 5 s after an exclusive upper bound cannot hold an event before it
 * unless the writer stalled for >5 s between two appends of the same session,
 * which is not a state the flush policy can produce. A session that is *not*
 * dropped this way is scanned and filtered per record, so the shortcut can only
 * cost time, never rows — and it is reported as `peeked`.
 */
const TS_ORDER_SLACK_MS = 5_000;

/**
 * Events of `events` inside `[cutoff, until)`.
 *
 * A request that started before the window and was answered inside it is kept as
 * attribution context: `buildRecords` folds a `llm.request` into the
 * `llm.response` that answers it, so dropping the request would strip the
 * in-window row of its model (and its duration). The carried request never
 * becomes a record of its own — records are minted from the response /
 * `run.failed` event — so every row in the result is still within the window.
 *
 * Before the window only `llm.request` is remembered, and a newer in-window
 * request supersedes it: carrying the older one would hand the answer the wrong
 * model and a duration measured from the wrong request. After the window
 * (`until`) nothing is carried, in either direction.
 */
function selectWindow(
  events: RawEvent[],
  cutoff: number | undefined,
  until: number | undefined,
): RawEvent[] {
  const into: RawEvent[] = [];
  const pending = new Map<string, RawEvent>();
  for (const event of events) {
    if (until !== undefined && event.ts >= until) {
      // Above the range: it can neither be a row nor the context of one.
      pending.delete(event.run_id);
      continue;
    }
    if (cutoff === undefined || event.ts >= cutoff) {
      if (event.type === 'llm.request') {
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
    if (event.type === 'llm.request') pending.set(event.run_id, event);
    else pending.delete(event.run_id);
  }
  return into;
}

/** How many session timelines one `loadEvents()` stats at a time. */
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

/** One cached session timeline and the usage events parsed out of it. */
interface CachedSession {
  /** Size the events were parsed from; a different size invalidates the entry. */
  size: number;
  mtimeMs: number;
  events: RawEvent[];
  /** Raw usage-line bytes retained (the memory-accounting unit). */
  retained: number;
  /** Only the tail of the file was read (`size > maxBytesPerFile`). */
  partial: boolean;
  /** LRU stamp. */
  usedAt: number;
}

function emptyResult(filesTotal = 0, dirsTotal = 0, legacyFiles = 0): LoadResult {
  return {
    events: [],
    truncated: false,
    files_truncated: false,
    partial_files: 0,
    files_total: filesTotal,
    files_in_window: 0,
    files_covered: 0,
    bytes_read: 0,
    peeks: 0,
    dirs_total: dirsTotal,
    legacy_files: legacyFiles,
  };
}

/**
 * Files ordered by how close their mtime is to `until`, closest first.
 *
 * Only the visit order changes, never the content: a session written after
 * `until` can still hold events before it, so no candidate can be dropped, but
 * the byte budget is finite — spending it on the sessions around the requested
 * end bound is what makes a historical interval ("yesterday 10:00-12:00") return
 * rows at all. Ties go newest-first, then by id so the order is stable.
 */
function nearestFirst(files: SessionFile[], until: number): SessionFile[] {
  return [...files].sort(
    (a, b) =>
      Math.abs(a.mtimeMs - until) - Math.abs(b.mtimeMs - until) ||
      b.mtimeMs - a.mtimeMs ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Read-only usage store over the session timelines.
 *
 * One instance per activation; the cache is dropped when the host activates the
 * plugin in a different data directory. Limits are injectable so the probe can
 * exercise the budget paths without writing 64 MiB of fixtures.
 */
export class EventStore {
  private readonly cache = new Map<string, CachedSession>();
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
   * Diagnostics: a peek is one small read per *session that changed*, so this
   * counter staying flat across two range queries is the cache working.
   */
  get firstLinePeeks(): number {
    return this.peeks;
  }

  /** Drop cached sessions (called on activate/deactivate). */
  reset(): void {
    this.cache.clear();
    this.firstTs.clear();
  }

  /**
   * Load usage events from `<dataDir>/sessions/<id>/wal.log` (read-only).
   *
   * `options.cutoff` / `options.until` narrow the view to one range; see
   * `LoadOptions`, `LoadResult` and the module docs for how the window, the
   * budgets and the per-session cache interact.
   */
  async loadEvents(dataDir: string, options: LoadOptions = {}): Promise<LoadResult> {
    const cutoff = options.cutoff;
    const until = options.until;
    const dir = resolveSingleTenantPaths(dataDir).sessions_dir;
    const scan = await scanDir(dir);
    const files = scan.files;
    if (files.length === 0) {
      this.cache.clear();
      this.firstTs.clear();
      return emptyResult(0, scan.dirs, scan.legacy);
    }

    // Range window, lower bound. A session's mtime is its last append, so it is
    // at or after every event `ts` inside it: a file older than the lower bound
    // cannot hold an in-range event (modulo `MTIME_SLACK_MS`).
    const byCutoff =
      cutoff === undefined
        ? files
        : files.filter((file) => file.mtimeMs >= cutoff - MTIME_SLACK_MS);

    // Range window, upper bound. mtime says nothing useful about the *start* of
    // a session, so files written after `until` stay candidates — unless their
    // first event already proves they are entirely after the range.
    const inWindow = until === undefined ? byCutoff : await this.dropAfterUntil(byCutoff, until);

    // Visit order decides which sessions fit the budget; it never changes an
    // aggregate (they are summed per `ts`). Normally newest first, so the budget
    // lands on the sessions the user is looking at. With an explicit `until` the
    // interesting sessions are the ones *around* that end bound. A session is
    // billed by `min(size, maxBytesPerFile)` — the part of it any call can ever
    // read — so the window is a function of what is on disk rather than of what
    // happens to be cached.
    const candidates = until === undefined ? inWindow : nearestFirst(inWindow, until);
    const window: SessionFile[] = [];
    let billed = 0;
    for (const file of candidates) {
      if (window.length >= this.limits.maxFilesPerCall) break;
      const cost = Math.min(file.size, this.limits.maxBytesPerFile);
      if (billed + cost > this.limits.maxBytesPerCall) break;
      window.push(file);
      billed += cost;
    }

    // Cache retention follows the *directory*, not the range: switching the day
    // range (or narrowing to a custom interval) must not throw away bytes that
    // are still on disk, or 7d -> 30d -> 7d would re-read the same sessions
    // twice more. Only a session that vanished (deleted) drops its entry;
    // `evict()` bounds the rest by LRU.
    const onDisk = new Set(files.map((file) => file.path));
    for (const path of [...this.cache.keys()]) {
      if (!onDisk.has(path)) this.cache.delete(path);
    }
    for (const path of [...this.firstTs.keys()]) {
      if (!onDisk.has(path)) this.firstTs.delete(path);
    }

    // Second budget, on bytes actually read: a window can only exceed the
    // billing above when sessions grew since the previous call, and that growth
    // must not become an unbounded read.
    let bytesRead = 0;
    const peeks = this.peeks;
    for (const file of window) {
      const remaining = this.limits.maxBytesPerCall - bytesRead;
      if (remaining <= 0) break;
      bytesRead += (await this.readRaw(file, remaining)).bytes_read;
    }
    // Sessions that were read and then evicted by the LRU caps are a *partial*
    // view of a session we did read, not a session we failed to read: the memory
    // bound is a real limit, so it must show up as `partial_files` instead of
    // pretending the session never existed. Anything else missing from the cache
    // was unreadable.
    const readThisCall = new Set<string>();
    for (const file of window) {
      if (this.cache.has(file.path)) readThisCall.add(file.path);
    }

    this.evict();

    const events: RawEvent[] = [];
    let partialFiles = 0;
    let unreadable = 0;
    for (const file of window) {
      const entry = this.cache.get(file.path);
      if (entry === undefined) {
        if (readThisCall.has(file.path)) partialFiles += 1;
        else unreadable += 1;
        continue;
      }
      if (entry.partial) partialFiles += 1;
      for (const event of selectWindow(entry.events, cutoff, until)) events.push(event);
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
      peeks: this.peeks - peeks,
      dirs_total: scan.dirs,
      legacy_files: scan.legacy,
    };
  }

  /**
   * Read one session timeline (used by the persistent index, which needs a
   * session's own event set to rebuild its rows).
   *
   * `options` applies the same window as `loadEvents`, so the caller can build
   * the same records it would get from a ranged call. Unchanged sessions come
   * back in zero bytes; a session that vanished returns an empty read.
   */
  async readSession(file: SessionFile, options: LoadOptions = {}): Promise<SessionRead> {
    const raw = await this.readRaw(file, this.limits.maxBytesPerCall);
    const ranged = options.cutoff !== undefined || options.until !== undefined;
    return {
      events: ranged ? selectWindow(raw.events, options.cutoff, options.until) : [...raw.events],
      bytes_read: raw.bytes_read,
      partial: raw.partial,
    };
  }

  /**
   * Drop the candidates that provably hold nothing before `until`.
   *
   * A session whose mtime is at or before `until` holds only events at or before
   * its mtime, so it is kept without any extra I/O. For the rest (sessions
   * written after `until`), the first line is read: its `ts` is the session's
   * real start, so `firstTs >= until + TS_ORDER_SLACK_MS` proves the whole file
   * lies after the range and it is dropped **before the byte budget is spent on
   * it**. An unreadable or unjudgeable session is kept (see `peekFirstTs`), which
   * degrades to "read it and filter its records".
   *
   * Results are cached by `(path, size, mtime)`: timelines are append-only, so
   * the first line never changes and a re-render or a second range query costs
   * zero peeks.
   */
  private async dropAfterUntil(files: SessionFile[], until: number): Promise<SessionFile[]> {
    const kept: SessionFile[] = [];
    const needPeek: SessionFile[] = [];
    for (const file of files) {
      if (file.mtimeMs <= until) kept.push(file);
      else needPeek.push(file);
    }

    // Peek in small parallel batches: one open+read+close per file is otherwise
    // the dominant cost when a whole day of sessions sits after the range.
    for (let index = 0; index < needPeek.length; index += STAT_BATCH) {
      const batch = needPeek.slice(index, index + STAT_BATCH);
      const peeks = await Promise.all(batch.map((file) => this.firstTimestamp(file)));
      for (const [offset, ts] of peeks.entries()) {
        const file = batch[offset];
        if (file === undefined) continue;
        // `undefined` = no judgement (keep); provably after = drop.
        if (ts !== undefined && ts >= until + TS_ORDER_SLACK_MS) continue;
        kept.push(file);
      }
    }
    return kept;
  }

  /** Cached first-event instant of one session; peeks only when the file changed. */
  private async firstTimestamp(file: SessionFile): Promise<number | undefined> {
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
   * Bring one session's parsed events up to date, bounded in both bytes and
   * memory, and return what that cost.
   *
   * Zero bytes for an unchanged session is the whole point of the cache: the
   * timeline is append-only, so an unchanged `size` means there is no new line.
   * A changed session is re-read whole (up to `maxBytesPerFile`): resuming from a
   * byte offset would save a few KiB per append and cost a state machine that can
   * drift out of sync with the writer, which is not worth it for one bounded
   * file.
   */
  private async readRaw(
    file: SessionFile,
    budget: number,
  ): Promise<{ events: RawEvent[]; bytes_read: number; partial: boolean }> {
    const cached = this.cache.get(file.path);
    if (cached !== undefined) {
      if (file.size < cached.size) {
        // Truncate/rotate (writer recovery cut a torn tail): re-read from the top.
        this.cache.delete(file.path);
      } else if (file.size === cached.size && file.mtimeMs === cached.mtimeMs) {
        cached.usedAt = ++this.clock;
        return { events: cached.events, bytes_read: 0, partial: cached.partial };
      } else {
        this.cache.delete(file.path);
      }
    }

    const limit = Math.max(1, Math.min(this.limits.maxBytesPerFile, budget));
    // One extra byte tells "the window starts right after a newline" apart from
    // "the window cuts a line", so a tail read never drops a whole line for free.
    const want = Math.min(file.size, limit + 1);
    const start = Math.max(0, file.size - want);
    if (file.size <= 0) {
      // A session directory the host created but never wrote to: covered, empty,
      // and not a session we failed to read.
      this.cache.set(file.path, {
        size: 0,
        mtimeMs: file.mtimeMs,
        events: [],
        retained: 0,
        partial: false,
        usedAt: ++this.clock,
      });
      return { events: [], bytes_read: 0, partial: false };
    }

    let buffer: Buffer;
    try {
      buffer = await readRange(file.path, start, file.size - start);
    } catch {
      // Unreadable (permission, vanished mid-call): report it as a partial read so
      // the caller neither counts it as an empty session nor persists an index row
      // that would hide it on the next call.
      this.cache.delete(file.path);
      return { events: [], bytes_read: 0, partial: true };
    }

    let body = buffer;
    let partial = false;
    if (start > 0) {
      if (body.length > 0 && body[0] === NEWLINE) {
        // The window happens to begin on a line boundary: nothing is dropped.
        body = body.subarray(1);
      } else {
        const newline = body.indexOf(NEWLINE);
        body = newline === -1 ? body.subarray(body.length) : body.subarray(newline + 1);
        partial = true;
      }
    }

    const events: RawEvent[] = [];
    let retained = 0;
    let cursor = 0;
    let line = 0;
    while (cursor < body.length) {
      const newline = body.indexOf(NEWLINE, cursor);
      // No newline left = the writer is mid-append. Nothing is buffered: the
      // torn line stays on disk and is picked up by the next call.
      if (newline === -1) break;
      const raw = body.subarray(cursor, newline);
      cursor = newline + 1;
      line += 1;
      const event = parseTimelineLine(raw.toString('utf8'), line);
      if (event === undefined) continue;
      events.push(event);
      retained += raw.length;
    }

    const entry: CachedSession = {
      // The size the events actually describe; a concurrent append leaves this
      // behind `file.size` so the next call re-reads instead of trusting it.
      size: start + buffer.length,
      mtimeMs: file.mtimeMs,
      events,
      retained,
      partial,
      usedAt: ++this.clock,
    };
    this.cache.set(file.path, entry);
    // Retention is enforced *here*, not only at the end of a ranged call: the
    // index rebuild walks every session in turn and would otherwise hold them all.
    this.evict();
    return { events, bytes_read: buffer.length, partial };
  }

  /** Enforce the cache caps by evicting whole sessions, least recently used first. */
  private evict(): void {
    let retained = 0;
    for (const entry of this.cache.values()) retained += entry.retained;
    if (
      this.cache.size <= this.limits.maxCachedFiles &&
      retained <= this.limits.maxRetainedBytesTotal
    ) {
      return;
    }
    // Cost of an eviction is a full re-read of that session on a later call.
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
}

/**
 * Scan `<sessionsDir>/<sessionId>/`: which have a readable timeline, which are
 * pre-0.54 leftovers, and how many directories there are in total.
 *
 * Newest mtime first (id as a stable tie-break). `<sessionId>.json` (the session
 * index) and every other entry are ignored — usage never reads session metadata.
 */
async function scanDir(dir: string): Promise<{
  files: SessionFile[];
  dirs: number;
  legacy: number;
}> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { files: [], dirs: 0, legacy: 0 };
  }

  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
  const files: SessionFile[] = [];
  let legacy = 0;
  // One `stat` per session is the dominant cost of a warm call on Windows
  // (~0.3 ms each), so walk the list in small parallel batches instead of
  // awaiting one file at a time.
  for (let index = 0; index < names.length; index += STAT_BATCH) {
    const batch = names.slice(index, index + STAT_BATCH);
    const infos = await Promise.all(
      batch.map(async (name): Promise<{ file?: SessionFile; legacy: boolean }> => {
        const path = join(dir, name, WAL_LOG);
        try {
          const info = await stat(path);
          if (!info.isFile()) return { legacy: false };
          return {
            file: { id: name, path, size: info.size, mtimeMs: info.mtimeMs },
            legacy: false,
          };
        } catch {
          // No timeline in this directory. It is only worth a second stat when
          // it is a *pre-0.54* session: that is the one case where the user has
          // data we cannot read, and saying so beats reporting zero.
          return { legacy: await hasFile(join(dir, name, LEGACY_LOG)) };
        }
      }),
    );
    for (const info of infos) {
      if (info.file !== undefined) files.push(info.file);
      else if (info.legacy) legacy += 1;
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  return { files, dirs: names.length, legacy };
}

async function hasFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * What is on disk, in one pass: the readable timelines, the unreadable session
 * directories, and the fingerprint the persistent index is validated against.
 */
export async function scanSessions(dataDir: string): Promise<SessionScan> {
  const dir = resolveSingleTenantPaths(dataDir).sessions_dir;
  const scan = await scanDir(dir);
  let bytes = 0;
  let maxMtime = 0;
  for (const file of scan.files) {
    bytes += file.size;
    if (file.mtimeMs > maxMtime) maxMtime = file.mtimeMs;
  }
  return {
    files: scan.files,
    dirs: scan.dirs,
    legacy: scan.legacy,
    sources: { files: scan.files.length, bytes, max_mtime: maxMtime },
  };
}

// ── persistent usage index ──────────────────────────────────────────────────

/**
 * Format version of `usage/index.ndjson`.
 *
 * Bumping it makes every existing index stale, which is the intended upgrade
 * path: the file is a cache, so the reader rebuilds it from the timelines
 * instead of trying to migrate it. v2 changed the source (session timelines
 * instead of `events.ndjson`) **and** the grain (one entry per session with its
 * `(size, mtime)`, so a rebuild only re-reads the sessions that moved).
 */
export const USAGE_INDEX_VERSION = 2;

const USAGE_INDEX_DIR = 'usage';
const USAGE_INDEX_NAME = 'index.ndjson';
const INDEX_HEADER_KIND = 'index';
const INDEX_ENTRY_KIND = 'run';

/** Cheap fingerprint of the session timelines an index was built from. */
export interface IndexSources {
  files: number;
  bytes: number;
  max_mtime: number;
}

/**
 * Staleness check for a persisted index: `files:bytes:max_mtime`.
 *
 * One `stat` sweep produces it, so a reader can decide whether the index still
 * describes the timelines on disk without parsing a single event. Any change to
 * any session (append, new session, deleted session) changes it. It only decides
 * the in-process memo; *what* to re-read is decided per session by the
 * `(size, mtime)` stamps in the index itself.
 */
export function sourceSignature(sources: IndexSources): string {
  return `${sources.files}:${sources.bytes}:${sources.max_mtime}`;
}

/** One session's rows in the index, plus the stamp they were read at. */
export interface IndexedSession {
  id: string;
  /** `wal.log` size when the rows were built. */
  size: number;
  /** `wal.log` mtime (integer ms) when the rows were built. */
  mtime: number;
  runs: RunSummary[];
}

export interface IndexHeader {
  kind: typeof INDEX_HEADER_KIND;
  v: number;
  generated_at: number;
  runs: number;
  sessions: { id: string; size: number; mtime: number; runs: number }[];
  sources: IndexSources;
}

export interface UsageIndex {
  header: IndexHeader;
  sessions: IndexedSession[];
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
 * time, the per-session stamps and the source fingerprint.
 *
 * Callers must **not** write an index built from a truncated read: a partial
 * index would then look authoritative on every later call. The per-session
 * `(size, mtime)` is what makes the next call incremental: only sessions that
 * moved are re-read.
 */
export async function writeUsageIndex(
  dataDir: string,
  sessions: IndexedSession[],
  sources: IndexSources,
): Promise<void> {
  const path = usageIndexPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  let runCount = 0;
  const lines: string[] = [];
  const stamps: IndexHeader['sessions'] = [];
  for (const session of sessions) {
    runCount += session.runs.length;
    stamps.push({
      id: session.id,
      size: session.size,
      mtime: session.mtime,
      runs: session.runs.length,
    });
    for (const run of session.runs) {
      lines.push(
        JSON.stringify({
          v: USAGE_INDEX_VERSION,
          kind: INDEX_ENTRY_KIND,
          session: session.id,
          ...run,
        }),
      );
    }
  }
  const header: IndexHeader = {
    kind: INDEX_HEADER_KIND,
    v: USAGE_INDEX_VERSION,
    generated_at: Date.now(),
    runs: runCount,
    sessions: stamps,
    sources,
  };
  await writeFileAtomic(path, `${[JSON.stringify(header), ...lines].join('\n')}\n`);
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

/** One `sessions[]` header stamp, validated field by field. */
function parseIndexStamp(
  value: unknown,
): { id: string; size: number; mtime: number; runs: number } | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.id;
  const size = value.size;
  const mtime = value.mtime;
  const runs = value.runs;
  if (typeof id !== 'string' || id === '') return undefined;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return undefined;
  if (typeof mtime !== 'number' || !Number.isFinite(mtime)) return undefined;
  if (typeof runs !== 'number' || !Number.isFinite(runs) || runs < 0) return undefined;
  return { id, size, mtime, runs };
}

/**
 * Read the index, or `undefined` when it is missing, unreadable, written by
 * another format version, or corrupt.
 *
 * Every failure means "no index", never "no data": the caller rebuilds from the
 * session timelines (the source of truth) and overwrites the file. The per-
 * session row counts in the header are checked against the rows themselves — an
 * index whose header promises more rows than it holds is a torn write, and
 * re-reading beats serving it.
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
  if (!Array.isArray(header.sessions)) return undefined;

  const stamps = new Map<string, { size: number; mtime: number; runs: number }>();
  for (const raw of header.sessions) {
    const stamp = parseIndexStamp(raw);
    if (stamp === undefined) return undefined;
    stamps.set(stamp.id, { size: stamp.size, mtime: stamp.mtime, runs: stamp.runs });
  }

  const grouped = new Map<string, RunSummary[]>();
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
    const session = parsed.session;
    if (typeof session !== 'string' || session === '') return undefined;
    const run = parseIndexEntry(parsed);
    if (run === undefined) return undefined;
    const bucket = grouped.get(session);
    if (bucket === undefined) grouped.set(session, [run]);
    else bucket.push(run);
  }

  const sessions: IndexedSession[] = [];
  for (const [id, stamp] of stamps) {
    const runs = grouped.get(id) ?? [];
    // Header said N rows for this session; a different count is a torn index.
    if (runs.length !== stamp.runs) return undefined;
    sessions.push({ id, size: stamp.size, mtime: stamp.mtime, runs });
  }
  // Rows for a session the header does not declare cannot be attributed.
  if (grouped.size !== stamps.size) return undefined;

  return {
    header: {
      kind: INDEX_HEADER_KIND,
      v: USAGE_INDEX_VERSION,
      generated_at: generatedAt,
      runs: sessions.reduce((total, session) => total + session.runs.length, 0),
      sessions: [...stamps.entries()].map(([id, stamp]) => ({ id, ...stamp })),
      sources: { files, bytes, max_mtime: maxMtime },
    },
    sessions,
  };
}

/**
 * Fingerprint the timelines without reading them: session count, total bytes and
 * the newest mtime. One `stat` per session, and it is what lets the reader trust
 * a persisted index without parsing a single event.
 */
export async function readSessionSources(dataDir: string): Promise<IndexSources> {
  return (await scanSessions(dataDir)).sources;
}
