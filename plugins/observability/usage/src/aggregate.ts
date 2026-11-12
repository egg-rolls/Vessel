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

import { isRecord, type RawEvent, type RunSummary, type Settings } from './store.js';

const COST_DIVISOR = 1_000_000;

/**
 * How much of the trace a result actually covers.
 *
 * The reader is day-windowed and byte-budgeted (see `store.ts`), so a result can
 * be built from only the newest run files *inside* the requested range. Two
 * different incompletenesses are reported apart, because the honest sentence
 * for each is different:
 *
 * - `files_truncated` — some run file in the range was not read at all (read
 *   budget / file cap): runs are missing from these numbers;
 * - `partial_files` — that many counted files were only read partially: their
 *   runs are counted but their oldest requests may be missing.
 *
 * `truncated` stays as `files_truncated || partial_files > 0`. Files outside the
 * selected range are **not** truncation: the user asked for that range. Absent
 * when a caller has no reader behind it (the probe's pure fixtures).
 */
export interface SourceCoverage {
  truncated: boolean;
  /** Run files in the range that contributed nothing. */
  files_truncated?: boolean;
  /** Counted run files that were only partially read. */
  partial_files?: number;
  /** Trace files counted. */
  files_read: number;
  /** Trace files inside the selected range (`mtime >= cutoff`). */
  files_in_window?: number;
  /** Trace files present in `<dataDir>/events`. */
  files_total: number;
}

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
  /** Trace coverage behind these numbers; see `SourceCoverage`. */
  source?: SourceCoverage;
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
  /**
   * Range bounds on `record.ts`, half-open `[since, until)`. `since` is
   * inclusive so consecutive ranges partition without overlap or gap — a record
   * at exactly `until` belongs to the next range, not to both.
   */
  since?: number;
  until?: number;
}

export interface LogsResult {
  items: LogItem[];
  next_cursor: { before_ts: number; before_id: string } | null;
  /** Trace coverage behind this page; see `SourceCoverage`. */
  source?: SourceCoverage;
}

