/**
 * Usage plugin — child-process entry and protocol runtime.
 *
 * Wire format (CONTRACT-0.43 §3): newline-delimited JSON-RPC 2.0 on stdout.
 * stderr is reserved for diagnostics and is never parsed by the host.
 *
 * Methods handled here:
 * - `plugin.hello`      -> `{protocol: 1, ok: true}`
 * - `plugin.activate`   -> `{ok: true}` / `{ok: false, error}`
 * - `plugin.event`      -> `{ok: true}` (history is read from persisted logs)
 * - `plugin.rpc`        -> summary / logs / leaderboard DTOs
 * - `plugin.deactivate` -> `{ok: true}`, then exit
 * - `ping`              -> `pong` (request result or notification)
 *
 * @module @vessel-agent/plugin-usage
 */

import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import {
  buildRecords,
  buildRunSummaries,
  type LeaderboardResult,
  type LogsParams,
  type LogsRangeInput,
  type LogsResult,
  leaderboardRuns,
  listLogs,
  repriceRuns,
  resolveLogsRange,
  type SourceCoverage,
  type SummaryResult,
  summarizeRuns,
  type UsageRecord,
} from './aggregate.js';
import {
  EventStore,
  isRecord,
  parseSettings,
  readSessionSources,
  readUsageIndex,
  type RunSummary,
  sourceSignature,
  type Settings,
  writeUsageIndex,
} from './store.js';

const PROTOCOL_VERSION = 1;
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 500;
const MAX_DAYS = 3650;

const store = new EventStore();
let settings: Settings = { prices: {} };
let dataDir: string | undefined;
let activated = false;
let exitScheduled = false;

