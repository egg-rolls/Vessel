/**
 * Aggregation for the Usage plugin.
 *
 * Pure functions: persisted events + settings in, JSON DTOs out. No file I/O
 * and no host objects. Missing counters stay `undefined` (never `0`), because
 * "provider did not report cache" and "cache was zero" must render
 * differently. Costs follow the same rule: a model without a configured price
 * has no cost, so the UI can show `—` instead of a misleading `$0`.
 *
 * @module @vessel-agent/plugin-usage
 */

import { isRecord, type RawEvent, type Settings } from './store.js';

const COST_DIVISOR = 1_000_000;

/** One request (or failed run) as shown in Logs. */
export interface UsageRecord {
  id: string;
  ts: number;
  tenant: string;
  run_id: string;
  session_id?: string;
  model: string;
  status: 'ok' | 'failed';
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  duration_ms?: number;
  cost?: number;
}

/** Token/request totals shared by Summary totals and per-day rows. */
export interface Totals {
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  failed_runs: number;
}

export interface DayBucket extends Totals {
  date: string;
  cost?: number;
}

export interface ModelBucket {
  model: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cost?: number;
}

export type CacheUnavailableReason =
  | 'no-requests'
  | 'no-cache-fields'
  | 'zero-denominator'
  | 'prompt-not-inclusive'
  | 'write-not-reported';

export interface SummaryResult {
  has_data: boolean;
  totals: Totals;
  by_day: DayBucket[];
  by_model: ModelBucket[];
  input_share?: number;
  input_share_unavailable?: CacheUnavailableReason;
  prefix_health?: number;
  prefix_health_unavailable?: CacheUnavailableReason;
  cost?: number;
}

export interface LogItem {
  id: string;
  ts: number;
  tenant: string;
  run_id: string;
  session_id?: string;
  model: string;
  status: 'ok' | 'failed';
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  duration_ms?: number;
  cost?: number;
}

export interface LogsParams {
  limit: number;
  before_ts?: number;
  before_id?: string;
  session_id?: string;
  model?: string;
  status?: 'ok' | 'failed';
}

export interface LogsResult {
  items: LogItem[];
  next_cursor: { before_ts: number; before_id: string } | null;
}

export interface LeaderboardResult {
  items: ModelBucket[];
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Parse `model: <id>` from the Self Card that Vessel injects into the system
 * message. Only messages that actually contain `[Self Card]` are considered,
 * so an unrelated `model:` line in a user message cannot hijack attribution.
 */
function selfCardModel(data: Record<string, unknown>): string | undefined {
  const messages = data.messages;
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const content = message.content;
    if (typeof content !== 'string' || !content.includes('[Self Card]')) continue;
    const match = /^model:\s*(.+)$/m.exec(content);
    const model = match?.[1]?.trim();
    if (model !== undefined && model.length > 0) return model;
  }
  return undefined;
}

function modelFor(settings: Settings, hint: string | undefined): string {
  return settings.default_model ?? hint ?? 'unknown';
}

/**
 * Cost of one response, or `undefined` when the model has no price or the
 * response carried no usage at all. Cache counters are subsets of
 * `prompt_tokens`; the non-cached slice is clamped at zero so a provider that
 * reports inconsistent counters cannot produce a negative cost.
 */
function costFor(record: UsageRecord, settings: Settings): number | undefined {
  if (record.prompt_tokens === undefined && record.completion_tokens === undefined)
    return undefined;
  const price = settings.prices[record.model];
  if (price === undefined) return undefined;

  const prompt = record.prompt_tokens ?? 0;
  const completion = record.completion_tokens ?? 0;
  const read = record.cache_read_input_tokens ?? 0;
  const write = record.cache_creation_input_tokens ?? 0;
  const nonCached = Math.max(0, prompt - read - write);
  return (
    (nonCached * price.input_per_1m +
      read * price.cache_read_per_1m +
      write * price.cache_write_per_1m +
      completion * price.output_per_1m) /
    COST_DIVISOR
  );
}