export interface LeaderboardResult {
  items: ModelBucket[];
  /** Trace coverage behind these rows; see `SourceCoverage`. */
  source?: SourceCoverage;
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
 * Fold per-request records into one entry per run.
 *
 * Requests pair one-to-one with responses (`buildRecords`), so summing those
 * pairs is the usage of the run; `run.completed.usage` is deliberately **not**
 * added on top — a retried run would then be counted twice. Records of a run
 * share a model in practice; the first known one wins, and `unknown` is kept
 * rather than invented when none is known.
 */
export function buildRunSummaries(records: UsageRecord[]): RunSummary[] {
  interface Acc {
    run: RunSummary;
    cacheReadReported: boolean;
    cacheWriteReported: boolean;
  }
  const accs = new Map<string, Acc>();
  const order: string[] = [];

  for (const record of records) {
    let acc = accs.get(record.run_id);
    if (acc === undefined) {
      acc = {
        run: {
          run_id: record.run_id,
          model: record.model,
          ts_start: record.ts,
          ts_end: record.ts,
          requests: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          unpriced_requests: 0,
          status: 'ok',
        },
        cacheReadReported: false,
        cacheWriteReported: false,
      };
      accs.set(record.run_id, acc);
      order.push(record.run_id);
    }
    const run = acc.run;
    if (record.session_id !== undefined) run.session_id = record.session_id;
    if (run.model === 'unknown' && record.model !== 'unknown') run.model = record.model;
    run.ts_start = Math.min(run.ts_start, record.ts);
    run.ts_end = Math.max(run.ts_end, record.ts);

    if (record.status === 'failed') {
      run.status = 'failed';
      continue;
    }
    run.requests += 1;
    run.prompt_tokens += record.prompt_tokens ?? 0;
    run.completion_tokens += record.completion_tokens ?? 0;
    if (record.cache_read_input_tokens !== undefined) {
      run.cache_read_input_tokens =
        (run.cache_read_input_tokens ?? 0) + record.cache_read_input_tokens;
      acc.cacheReadReported = true;
    }
    if (record.cache_creation_input_tokens !== undefined) {
      run.cache_creation_input_tokens =
        (run.cache_creation_input_tokens ?? 0) + record.cache_creation_input_tokens;
      acc.cacheWriteReported = true;
    }
  }

  // `cost` and `unpriced_requests` are deliberately left to `repriceRuns`: they
  // are a function of the *prices in effect*, not of the events, so they must not
  // be baked into a row that may be persisted and read back under other prices.
  return order.map((runId) => {
    const acc = accs.get(runId);
    const run = acc === undefined ? undefined : acc.run;
    if (acc === undefined || run === undefined) throw new Error('unreachable');
    return run;
  });
}

/**
 * Price every run row with the prices in effect **now**.
 *
 * Token sums are the durable fact (events); a price table is configuration that
 * can change at any time, so a stored `cost` may not be trusted. Cost is a linear
 * function of a run's tokens, so recomputing it from the row is exact — no event
 * has to be re-read — and editing a price takes effect on the next render instead
 * of requiring an index rebuild.
 *
 * `unpriced_requests` counts the run's requests when its model has no price;
 * `cost` stays absent in that case so the UI shows `—`, never `$0`.
 */
export function repriceRuns(runs: RunSummary[], settings: Settings): RunSummary[] {
  return runs.map((run) => {
    const repriced: RunSummary = { ...run };
    delete repriced.cost;
    const price = settings.prices[run.model];
    const hasUsage = run.prompt_tokens > 0 || run.completion_tokens > 0;
    if (price === undefined) {
      repriced.unpriced_requests = hasUsage ? run.requests : 0;
      return repriced;
    }
    repriced.unpriced_requests = 0;
    if (!hasUsage) return repriced;
    const read = run.cache_read_input_tokens ?? 0;
    const write = run.cache_creation_input_tokens ?? 0;
    const nonCached = Math.max(0, run.prompt_tokens - read - write);
    repriced.cost =
      (nonCached * price.input_per_1m +
        read * price.cache_read_per_1m +
        write * price.cache_write_per_1m +
        run.completion_tokens * price.output_per_1m) /
      COST_DIVISOR;
    return repriced;
  });
}

/**
 * Paired totals of a run's `run.completed` / `run.failed` events, keyed by run
 * id. Used to **validate** the pairing (report only — never added to a total).
 */
export interface CompletedUsage {
  run_id: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  duration_ms?: number;
  iterations?: number;
}

export function completedUsages(events: RawEvent[]): Map<string, CompletedUsage> {
  const byRun = new Map<string, CompletedUsage>();
  for (const event of events) {
    if (event.type !== 'run.completed') continue;
    const usage = isRecord(event.data.usage) ? event.data.usage : undefined;
    const entry: CompletedUsage = { run_id: event.run_id };
    const prompt = usage === undefined ? undefined : optionalNumber(usage.prompt_tokens);
    const completion = usage === undefined ? undefined : optionalNumber(usage.completion_tokens);
    const cacheRead =
      usage === undefined ? undefined : optionalNumber(usage.cache_read_input_tokens);
    const cacheWrite =
      usage === undefined ? undefined : optionalNumber(usage.cache_creation_input_tokens);
    if (prompt !== undefined) entry.prompt_tokens = prompt;
    if (completion !== undefined) entry.completion_tokens = completion;
    if (cacheRead !== undefined) entry.cache_read_input_tokens = cacheRead;
    if (cacheWrite !== undefined) entry.cache_creation_input_tokens = cacheWrite;
    const duration = optionalNumber(event.data.duration_ms);
    const iterations = optionalNumber(event.data.iterations);
    if (duration !== undefined) entry.duration_ms = duration;
    if (iterations !== undefined) entry.iterations = iterations;
    byRun.set(event.run_id, entry);
  }
  return byRun;
}

/**
 * Fold raw events into one record per `llm.response`, plus one failed record
 * per `run.failed`. `llm.request` supplies the duration of the following
 * response and the model attribution (its `model` field).
 *
 * This pairing is the **single** source of usage: `run.completed.usage` is never
 * added on top (a retried run would be counted twice). A request that never got
 * a response (the run failed) leaves a `failed` record instead of a usage row —
 * visible in Logs, absent from the token totals, because no usage was reported.
 *
 * A failed run is run-level, not an LLM request. It is counted in summary and
 * appears in Logs with `status=failed` and no counters; `in_flight` marks the
 * case where it died with an unanswered `llm.request`.
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
 *
 * This is the single definition of "the selected range": `index.ts` hands it to
 * `EventStore.loadEvents({ cutoff })` so the *reader* only opens files inside
 * the range, and `filterRunsByDays` applies the same instant to the runs it
 * produced. Both sides must use the same number or a run that ends just after
 * midnight would be read but dropped, or kept but never read.
 */
export function daysCutoff(now: number, days: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

/**
 * `days` -> the instant a reader windows on; `undefined` means "no lower bound"
 * ("all time"). The one place that mapping exists: `summary`, `leaderboard` and
 * `logs` all resolve their range through `cutoffFor` (`resolveLogsRange` calls it
 * for the `days` branch), so the same `days` value can never mean two different
 * instants on two pages.
 */
export function cutoffFor(now: number, days: number | undefined): number | undefined {
  return days === undefined ? undefined : daysCutoff(now, days);
}

/** The three range parameters `logs` accepts, already type-checked by the RPC layer. */
export interface LogsRangeInput {
  days?: number;
  since?: number;
  until?: number;
}

export type LogsRangeError = 'range_conflict' | 'range_inverted';

/**
 * Where a `logs` request looks, or why it cannot be answered.
 *
 * `days` and `since`/`until` are **mutually exclusive**. They are two different
 * ways to name one range, and `days` is relative to `now`: combining them would
 * produce two lower bounds (`daysCutoff(now, days)` and `since`), and then the
 * coverage the reader reports (`files_in_window`, "N of M run files in this
 * range") could not be attributed to one of them. Rejecting the request is
 * clearer than silently preferring one.
 *
 * `since` (or `days`) also becomes the reader's `cutoff`, so the *file* window
 * follows the request; `until` cannot prune files (see `LoadOptions` in
 * `store.ts`) and is applied per record in `listLogs`.
 */
export type LogsRange =
  | {
      ok: true;
      /** Lower bound handed to the reader; `undefined` = no lower bound. */
      cutoff?: number;
      /** Record-level bounds, half-open `[since, until)`. */
      since?: number;
      until?: number;
    }
  | { ok: false; code: LogsRangeError; message: string };

export function resolveLogsRange(input: LogsRangeInput, now: number): LogsRange {
  const { days, since, until } = input;
  if (days !== undefined && (since !== undefined || until !== undefined)) {
    return {
      ok: false,
      code: 'range_conflict',
      message: 'days cannot be combined with since/until; send one or the other',
    };
  }
  if (since !== undefined && until !== undefined && since >= until) {
    return {
      ok: false,
      code: 'range_inverted',
      message: 'since must be before until',
    };
  }
  if (days !== undefined) {
    const cutoff = cutoffFor(now, days);
    // `days` is always defined here, so the cutoff exists; keep the compiler
    // honest without a non-null assertion.
    return cutoff === undefined ? { ok: true } : { ok: true, cutoff, since: cutoff };
  }
  return {
    ok: true,
    ...(since !== undefined ? { cutoff: since, since } : {}),
    ...(until !== undefined ? { until } : {}),
  };
}

interface Ratios {
  input_share?: number;
  input_share_unavailable?: CacheUnavailableReason;
  prefix_health?: number;
  prefix_health_unavailable?: CacheUnavailableReason;
}

function totalTokens(bucket: Pick<ModelBucket, 'prompt_tokens' | 'completion_tokens'>): number {
  return bucket.prompt_tokens + bucket.completion_tokens;
}

/** Accumulator for run-level totals (mirrors `Counter`, one level up). */
interface RunTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
  cacheReadReported: boolean;
  cacheWrite: number;
  cacheWriteReported: boolean;
  cost: number;
  pricedRuns: number;
  unpricedRequests: number;
  failedRuns: number;
}

function runTotals(): RunTotals {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheRead: 0,
    cacheReadReported: false,
    cacheWrite: 0,
    cacheWriteReported: false,
    cost: 0,
    pricedRuns: 0,
    unpricedRequests: 0,
    failedRuns: 0,
  };
}