class RpcError extends Error {
  readonly code: number;
  readonly data?: Record<string, unknown>;

  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function log(message: string): void {
  process.stderr.write(`[usage] ${message}\n`);
}

function send(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function invalid(message: string): RpcError {
  return new RpcError(-32602, message, { code: 'invalid_params' });
}

function scheduleExit(): void {
  if (exitScheduled) return;
  exitScheduled = true;
  // Give stdout a tick to flush the deactivate response before the host
  // observes the exit. The host also SIGTERMs after its 2s grace period.
  setTimeout(() => process.exit(0), 20);
}

/**
 * `plugin.activate.dataDir` is the global Vessel data dir. The env fallback
 * derives it from the contract's `VESSEL_PLUGIN_DATA_DIR=<dataDir>/plugins/<id>`
 * shape when the host omits the field.
 */
function resolveDataDir(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  const pluginDataDir = process.env.VESSEL_PLUGIN_DATA_DIR;
  if (typeof pluginDataDir === 'string' && pluginDataDir.length > 0) {
    return dirname(dirname(pluginDataDir));
  }
  return undefined;
}

function parseOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${name} must be a string`);
  return value;
}

function parseOptionalDays(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid('days must be a number');
  }
  const days = Math.floor(value);
  if (days < 1 || days > MAX_DAYS) throw invalid(`days must be between 1 and ${MAX_DAYS}`);
  return days;
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LOG_LIMIT;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid('limit must be a number');
  }
  return Math.min(MAX_LOG_LIMIT, Math.max(1, Math.floor(value)));
}

function parseStatus(value: unknown): 'ok' | 'failed' | undefined {
  if (value === undefined) return undefined;
  if (value === 'ok' || value === 'failed') return value;
  throw invalid("status must be 'ok' or 'failed'");
}

/**
 * Read the session logs and fold them into request records (the Logs page path).
 *
 * `range.cutoff` is the lower bound of the selected range (`cutoffFor`); it goes
 * into the *reader* so the disk window follows the selected range instead of the
 * read budget alone. `range.until` reorders the reader and, with an `until`
 * bound, lets it drop sessions that provably start after the range (the
 * per-record `[since, until)` filter lives in `listLogs`). `undefined` = no range.
 */
async function loadSnapshot(range: {
  cutoff?: number;
  until?: number;
} = {}): Promise<{
  records: UsageRecord[];
  source: SourceCoverage;
}> {
  if (dataDir === undefined) throw new RpcError(-32000, 'plugin is not activated');
  const loaded = await store.loadEvents(dataDir, range);
  return {
    records: buildRecords(loaded.events, settings),
    source: coverageOf(loaded),
  };
}

function coverageOf(loaded: {
  truncated: boolean;
  files_truncated: boolean;
  partial_files: number;
  files_covered: number;
  files_in_window: number;
  files_total: number;
}): SourceCoverage {
  return {
    truncated: loaded.truncated,
    files_truncated: loaded.files_truncated,
    partial_files: loaded.partial_files,
    files_read: loaded.files_covered,
    files_in_window: loaded.files_in_window,
    files_total: loaded.files_total,
  };
}

/**
 * How long a freshly built/read index is reused without re-fingerprinting.
 *
 * `summary` and `leaderboard` are requested together on every page render, and a
 * fingerprint costs one `stat` per session; a short memo turns two sweeps into
 * one without ever serving a stale answer for longer than a page open. New runs
 * still show up on the next render (or after this window).
 */
const INDEX_MEMO_MS = 1_500;

interface RunSnapshot {
  runs: RunSummary[];
  source: SourceCoverage;
}

let runsMemo: { at: number; signature: string; snapshot: RunSnapshot } | undefined;

/**
 * Load run summaries for `summary` / `leaderboard`: the persisted index when it
 * is fresh, otherwise a rebuild from the session logs.
 *
 * The index is a **cache, not the truth**: it is trusted only when its format
 * version matches and its source fingerprint (file count, total bytes, newest
 * mtime) equals what is on disk right now. Anything else — missing file, older
 * version, corrupt line, a new run, a deleted session — falls back to the logs
 * and rewrites the index. A rebuild that had to truncate is **not** persisted,
 * so a partial view can never masquerade as complete later.
 */
async function loadRuns(): Promise<RunSnapshot> {
  if (dataDir === undefined) throw new RpcError(-32000, 'plugin is not activated');
  const dir = dataDir;
  const sources = await readSessionSources(dir);
  const signature = sourceSignature(sources);

  const memo = runsMemo;
  if (memo !== undefined && memo.signature === signature && Date.now() - memo.at < INDEX_MEMO_MS) {
    return memo.snapshot;
  }

  const indexed = await readUsageIndex(dir);
  if (indexed !== undefined && sourceSignature(indexed.header.sources) === signature) {
    // The index covers every session on disk by construction, so its coverage is
    // complete: there is nothing left unread to warn about. Prices are applied
    // now, not taken from the stored rows (see `repriceRuns`).
    const snapshot: RunSnapshot = {
      runs: repriceRuns(indexed.runs, settings),
      source: {
        truncated: false,
        files_truncated: false,
        partial_files: 0,
        files_read: sources.files,
        files_in_window: sources.files,
        files_total: sources.files,
      },
    };
    runsMemo = { at: Date.now(), signature, snapshot };
    return snapshot;
  }

  const loaded = await store.loadEvents(dir);
  const runs = repriceRuns(buildRunSummaries(buildRecords(loaded.events, settings)), settings);
  const snapshot: RunSnapshot = { runs, source: coverageOf(loaded) };
  if (!loaded.truncated && !loaded.files_truncated) {
    try {
      await writeUsageIndex(dir, runs, sources);
    } catch (error) {
      // The index is an optimisation: failing to write it must not fail the RPC.
      log(`usage index not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  runsMemo = { at: Date.now(), signature, snapshot };
  return snapshot;
}

async function handleSummary(params: Record<string, unknown>): Promise<SummaryResult> {
  const days = parseOptionalDays(params.days);
  const now = Date.now();
  const snapshot = await loadRuns();
  return { ...summarizeRuns(snapshot.runs, now, days), source: snapshot.source };
}

function parseOptionalEpoch(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`${name} must be a number (ms since epoch)`);
  }
  return value;
}

