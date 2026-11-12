/**
 * Main-thread side of the worker: lifecycle, queueing and the fallback.
 *
 * Responsibilities, in the order they matter:
 *
 * 1. **Off the event loop.** A query is posted to worker.ts and awaited; the main
 *    thread does no parsing, so it stays responsive while a few hundred
 *    milliseconds of NDJSON are read elsewhere.
 * 2. **One heavy job at a time.** Queries are serialised through a promise chain
 *    and answered in order. The worker holds one event store and one index memo;
 *    running two ranges at once would only make them both thrash that state (and
 *    the second one's cache would evict the first one's files). Concurrent RPCs
 *    therefore queue — and because the caches are inside the worker, a queued
 *    request for a range that was just read answers from cache.
 * 3. **Lazy and self-limiting.** The thread starts on the first query and exits
 *    after WORKER_IDLE_MS of silence, or when the plugin deactivates.
 * 4. **Honest degradation.** If the thread cannot start (embedders that forbid
 *    workers, a broken environment) or dies mid-query, the same QueryRuntime code
 *    runs on the main thread instead. Slower and blocking, but correct — and the
 *    answer says which path produced it (SourceCoverage.worker).
 */
import { Worker } from 'node:worker_threads';
import { type QueryOutcome, QueryRuntime, type UsageQuery, WORKER_IDLE_MS } from './query.js';
import type { Settings } from './store.js';

interface WorkerReply {
  id: number;
  ok: boolean;
  outcome?: QueryOutcome;
  error?: string;
  worker?: boolean;
}

export interface WorkerAnswer {
  outcome: QueryOutcome;
  /** True when the worker thread produced this answer. */
  worker: boolean;
}

/** A start that failed once may be retried; a process that forbids workers is final. */
const MAX_START_FAILURES = 2;

export class WorkerQueryClient {
  /** Main-thread runtime, used when no worker is available. */
  readonly fallback = new QueryRuntime();
  private worker: Worker | null = null;
  private starting: Promise<Worker> | null = null;
  private readonly pending = new Map<
    number,
    { resolve: (value: WorkerReply) => void; reject: (error: Error) => void }
  >();
  private sequence = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private startFailures = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInit: { dataDir: string; settings: Settings } | null = null;

  /**  when the next query will go to a worker (diagnostics + probe). */
  get usingWorker(): boolean {
    return this.worker !== null && this.startFailures < MAX_START_FAILURES;
  }

  /** How many queries this client has answered from the worker. */
  get workerQueries(): number {
    return this.workerRuns;
  }

  private workerRuns = 0;

  private readonly idleMs: number;
  private readonly spawn: () => Worker;

  /**
   * `spawn` is injectable so a test (and a host that wants a preloaded worker)
   * can replace the thread factory; the default is this module's sibling
   * worker.ts. Making it a parameter is also how the fallback path is tested:
   * a factory that throws is exactly "this environment cannot spawn workers".
   */
  constructor(options: { idleMs?: number; spawn?: () => Worker } = {}) {
    this.idleMs = options.idleMs === undefined ? WORKER_IDLE_MS : options.idleMs;
    this.spawn =
      options.spawn === undefined
        ? () => new Worker(new URL('./worker.ts', import.meta.url), { name: 'usage-worker' })
        : options.spawn;
  }

  async query(
    query: UsageQuery,
    init: { dataDir: string; settings: Settings },
  ): Promise<WorkerAnswer> {
    if (this.startFailures >= MAX_START_FAILURES) {
      return this.local(query, init);
    }
    try {
      const outcome = await this.enqueue(query, init);
      this.workerRuns += 1;
      return { outcome, worker: true };
    } catch {
      // A dead worker must not cost a request: answer it here and stop trying.
      return this.local(query, init);
    }
  }