function recordId(event: RawEvent): string {
  return `${event.tenant}:${event.run_id}:${event.seq ?? event.line}`;
}

/**
 * Fold raw events into one record per `llm.response` plus one failed record
 * per `run.failed`. `llm.request` supplies the duration of the following
 * response and the Self Card model hint.
 */
export function buildRecords(events: RawEvent[], settings: Settings): UsageRecord[] {
  const records: UsageRecord[] = [];
  const lastRequest = new Map<string, { ts: number; model?: string }>();

  for (const event of events) {
    const key = `${event.tenant}\u0000${event.run_id}`;

    if (event.type === 'llm.request') {
      const hint = selfCardModel(event.data);
      lastRequest.set(key, { ts: event.ts, ...(hint !== undefined ? { model: hint } : {}) });
      continue;
    }

    if (event.type === 'llm.response') {
      const usage = isRecord(event.data.usage) ? event.data.usage : undefined;
      const request = lastRequest.get(key);
      const record: UsageRecord = {
        id: recordId(event),
        ts: event.ts,
        tenant: event.tenant,
        run_id: event.run_id,
        model: modelFor(settings, request?.model),
        status: 'ok',
        ...(optionalString(event.data.session_id) !== undefined
          ? { session_id: optionalString(event.data.session_id) }
          : {}),
        ...(usage !== undefined && optionalNumber(usage.prompt_tokens) !== undefined
          ? { prompt_tokens: optionalNumber(usage.prompt_tokens) }
          : {}),
        ...(usage !== undefined && optionalNumber(usage.completion_tokens) !== undefined
          ? { completion_tokens: optionalNumber(usage.completion_tokens) }
          : {}),
        ...(usage !== undefined && optionalNumber(usage.cache_read_input_tokens) !== undefined
          ? { cache_read_input_tokens: optionalNumber(usage.cache_read_input_tokens) }
          : {}),
        ...(usage !== undefined && optionalNumber(usage.cache_creation_input_tokens) !== undefined
          ? { cache_creation_input_tokens: optionalNumber(usage.cache_creation_input_tokens) }
          : {}),
        ...(request !== undefined && event.ts >= request.ts
          ? { duration_ms: event.ts - request.ts }
          : {}),
      };
      record.cost = costFor(record, settings);
      records.push(record);
      continue;
    }

    if (event.type === 'run.failed') {
      const request = lastRequest.get(key);
      records.push({
        id: recordId(event),
        ts: event.ts,
        tenant: event.tenant,
        run_id: event.run_id,
        model: modelFor(settings, request?.model),
        status: 'failed',
        ...(optionalString(event.data.session_id) !== undefined
          ? { session_id: optionalString(event.data.session_id) }
          : {}),
      });
    }
  }

  return records;
}

