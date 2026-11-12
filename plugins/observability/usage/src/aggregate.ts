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
  /** The response's model has no configured price entry. */
  unpriced?: boolean;
  /** Failed runs only: true when the run died with an unanswered llm.request. */
  in_flight?: boolean;
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
  /** Rows in this bucket whose model has no configured price. */
  unpriced_requests: number;
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
  /** Sum of priced rows only; absent when no row had a configured price. */
  cost?: number;
  /** Rows excluded from `cost` because their model has no price. */
  unpriced_requests: number;
}

export interface LogItem {
  id: string;
  ts: number;
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
 * Attribution of one `llm.request`, most trustworthy source first:
 *
 * 1. `data.model` — the model the request actually used (published by the
 *    runtime, kept by the trace summary). A configured default must never
 *    relabel this: otherwise setting `default_model` once makes every row show
 *    the setting instead of reality.
 * 2. `settings.default_model` — explicit operator configuration.
 * 3. `'unknown'` — never invent a model id.
 *
 * `model` used to be scraped out of the injected Self Card with a regex over
 * `data.messages`. That is gone, and must not come back: the Self Card is only
 * concatenated into the system prompt while the request is assembled
 * (`composeRunSystemPrompt`), it never becomes a message and never rides an
 * event, and the trace stores `llm.request` as its summary with `messages`
 * dropped. So `data.messages` never exists on a persisted event and that parse
 * could not succeed even on old traces. The model name is written into
 * `data.model` by the producer instead.
 */
function modelFor(settings: Settings, hint: string | undefined): string {
  return hint ?? settings.default_model ?? 'unknown';
}

interface CostResult {
  cost?: number;
  /** The response's model has no configured price entry. */
  unpriced: boolean;
}

/**
 * Cost of one response. Cache counters are subsets of `prompt_tokens`; the
 * non-cached slice is clamped at zero so a provider that reports inconsistent
 * counters cannot produce a negative cost. A response without usage has no
 * cost but is not "unpriced" — there was simply nothing to bill.
 */
function costFor(record: UsageRecord, settings: Settings): CostResult {
  if (record.prompt_tokens === undefined && record.completion_tokens === undefined) {
    return { unpriced: false };
  }
  const price = settings.prices[record.model];
  if (price === undefined) return { unpriced: true };

  const prompt = record.prompt_tokens ?? 0;
  const completion = record.completion_tokens ?? 0;
  const read = record.cache_read_input_tokens ?? 0;
  const write = record.cache_creation_input_tokens ?? 0;
  const nonCached = Math.max(0, prompt - read - write);
  return {
    cost:
      (nonCached * price.input_per_1m +
        read * price.cache_read_per_1m +
        write * price.cache_write_per_1m +
        completion * price.output_per_1m) /
      COST_DIVISOR,
    unpriced: false,
  };
}

function recordId(event: RawEvent): string {
  return `${event.run_id}:${event.seq ?? event.line}`;
}

/**
 * Fold raw events into one record per `llm.response`, plus one failed record
 * per `run.failed`. `llm.request` supplies the duration of the following
 * response and the model attribution (its `model` field).
 *
 * A failed run is run-level, not an LLM request. It is counted in summary but
 * only appears in Logs when it left an `llm.request` unanswered (`in_flight`);
 * otherwise there is no request row to show.
 */
export function buildRecords(events: RawEvent[], settings: Settings): UsageRecord[] {
  const records: UsageRecord[] = [];
  const pending = new Map<string, { ts: number; model?: string }>();
  const lastHint = new Map<string, string | undefined>();

  for (const event of events) {
    const key = event.run_id;

    if (event.type === 'llm.request') {
      // `data.model` is the only place a persisted event carries the model:
      // the summary keeps it (`{...data}` passthrough) while `messages` — the
      // old Self Card source — is dropped before the trace is written.
      const hint = optionalString(event.data.model);
      pending.set(key, { ts: event.ts, ...(hint !== undefined ? { model: hint } : {}) });
      lastHint.set(key, hint);
      continue;
    }

    if (event.type === 'llm.response') {
      const usage = isRecord(event.data.usage) ? event.data.usage : undefined;
      const request = pending.get(key);
      pending.delete(key);
      const record: UsageRecord = {
        id: recordId(event),
        ts: event.ts,
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
      const cost = costFor(record, settings);
      if (cost.cost !== undefined) record.cost = cost.cost;
      if (cost.unpriced) record.unpriced = true;
      records.push(record);
      continue;
    }

    if (event.type === 'run.failed') {
      const inFlight = pending.get(key);
      pending.delete(key);
      records.push({
        id: recordId(event),
        ts: event.ts,
        run_id: event.run_id,
        model: modelFor(settings, inFlight?.model ?? lastHint.get(key)),
        status: 'failed',
        ...(optionalString(event.data.session_id) !== undefined
          ? { session_id: optionalString(event.data.session_id) }
          : {}),
        ...(inFlight !== undefined
          ? {
              in_flight: true,
              ...(event.ts >= inFlight.ts ? { duration_ms: event.ts - inFlight.ts } : {}),
            }
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
  pricedRequests: number;
  unpricedRequests: number;
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
    pricedRequests: 0,
    unpricedRequests: 0,
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
  if (record.cost !== undefined) {
    target.cost += record.cost;
    target.pricedRequests += 1;
  } else if (record.unpriced === true) {
    target.unpricedRequests += 1;
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

/**
 * Sum of priced rows only. Absent when nothing in the bucket had a price, so
 * the UI never renders `$0` for "no prices configured". Unpriced rows are
 * reported separately via `unpriced_requests`.
 */
function costOf(target: Counter): number | undefined {
  return target.pricedRequests > 0 ? target.cost : undefined;
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
      unpriced_requests: target.unpricedRequests,
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
    unpriced_requests: overall.unpricedRequests,
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
    // Failed runs are run-level. They only belong in a request log when they
    // died with an unanswered llm.request; otherwise summary is the only
    // place they should appear.
    if (record.status === 'failed' && record.in_flight !== true) return false;
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
