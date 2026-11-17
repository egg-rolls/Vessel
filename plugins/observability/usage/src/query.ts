/**
 * The heavy half of the plugin: read the session timelines, fold them into
 * request records and run summaries, aggregate, and report how much of the data
 * that answer actually covers.
 *
 * It lives in its own module for one reason: it is what runs **inside the worker
 * thread** (worker.ts). Reading and parsing hundreds of megabytes of NDJSON
 * blocks whatever thread it happens on, so on the main thread it would freeze the
 * host's event loop; here it is off to the side and the host only ever sees the
 * finished DTO.
 *
 * The same class is also the documented **fallback** path: some embedders cannot
 * spawn a worker (single-threaded runtime, restricted sandbox, load failure), and
 * a plugin that answers slowly with correct numbers is better than one that
 * crashes. worker-client.ts decides which path to use and says so in
 * SourceCoverage.worker.
 *
 * State kept here: the event store (its per-session cache is the whole point of
 * "second request reads zero bytes") and the run-index memo. The main thread
 * keeps none of it.
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
  type IndexedSession,
  type RunSummary,
  readUsageIndex,
  type SessionFile,
  type SessionScan,
  type Settings,
  scanSessions,
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
      // A different data dir means different timelines: the cache and the index
      // memo describe sessions that are no longer the ones behind this path.
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
    const scan = await scanSessions(this.dataDir);
    const snapshot = await this.loadRuns(scan);
    const withMetrics = (source: SourceCoverage): SourceCoverage => ({
      ...source,
      ...degradationOf({
        dirs: scan.dirs,
        legacy: scan.legacy,
        readable: scan.files.length,
      }),
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
        ...degradationOf({
          dirs: loaded.dirs_total,
          legacy: loaded.legacy_files,
          readable: loaded.files_total,
        }),
        peeked: this.store.firstLinePeeks - peeksBefore,
        duration_ms: Date.now() - started,
      },
    };
  }

  /**
   * Run summaries for summary/leaderboard: the persisted index when it still
   * describes the sessions on disk, otherwise a rebuild — **per session**.
   *
   * The index is a cache, not the truth: each session row group is trusted only
   * when its `(size, mtime)` stamp equals the timeline's right now. Anything else
   * - missing file, older version, corrupt line, a newly appended session, a
   * deleted session - is re-read from that session only, and the rest of the rows
   * are carried over untouched. That is what keeps a query bounded: after the
   * first build, a query reads the sessions that moved (typically one, <= its own
   * timeline), not the whole corpus.
   *
   * A rebuild that had to truncate or partially read a session is **not**
   * persisted, so a partial view can never masquerade as complete later.
   */
  private async loadRuns(scan: SessionScan): Promise<RunSnapshot> {
    const dataDir = this.dataDir as string;
    const signature = sourceSignature(scan.sources);

    const memo = this.memo;
    const fresh =
      memo !== undefined && memo.signature === signature && Date.now() - memo.at < INDEX_MEMO_MS;
    if (fresh && memo !== undefined) {
      // Answered from memory: this call touched no event byte. The rest of the
      // coverage is structural (how many sessions the snapshot accounts for), so
      // it stays true; `bytes_read` does not.
      return { runs: memo.snapshot.runs, source: { ...memo.snapshot.source, bytes_read: 0 } };
    }

    const indexed = await readUsageIndex(dataDir);
    const previous = new Map<string, IndexedSession>(
      (indexed?.sessions ?? []).map((session) => [session.id, session]),
    );

    // Reuse everything whose stamp still matches; re-read the rest. Sessions in
    // the index that are gone simply do not appear in `scan.files`, which is how
    // a deleted session leaves the totals.
    const merged: IndexedSession[] = [];
    const stale: SessionFile[] = [];
    for (const file of scan.files) {
      const old = previous.get(file.id);
      if (old !== undefined && old.size === file.size && old.mtime === Math.floor(file.mtimeMs)) {
        merged.push(old);
        continue;
      }
      stale.push(file);
    }

    let bytesRead = 0;
    let partial = 0;
    for (const file of stale) {
      const read = await this.store.readSession(file);
      bytesRead += read.bytes_read;
      if (read.partial) partial += 1;
      const runs = repriceRuns(
        buildRunSummaries(buildRecords(read.events, this.settings)),
        this.settings,
      );
      merged.push({ id: file.id, size: file.size, mtime: Math.floor(file.mtimeMs), runs });
    }

    const runs: RunSummary[] = [];
    for (const session of merged) {
      for (const run of session.runs) runs.push(run);
    }

    const complete = partial === 0;
    const snapshot: RunSnapshot = {
      runs,
      source: {
        truncated: !complete,
        files_truncated: false,
        partial_files: partial,
        files_read: scan.files.length,
        files_in_window: scan.files.length,
        files_total: scan.files.length,
        bytes_read: bytesRead,
        peeked: 0,
      },
    };
    if (complete && stale.length > 0) {
      try {
        await writeUsageIndex(dataDir, merged, scan.sources);
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

/**
 * The source's state, shared by both read paths (see `SourceCoverage`).
 *
 * The degradation probe: "there are session directories, but not one of them has
 * a timeline I can read" is **not** "you have no usage". Pre-0.54 sessions (only
 * `events.ndjson`) are exactly that case — Vessel cannot parse them any more —
 * and they are counted so the pages can say what is missing instead of rendering
 * a confident zero.
 *
 * `dirs` = session directories on disk, `readable` = how many have a timeline,
 * `legacy` = how many are pre-0.54 leftovers.
 */
export function degradationOf(counts: {
  dirs: number;
  legacy: number;
  readable: number;
}): Pick<SourceCoverage, 'source_retired' | 'unreadable_sessions'> {
  const retired = counts.readable === 0 && counts.dirs > 0;
  return {
    ...(retired ? { source_retired: true } : {}),
    ...(counts.legacy > 0 ? { unreadable_sessions: counts.legacy } : {}),
  };
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