function addRun(target: RunTotals, run: RunSummary): void {
  target.requests += run.requests;
  target.promptTokens += run.prompt_tokens;
  target.completionTokens += run.completion_tokens;
  if (run.cache_read_input_tokens !== undefined) {
    target.cacheReadReported = true;
    target.cacheRead += run.cache_read_input_tokens;
  }
  if (run.cache_creation_input_tokens !== undefined) {
    target.cacheWriteReported = true;
    target.cacheWrite += run.cache_creation_input_tokens;
  }
  if (run.cost !== undefined) {
    target.cost += run.cost;
    target.pricedRuns += 1;
  }
  target.unpricedRequests += run.unpriced_requests;
  if (run.status === 'failed') target.failedRuns += 1;
}

function runTotalsOf(target: RunTotals): Totals {
  return {
    requests: target.requests,
    prompt_tokens: target.promptTokens,
    completion_tokens: target.completionTokens,
    ...(target.cacheReadReported ? { cache_read_tokens: target.cacheRead } : {}),
    ...(target.cacheWriteReported ? { cache_creation_tokens: target.cacheWrite } : {}),
    failed_runs: target.failedRuns,
  };
}

function runCostOf(target: RunTotals): number | undefined {
  return target.pricedRuns > 0 ? target.cost : undefined;
}

/**
 * Range filter for runs: a run belongs to the range its **end** falls in.
 *
 * `ts_end` (not `ts_start`) because the tokens were produced while the run ran
 * and the index only keeps one instant per run; a run ends when its last record
 * is written. The consequence is documented in the module docs: a run that
 * straddles midnight counts, whole, on the day it finished, while `logs` filters
 * each request by its own `ts`.
 */
export function filterRunsByDays(runs: RunSummary[], now: number, days?: number): RunSummary[] {
  const cutoff = cutoffFor(now, days);
  if (cutoff === undefined) return runs;
  return runs.filter((run) => run.ts_end >= cutoff);
}