/** Local calendar day key (`YYYY-MM-DD`). */
export function dayKey(ts: number): string {
  const date = new Date(ts);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Start of the oldest included calendar day. `days: 1` means "today",
 * `days: 3` means today plus the previous two days.
 */
export function daysCutoff(now: number, days: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

export function filterByDays(records: UsageRecord[], now: number, days?: number): UsageRecord[] {
  if (days === undefined) return records;
  const cutoff = daysCutoff(now, days);
  return records.filter((record) => record.ts >= cutoff);
}

interface Counter {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
  cacheReadReported: boolean;
  cacheWrite: number;
  cacheWriteReported: boolean;
  cost: number;
  costMissing: boolean;
  failedRuns: number;
}

function counter(): Counter {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheRead: 0,
    cacheReadReported: false,
    cacheWrite: 0,
    cacheWriteReported: false,
    cost: 0,
    costMissing: false,
    failedRuns: 0,
  };
}

function addRecord(target: Counter, record: UsageRecord): void {
  if (record.status === 'failed') {
    target.failedRuns += 1;
    return;
  }
  target.requests += 1;
  target.promptTokens += record.prompt_tokens ?? 0;
  target.completionTokens += record.completion_tokens ?? 0;
  if (record.cache_read_input_tokens !== undefined) {
    target.cacheReadReported = true;
    target.cacheRead += record.cache_read_input_tokens;
  }
  if (record.cache_creation_input_tokens !== undefined) {
    target.cacheWriteReported = true;
    target.cacheWrite += record.cache_creation_input_tokens;
  }
  if (record.cost === undefined) {
    target.costMissing = true;
  } else {
    target.cost += record.cost;
  }
}

function totalsOf(target: Counter): Totals {
  return {
    requests: target.requests,
    prompt_tokens: target.promptTokens,
    completion_tokens: target.completionTokens,
    ...(target.cacheReadReported ? { cache_read_tokens: target.cacheRead } : {}),
    ...(target.cacheWriteReported ? { cache_creation_tokens: target.cacheWrite } : {}),
    failed_runs: target.failedRuns,
  };
}

function costOf(target: Counter): number | undefined {
  if (target.requests === 0 || target.costMissing) return undefined;
  return target.cost;
}

interface Ratios {
  input_share?: number;
  input_share_unavailable?: CacheUnavailableReason;
  prefix_health?: number;
  prefix_health_unavailable?: CacheUnavailableReason;
}

function cacheRatios(records: UsageRecord[]): Ratios {
  const ok = records.filter((record) => record.status === 'ok');
  if (ok.length === 0) {
    return { input_share_unavailable: 'no-requests', prefix_health_unavailable: 'no-requests' };
  }

  let promptTotal = 0;
  let readTotal = 0;
  let writeTotal = 0;
  let readReported = false;
  let writeReported = false;
  for (const record of ok) {
    promptTotal += record.prompt_tokens ?? 0;
    if (record.cache_read_input_tokens !== undefined) {
      readReported = true;
      readTotal += record.cache_read_input_tokens;
    }
    if (record.cache_creation_input_tokens !== undefined) {
      writeReported = true;
      writeTotal += record.cache_creation_input_tokens;
    }
  }

  if (!readReported && !writeReported) {
    return {
      input_share_unavailable: 'no-cache-fields',
      prefix_health_unavailable: 'no-cache-fields',
    };
  }
  if (readTotal + writeTotal === 0) {
    return {
      input_share_unavailable: 'zero-denominator',
      prefix_health_unavailable: 'zero-denominator',
    };
  }

  const result: Ratios = {};
  if (!readReported) {
    result.input_share_unavailable = 'no-cache-fields';
  } else if (promptTotal <= 0) {
    result.input_share_unavailable = 'zero-denominator';
  } else if (promptTotal < readTotal + writeTotal) {
    // The contract requires `prompt_tokens` to include cache counters; seeing
    // more cache than prompt means the adapter did not normalize, so any ratio
    // would be fabricated.
    result.input_share_unavailable = 'prompt-not-inclusive';
  } else {
    result.input_share = readTotal / promptTotal;
  }

  if (!readReported) {
    result.prefix_health_unavailable = 'no-cache-fields';
  } else if (!writeReported) {
    // A missing write side is not zero: treating it as zero makes the ratio
    // collapse to 100% (read / read), which is exactly the fake reading the
    // contract forbids.
    result.prefix_health_unavailable = 'write-not-reported';
  } else {
    result.prefix_health = readTotal / (readTotal + writeTotal);
  }
  return result;
}

function totalTokens(bucket: Pick<ModelBucket, 'prompt_tokens' | 'completion_tokens'>): number {
  return bucket.prompt_tokens + bucket.completion_tokens;
}

function modelBuckets(records: UsageRecord[]): ModelBucket[] {
  const counters = new Map<string, Counter>();
  for (const record of records) {
    if (record.status !== 'ok') continue;
    const target = counters.get(record.model) ?? counter();
    addRecord(target, record);
    counters.set(record.model, target);
  }

  const buckets: ModelBucket[] = [];
  for (const [model, target] of counters) {
    buckets.push({
      model,
      requests: target.requests,
      prompt_tokens: target.promptTokens,
      completion_tokens: target.completionTokens,
      ...(target.cacheReadReported ? { cache_read_tokens: target.cacheRead } : {}),
      ...(target.cacheWriteReported ? { cache_creation_tokens: target.cacheWrite } : {}),
      ...(costOf(target) !== undefined ? { cost: costOf(target) } : {}),
    });
  }
  buckets.sort(
    (a, b) =>
      totalTokens(b) - totalTokens(a) || b.requests - a.requests || a.model.localeCompare(b.model),
  );
  return buckets;
}

export function summarize(records: UsageRecord[], now: number, days?: number): SummaryResult {
  const filtered = filterByDays(records, now, days);
  const overall = counter();
  const dayCounters = new Map<string, Counter>();
  for (const record of filtered) {
    addRecord(overall, record);
    const key = dayKey(record.ts);
    const target = dayCounters.get(key) ?? counter();
    addRecord(target, record);
    dayCounters.set(key, target);
  }

  const byDay: DayBucket[] = [];
  for (const [date, target] of dayCounters) {
    const cost = costOf(target);
    byDay.push({
      date,
      ...totalsOf(target),
      ...(cost !== undefined ? { cost } : {}),
    });
  }
  byDay.sort((a, b) => b.date.localeCompare(a.date));

  const ratios = cacheRatios(filtered);
  const cost = costOf(overall);
  return {
    has_data: filtered.length > 0,
    totals: totalsOf(overall),
    by_day: byDay,
    by_model: modelBuckets(filtered),
    ...ratios,
    ...(cost !== undefined ? { cost } : {}),
  };
}

function compareDesc(a: UsageRecord, b: UsageRecord): number {
  if (a.ts !== b.ts) return b.ts - a.ts;
  return b.id.localeCompare(a.id);
}

function afterCursor(
  record: UsageRecord,
  beforeTs: number | undefined,
  beforeId: string | undefined,
): boolean {
  if (beforeTs === undefined) return true;
  if (record.ts !== beforeTs) return record.ts < beforeTs;
  if (beforeId === undefined) return false;
  return record.id.localeCompare(beforeId) < 0;
}

function toLogItem(record: UsageRecord): LogItem {
  return {
    id: record.id,
    ts: record.ts,
    tenant: record.tenant,
    run_id: record.run_id,
    ...(record.session_id !== undefined ? { session_id: record.session_id } : {}),
    model: record.model,
    status: record.status,
    ...(record.prompt_tokens !== undefined ? { prompt_tokens: record.prompt_tokens } : {}),
    ...(record.completion_tokens !== undefined
      ? { completion_tokens: record.completion_tokens }
      : {}),
    ...(record.cache_read_input_tokens !== undefined
      ? { cache_read_input_tokens: record.cache_read_input_tokens }
      : {}),
    ...(record.cache_creation_input_tokens !== undefined
      ? { cache_creation_input_tokens: record.cache_creation_input_tokens }
      : {}),
    ...(record.duration_ms !== undefined ? { duration_ms: record.duration_ms } : {}),
    ...(record.cost !== undefined ? { cost: record.cost } : {}),
  };
}

export function listLogs(records: UsageRecord[], params: LogsParams): LogsResult {
  const matched = records.filter((record) => {
    if (params.status !== undefined && record.status !== params.status) return false;
    if (params.session_id !== undefined && record.session_id !== params.session_id) return false;
    if (params.model !== undefined && record.model !== params.model) return false;
    return afterCursor(record, params.before_ts, params.before_id);
  });
  matched.sort(compareDesc);

  const page = matched.slice(0, params.limit);
  const last = page[page.length - 1];
  const next =
    matched.length > params.limit && last !== undefined
      ? { before_ts: last.ts, before_id: last.id }
      : null;

  return { items: page.map(toLogItem), next_cursor: next };
}

export function leaderboard(records: UsageRecord[], now: number, days?: number): LeaderboardResult {
  return { items: modelBuckets(filterByDays(records, now, days)) };
}
