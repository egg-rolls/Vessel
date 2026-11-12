/**
 * The heavy half of the plugin: read the session logs, fold them into request
 * records and run summaries, aggregate, and report how much it all cost.
 *
 * It lives in its own module for one reason: it is what runs **inside the worker
 * thread** (worker.ts). Reading and parsing tens of megabytes of NDJSON blocks
 * whatever thread it happens on, so on the main thread it would freeze the host's
 * event loop; here it is off to the side and the host only ever sees the finished
 * DTO.
 *
 * The same class is also the documented **fallback** path: some embedders cannot
 * spawn a worker (single-threaded runtime, restricted sandbox, load failure), and
 * a plugin that answers slowly with correct numbers is better than one that
 * crashes. worker-client.ts decides which path to use and says so in
 * SourceCoverage.worker.
 *
 * State kept here: the event store (its byte offsets, first-line cache and LRU
 * event cache are the whole point of "second request reads zero bytes") and the
 * run-index memo. The main thread keeps none of it.
 */
import {
  buildRecords,
  buildRunSummaries,
  type LeaderboardResult,
  type LogsParams,
  type LogsResult,
  leaderboardRuns,
  listLogs,
  repriceRuns,
  type SourceCoverage,
  type SummaryResult,
  summarizeRuns,
} from './aggregate.js';
import {
  EventStore,
  type RunSummary,
  readSessionSources,
  readUsageIndex,
  type Settings,
  sourceSignature,
  writeUsageIndex,
} from './store.js';

/** What the Logs page asks for: a page of request rows inside an optional range. */
export interface LogsQuery {
  kind: 'logs';
  params: LogsParams;
  /** Reader lower bound (the resolved start of the range). */
  cutoff?: number;
  /** Reader upper bound hint; the record filter itself is in LogsParams. */
  until?: number;
}

export interface SummaryQuery {
  kind: 'summary';
  now: number;
  days?: number;
}

export interface LeaderboardQuery {
  kind: 'leaderboard';
  now: number;
  days?: number;
}

export type UsageQuery = LogsQuery | SummaryQuery | LeaderboardQuery;

export type UsageResult =
  | { kind: 'summary'; dto: SummaryResult }
  | { kind: 'leaderboard'; dto: LeaderboardResult }
  | { kind: 'logs'; dto: LogsResult };

/** One answer plus the coverage/metrics that explain how it was produced. */
export interface QueryOutcome {
  result: UsageResult;
  source: SourceCoverage;
}

/** How long a freshly read/built run set is reused without re-fingerprinting. */
const INDEX_MEMO_MS = 1_500;

interface RunSnapshot {
  runs: RunSummary[];
  source: SourceCoverage;
}

/**
 * How long the worker may sit idle before it is torn down.
 *
 * The caches die with the thread, and the persistent index makes a restart cheap
 * (one stat sweep when nothing changed), so an idle window is pure memory
 * savings. Five minutes is long enough that a user paging through Logs keeps the
 * warm worker, short enough that an idle desktop gets its ~100 MiB back.
 */
export const WORKER_IDLE_MS = 5 * 60_000;

export class QueryRuntime {
  readonly store = new EventStore();
  private settings: Settings = { prices: {} };
  private dataDir: string | undefined;
  private memo: { at: number; signature: string; snapshot: RunSnapshot } | undefined;
  private indexWarningLogged = false;

  /** Point the runtime at a data dir and a price table (plugin.activate). */
  init(dataDir: string, settings: Settings): void {
    if (this.dataDir !== dataDir) {
      // A different data dir means different logs: the offsets and the index
      // memo describe files that are no longer the ones behind this path.
      this.store.reset();
      this.memo = undefined;
    }
    this.dataDir = dataDir;
    this.settings = settings;
  }

  /** Drop every cache (plugin.deactivate / a fresh activation). */
  reset(): void {
    this.store.reset();
    this.memo = undefined;
  }