function runBuckets(runs: RunSummary[]): ModelBucket[] {
  const totals = new Map<string, RunTotals>();
  for (const run of runs) {
    // A failed run has no counters; it is a row in Logs, not a model's usage.
    if (run.requests === 0) continue;
    const target = totals.get(run.model) ?? runTotals();
    addRun(target, run);
    totals.set(run.model, target);
  }

  const buckets: ModelBucket[] = [];
  for (const [model, target] of totals) {
    const cost = runCostOf(target);
    buckets.push({
      model,
      requests: target.requests,
      prompt_tokens: target.promptTokens,
      completion_tokens: target.completionTokens,
      ...(target.cacheReadReported ? { cache_read_tokens: target.cacheRead } : {}),
      ...(target.cacheWriteReported ? { cache_creation_tokens: target.cacheWrite } : {}),
      ...(cost !== undefined ? { cost } : {}),
    });
  }
  buckets.sort(
    (a, b) =>
      totalTokens(b) - totalTokens(a) || b.requests - a.requests || a.model.localeCompare(b.model),
  );
  return buckets;
}

function runRatios(runs: RunSummary[]): Ratios {
  const withRequests = runs.filter((run) => run.requests > 0);
  if (withRequests.length === 0) {
    return { input_share_unavailable: 'no-requests', prefix_health_unavailable: 'no-requests' };
  }
  let promptTotal = 0;
  let readTotal = 0;
  let writeTotal = 0;
  let readReported = false;
  let writeReported = false;
  for (const run of withRequests) {
    promptTotal += run.prompt_tokens;
    if (run.cache_read_input_tokens !== undefined) {
      readReported = true;
      readTotal += run.cache_read_input_tokens;
    }
    if (run.cache_creation_input_tokens !== undefined) {
      writeReported = true;
      writeTotal += run.cache_creation_input_tokens;
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
    result.input_share_unavailable = 'prompt-not-inclusive';
  } else {
    result.input_share = readTotal / promptTotal;
  }

  if (!readReported) {
    result.prefix_health_unavailable = 'no-cache-fields';
  } else if (!writeReported) {
    result.prefix_health_unavailable = 'write-not-reported';
  } else {
    result.prefix_health = readTotal / (readTotal + writeTotal);
  }
  return result;
}

/**
 * Summary page DTO, aggregated from run summaries.
 *
 * Runs are the unit because that is what the persistent index stores; the
 * per-request records they came from are what `logs` pages through. Totals stay
 * consistent between the two by construction: both are folded from the same
 * `llm.request` ↔ `llm.response` pairing (`buildRecords`), and neither adds
 * `run.completed.usage`.
 */
export function summarizeRuns(runs: RunSummary[], now: number, days?: number): SummaryResult {
  const filtered = filterRunsByDays(runs, now, days);
  const overall = runTotals();
  const dayCounters = new Map<string, RunTotals>();
  for (const run of filtered) {
    addRun(overall, run);
    const key = dayKey(run.ts_end);
    const target = dayCounters.get(key) ?? runTotals();
    addRun(target, run);
    dayCounters.set(key, target);
  }

  const byDay: DayBucket[] = [];
  for (const [date, target] of dayCounters) {
    const cost = runCostOf(target);
    byDay.push({
      date,
      ...runTotalsOf(target),
      ...(cost !== undefined ? { cost } : {}),
      unpriced_requests: target.unpricedRequests,
    });
  }
  byDay.sort((a, b) => b.date.localeCompare(a.date));

  const ratios = runRatios(filtered);
  const cost = runCostOf(overall);
  return {
    has_data: filtered.some((run) => run.requests > 0 || run.status === 'failed'),
    totals: runTotalsOf(overall),
    by_day: byDay,
    by_model: runBuckets(filtered),
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
    // A failed run is a run-level row: it has no counters (no response meant no
    // usage was reported), but it must stay **visible** — a failed request that
    // silently disappeared from the log would look like it never happened.
    // `in_flight` still marks the "died with an unanswered llm.request" case.
    if (params.status !== undefined && record.status !== params.status) return false;
    if (params.session_id !== undefined && record.session_id !== params.session_id) return false;
    if (params.model !== undefined && record.model !== params.model) return false;
    // Range first, then the cursor: a page is always a window of the selected
    // range, so "load more" can never step outside it or repeat a row.
    if (params.since !== undefined && record.ts < params.since) return false;
    if (params.until !== undefined && record.ts >= params.until) return false;
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

/** Leaderboard page DTO: same run summaries, grouped by model. */
export function leaderboardRuns(
  runs: RunSummary[],
  now: number,
  days?: number,
): LeaderboardResult {
  return { items: runBuckets(filterRunsByDays(runs, now, days)) };
}