async function handleLogs(params: Record<string, unknown>): Promise<LogsResult> {
  const cursorTs = params.before_ts;
  if (cursorTs !== undefined && (typeof cursorTs !== 'number' || !Number.isFinite(cursorTs))) {
    throw invalid('before_ts must be a number');
  }
  const cursorId = parseOptionalString(params.before_id, 'before_id');
  const sessionId = parseOptionalString(params.session_id, 'session_id');
  const model = parseOptionalString(params.model, 'model');
  const status = parseStatus(params.status);
  const days = parseOptionalDays(params.days);
  const since = parseOptionalEpoch(params.since, 'since');
  const until = parseOptionalEpoch(params.until, 'until');

  // Same resolver (and therefore the same `cutoffFor`) as summary/leaderboard:
  // `days` is one range syntax, `since`/`until` the other, never both.
  const rangeInput: LogsRangeInput = {
    ...(days !== undefined ? { days } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
  };
  const range = resolveLogsRange(rangeInput, Date.now());
  if (!range.ok) throw invalid(range.message);

  const logsParams: LogsParams = {
    limit: parseLimit(params.limit),
    ...(cursorTs !== undefined ? { before_ts: cursorTs } : {}),
    ...(cursorId !== undefined ? { before_id: cursorId } : {}),
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(range.since !== undefined ? { since: range.since } : {}),
    ...(range.until !== undefined ? { until: range.until } : {}),
  };
  const snapshot = await loadSnapshot({ cutoff: range.cutoff, until: range.until });
  return { ...listLogs(snapshot.records, logsParams), source: snapshot.source };
}

async function handleLeaderboard(params: Record<string, unknown>): Promise<LeaderboardResult> {
  const days = parseOptionalDays(params.days);
  const now = Date.now();
  const snapshot = await loadRuns();
  return { ...leaderboardRuns(snapshot.runs, now, days), source: snapshot.source };
}

async function handleRpc(params: unknown): Promise<unknown> {
  if (!isRecord(params)) throw invalid('params must be an object');
  const name = params.name;
  if (typeof name !== 'string' || name.length === 0) throw invalid('params.name is required');
  if (!activated)
    throw new RpcError(-32000, 'plugin is not activated', { code: 'plugin_not_activated' });
  const args = isRecord(params.params) ? params.params : {};

  switch (name) {
    case 'summary':
      return handleSummary(args);
    case 'logs':
      return handleLogs(args);
    case 'leaderboard':
      return handleLeaderboard(args);
    default:
      throw new RpcError(-32601, `Unknown rpc: ${name}`, { code: 'method_not_found' });
  }
}

async function activate(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parsed = parseSettings(params.settings);
  if (!parsed.ok) {
    return { ok: false, error: { code: 'plugin_config_invalid', message: parsed.error } };
  }

  const dir = resolveDataDir(params.dataDir);
  if (dir === undefined) {
    return {
      ok: false,
      error: { code: 'plugin_config_invalid', message: 'dataDir is required' },
    };
  }

  settings = parsed.settings;
  dataDir = dir;
  activated = true;
  store.reset();
  // A different data dir means a different index and a different session set.
  runsMemo = undefined;
  log(`activated with ${Object.keys(settings.prices).length} price entries`);
  return { ok: true };
}

async function dispatch(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'plugin.hello': {
      const protocol = isRecord(params) ? params.protocol : undefined;
      if (protocol !== PROTOCOL_VERSION) {
        return {
          protocol: PROTOCOL_VERSION,
          ok: false,
          error: { code: 'plugin_protocol_mismatch' },
        };
      }
      return { protocol: PROTOCOL_VERSION, ok: true };
    }
    case 'plugin.activate': {
      if (!isRecord(params)) throw invalid('params must be an object');
      return activate(params);
    }
    case 'plugin.event':
      // Live events are not duplicated into a second store. RPCs read the
      // host's persisted trace, so nothing to do but acknowledge.
      return { ok: true };
    case 'plugin.deactivate':
      activated = false;
      store.reset();
      return { ok: true };
    case 'plugin.rpc':
      return handleRpc(params);
    case 'ping':
      return 'pong';
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

async function handleLine(line: string): Promise<void> {
  if (exitScheduled) return;
  const trimmed = line.trim();
  if (trimmed === '') return;

  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    log('dropped a non-JSON stdin line');
    return;
  }
  if (!isRecord(message) || typeof message.method !== 'string') return;

  const method = message.method;
  const id = message.id;
  const isRequest = typeof id === 'string' || typeof id === 'number';

  if (method === 'ping' && !isRequest) {
    send({ jsonrpc: '2.0', method: 'pong' });
    return;
  }

  try {
    const result = await dispatch(method, message.params);
    if (isRequest) send({ jsonrpc: '2.0', id, result });
    if (method === 'plugin.deactivate') scheduleExit();
  } catch (error) {
    if (error instanceof RpcError) {
      log(`${method} failed: ${error.message}`);
      if (isRequest) {
        send({
          jsonrpc: '2.0',
          id,
          error: {
            code: error.code,
            message: error.message,
            ...(error.data !== undefined ? { data: error.data } : {}),
          },
        });
      }
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    log(`${method} failed: ${reason}`);
    if (isRequest) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'internal error' } });
    }
  }
}

function main(): void {
  log('starting');
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue: Promise<void> = Promise.resolve();
  rl.on('line', (line) => {
    queue = queue.then(() => handleLine(line));
  });
  rl.on('close', () => {
    void queue.then(() => scheduleExit());
  });

  const stop = (): void => {
    activated = false;
    store.reset();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
