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
  daysCutoff,
  type LeaderboardResult,
  type LogsParams,
  type LogsResult,
  leaderboard,
  listLogs,
  type SourceCoverage,
  type SummaryResult,
  summarize,
  type UsageRecord,
} from './aggregate.js';
import { EventStore, isRecord, parseSettings, type Settings } from './store.js';

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
 * Read the trace and fold it into records.
 *
 * `cutoff` is the range the caller asked for (`daysCutoff`); it goes into the
 * *reader* so the disk window follows the selected range instead of the read
 * budget alone. `undefined` = no range (whole directory, budget-bounded), which
 * is what "All time" and the Logs page ask for.
 */
async function loadSnapshot(cutoff?: number): Promise<{
  records: UsageRecord[];
  source: SourceCoverage;
}> {
  if (dataDir === undefined) throw new RpcError(-32000, 'plugin is not activated');
  const loaded = await store.loadEvents(dataDir, cutoff === undefined ? {} : { cutoff });
  return {
    records: buildRecords(loaded.events, settings),
    source: {
      truncated: loaded.truncated,
      files_truncated: loaded.files_truncated,
      partial_files: loaded.partial_files,
      files_read: loaded.files_covered,
      files_in_window: loaded.files_in_window,
      files_total: loaded.files_total,
    },
  };
}

/** `days` -> the instant the reader windows on; `undefined` for "all time". */
function cutoffFor(now: number, days: number | undefined): number | undefined {
  return days === undefined ? undefined : daysCutoff(now, days);
}

async function handleSummary(params: Record<string, unknown>): Promise<SummaryResult> {
  const days = parseOptionalDays(params.days);
  const now = Date.now();
  const snapshot = await loadSnapshot(cutoffFor(now, days));
  return { ...summarize(snapshot.records, now, days), source: snapshot.source };
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
  const logsParams: LogsParams = {
    limit: parseLimit(params.limit),
    ...(cursorTs !== undefined ? { before_ts: cursorTs } : {}),
    ...(cursorId !== undefined ? { before_id: cursorId } : {}),
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(status !== undefined ? { status } : {}),
  };
  const snapshot = await loadSnapshot();
  return { ...listLogs(snapshot.records, logsParams), source: snapshot.source };
}

async function handleLeaderboard(params: Record<string, unknown>): Promise<LeaderboardResult> {
  const days = parseOptionalDays(params.days);
  const now = Date.now();
  const snapshot = await loadSnapshot(cutoffFor(now, days));
  return { ...leaderboard(snapshot.records, now, days), source: snapshot.source };
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