  /** Answer one query. Never throws for a "no data" case; throws only on bugs/IO. */
  async query(query: UsageQuery): Promise<QueryOutcome> {
    if (this.dataDir === undefined) throw new Error('plugin is not activated');
    const started = Date.now();
    if (query.kind === 'logs') return this.logs(query, started);
    const snapshot = await this.loadRuns();
    const withMetrics = (source: SourceCoverage): SourceCoverage => ({
      ...source,
      duration_ms: Date.now() - started,
    });
    if (query.kind === 'summary') {
      return {
        result: { kind: 'summary', dto: summarizeRuns(snapshot.runs, query.now, query.days) },
        source: withMetrics(snapshot.source),
      };
    }
    return {
      result: {
        kind: 'leaderboard',
        dto: leaderboardRuns(snapshot.runs, query.now, query.days),
      },
      source: withMetrics(snapshot.source),
    };
  }

  /** Logs: per-request rows, so this is the path that has to read events. */
  private async logs(query: LogsQuery, started: number): Promise<QueryOutcome> {
    const dataDir = this.dataDir as string;
    const peeksBefore = this.store.firstLinePeeks;
    const loaded = await this.store.loadEvents(dataDir, {
      ...(query.cutoff !== undefined ? { cutoff: query.cutoff } : {}),
      ...(query.until !== undefined ? { until: query.until } : {}),
    });
    const records = buildRecords(loaded.events, this.settings);
    const dto = listLogs(records, query.params);
    return {
      result: { kind: 'logs', dto },
      source: {
        ...coverageOf(loaded),
        peeked: this.store.firstLinePeeks - peeksBefore,
        duration_ms: Date.now() - started,
      },
    };
  }

  /**
   * Run summaries for summary/leaderboard: the persisted index when it is fresh,
   * otherwise a rebuild from the session logs.
   *
   * The index is a cache, not the truth: it is trusted only when its format
   * version matches and its source fingerprint equals what is on disk right now.
   * Anything else - missing file, older version, corrupt line, an appended
   * session, a deleted session - falls back to the logs and rewrites the index. A
   * rebuild that had to truncate is not persisted, so a partial view can never
   * masquerade as complete later.
   */
  private async loadRuns(): Promise<RunSnapshot> {
    const dataDir = this.dataDir as string;
    const sources = await readSessionSources(dataDir);
    const signature = sourceSignature(sources);

    const memo = this.memo;
    const fresh =
      memo !== undefined && memo.signature === signature && Date.now() - memo.at < INDEX_MEMO_MS;
    if (fresh && memo !== undefined) return memo.snapshot;

    const indexed = await readUsageIndex(dataDir);
    if (indexed !== undefined && sourceSignature(indexed.header.sources) === signature) {
      // The index covers every session on disk by construction, so its coverage
      // is complete: nothing is left unread to warn about, and no event byte was
      // touched. Prices are applied now, not taken from the stored rows.
      const snapshot: RunSnapshot = {
        runs: repriceRuns(indexed.runs, this.settings),
        source: {
          truncated: false,
          files_truncated: false,
          partial_files: 0,
          files_read: sources.files,
          files_in_window: sources.files,
          files_total: sources.files,
          bytes_read: 0,
          peeked: 0,
        },
      };
      this.memo = { at: Date.now(), signature, snapshot };
      return snapshot;
    }

    const loaded = await this.store.loadEvents(dataDir);
    const runs = repriceRuns(
      buildRunSummaries(buildRecords(loaded.events, this.settings)),
      this.settings,
    );
    const snapshot: RunSnapshot = { runs, source: coverageOf(loaded) };
    if (!loaded.truncated && !loaded.files_truncated) {
      try {
        await writeUsageIndex(dataDir, runs, sources);
      } catch (error) {
        // The index is an optimisation: failing to write it must not fail the RPC.
        if (!this.indexWarningLogged) {
          this.indexWarningLogged = true;
          const reason = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[usage] usage index not written: ${reason}\n`);
        }
      }
    }
    this.memo = { at: Date.now(), signature, snapshot };
    return snapshot;
  }
}

/** Reader coverage in the DTO shape, without the metrics. */
export function coverageOf(loaded: {
  truncated: boolean;
  files_truncated: boolean;
  partial_files: number;
  files_covered: number;
  files_in_window: number;
  files_total: number;
  bytes_read: number;
}): SourceCoverage {
  return {
    truncated: loaded.truncated,
    files_truncated: loaded.files_truncated,
    partial_files: loaded.partial_files,
    files_read: loaded.files_covered,
    files_in_window: loaded.files_in_window,
    files_total: loaded.files_total,
    bytes_read: loaded.bytes_read,
  };
}