  /** Graceful shutdown (plugin.deactivate / process exit). */
  async terminate(): Promise<void> {
    this.clearIdle();
    const worker = this.worker;
    this.worker = null;
    this.starting = null;
    this.failPending(new Error('worker terminated'));
    if (worker === null) return;
    try {
      await worker.terminate();
    } catch {
      // Already gone.
    }
  }

  private async local(
    query: UsageQuery,
    init: { dataDir: string; settings: Settings },
  ): Promise<WorkerAnswer> {
    this.fallback.init(init.dataDir, init.settings);
    return { outcome: await this.fallback.query(query), worker: false };
  }

  /** Serialise on the promise chain: one heavy job at a time, answered in order. */
  private enqueue(
    query: UsageQuery,
    init: { dataDir: string; settings: Settings },
  ): Promise<QueryOutcome> {
    const run = this.chain.then(() => this.send(query, init));
    // Keep the chain alive after a failure; the failure itself is the caller's.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async send(
    query: UsageQuery,
    init: { dataDir: string; settings: Settings },
  ): Promise<QueryOutcome> {
    const worker = await this.ensureWorker();
    await this.ensureInit(worker, init);
    const reply = await this.post(worker, { kind: 'query', query });
    this.scheduleIdle();
    if (reply.ok !== true || reply.outcome === undefined) {
      throw new Error(reply.error === undefined ? 'worker query failed' : reply.error);
    }
    return reply.outcome;
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.worker !== null) return this.worker;
    if (this.starting === null) {
      this.starting = this.start();
    }
    const worker = await this.starting;
    this.worker = worker;
    return worker;
  }

  private async start(): Promise<Worker> {
    try {
      const worker = this.spawn();
      worker.on('message', (message: WorkerReply) => {
        const entry = this.pending.get(message.id);
        if (entry === undefined) return;
        this.pending.delete(message.id);
        entry.resolve(message);
      });
      worker.on('error', (error: Error) => {
        this.startFailures += 1;
        this.onWorkerGone(error);
      });
      worker.on('exit', (code: number) => {
        if (this.worker === worker) this.startFailures += 1;
        this.onWorkerGone(new Error(`usage worker exited with code ${code}`));
      });
      // A handshake proves the module actually loaded (a bad path or a runtime
      // without worker support fails here, not on the first real query).
      await this.post(worker, { kind: 'ping', id: -1 }, true);
      return worker;
    } catch (error) {
      this.startFailures += 1;
      this.starting = null;
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private async ensureInit(
    worker: Worker,
    init: { dataDir: string; settings: Settings },
  ): Promise<void> {
    const last = this.lastInit;
    if (last !== null && last.dataDir === init.dataDir && last.settings === init.settings) return;
    const reply = await this.post(worker, {
      kind: 'init',
      dataDir: init.dataDir,
      settings: init.settings,
    });
    if (reply.ok !== true) throw new Error('usage worker init failed');
    this.lastInit = init;
  }

  private post(
    worker: Worker,
    payload: { kind: string } & Record<string, unknown>,
    handshake = false,
  ): Promise<WorkerReply> {
    const id = this.sequence++;
    return new Promise<WorkerReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...payload, id });
      if (handshake) {
        // A handshake that never answers means the module did not load.
        setTimeout(() => {
          const entry = this.pending.get(id);
          if (entry === undefined) return;
          this.pending.delete(id);
          reject(new Error('usage worker did not answer the handshake'));
        }, 5_000);
      }
    });
  }

  private onWorkerGone(error: Error): void {
    const worker = this.worker;
    this.worker = null;
    this.starting = null;
    this.lastInit = null;
    this.clearIdle();
    this.failPending(error);
    if (worker !== null) {
      void worker.terminate().catch(() => undefined);
    }
  }

  private failPending(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private scheduleIdle(): void {
    this.clearIdle();
    const timer = setTimeout(() => {
      this.idleTimer = null;
      void this.terminate();
    }, this.idleMs);
    // An idle worker must never keep the process alive on its own.
    timer.unref?.();
    this.idleTimer = timer;
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
