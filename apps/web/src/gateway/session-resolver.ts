/**
 * 权限 / ask 的 `sessionId` 分层解析（PLAN-0.18-ux-pending §9）。
 *
 * - L1：有界 LRU（`run.started` 写入；hydration `runs.list` 预热）。
 * - L2：从 EventStore 末尾反查 `run.started`，命中写回 L1。
 * - L3：canonical `runs.get`（入参是 gateway **job id**，不是 core run id），
 *   同 run 并发共享一个 promise；未命中写负缓存。
 * - L4：仍未解析 → 返回 undefined，由 UI 显示“无法定位所属会话”。
 *
 * 交互 / ask 事件里的 `run_id` 是 core run id；`runs.get` 只认 job id。
 * core → job 的映射来自 `observe(..., jobId)` 与 `prewarm`（`core_run_id → run_id`），
 * 缺失时负缓存，绝不拿 core id 直接查 `runs.get`。
 *
 * 不轮询、不设定时器；负缓存按时间戳惰性过期。切 tenant / 清 token 时
 * `reset()` 递增 generation，旧世代结果不得写缓存、不得回调。
 */

export const SESSION_CACHE_LIMIT = 500;
export const SESSION_NEGATIVE_TTL_MS = 30_000;

export interface RunSessionRecord {
  run_id: string;
  core_run_id?: string;
  session_id?: string;
}

export interface SessionResolverOptions {
  /** L2：从 EventStore 末尾反查 run.started。 */
  sessionForRun?: (runId: string) => string | undefined;
  /** L2：core run id → gateway job id（run.started 的 `meta.jobId`）。 */
  jobForRun?: (runId: string) => string | undefined;
  /** L3：canonical runs.get；入参是 gateway job id；返回 undefined/null 表示无归属。 */
  lookupRun?: (jobId: string) => Promise<{ session_id?: string } | null | undefined>;
  /** 解析到新 session 时回调（用于 dispatch 回填）。 */
  onResolved?: (runId: string, sessionId: string) => void;
  capacity?: number;
  negativeTtlMs?: number;
  now?: () => number;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class SessionResolver {
  /** core run id → session id。 */
  private readonly cache = new Map<string, string>();
  /** core run id → gateway job id（`runs.get` 的 key）。 */
  private readonly jobs = new Map<string, string>();
  /** runId → 负缓存过期时间（`now()` 毫秒）。 */
  private readonly negative = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<string | undefined>>();
  private readonly capacity: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;
  private readonly sessionForRun?: (runId: string) => string | undefined;
  private readonly jobForRun?: (runId: string) => string | undefined;
  private readonly lookupRun?: SessionResolverOptions['lookupRun'];
  private readonly onResolved?: (runId: string, sessionId: string) => void;
  private generation = 0;

  constructor(options: SessionResolverOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? SESSION_CACHE_LIMIT);
    this.negativeTtlMs = options.negativeTtlMs ?? SESSION_NEGATIVE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.sessionForRun = options.sessionForRun;
    this.jobForRun = options.jobForRun;
    this.lookupRun = options.lookupRun;
    this.onResolved = options.onResolved;
  }

  private static rememberIn(
    map: Map<string, string>,
    key: string,
    value: string,
    capacity: number,
  ) {
    // delete + set：刚写入 / 命中的 key 保持在 Map 尾部（最新）。
    map.delete(key);
    map.set(key, value);
    while (map.size > capacity) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  private remember(runId: string, sessionId: string): void {
    SessionResolver.rememberIn(this.cache, runId, sessionId, this.capacity);
  }

  private rememberJob(runId: string, jobId: string): void {
    SessionResolver.rememberIn(this.jobs, runId, jobId, this.capacity);
  }

  /** L2 / 预热缓存的 core → job 映射；命中时刷新 LRU。 */
  private cachedJob(runId: string): string | undefined {
    const jobId = this.jobs.get(runId);
    if (jobId === undefined) return undefined;
    this.rememberJob(runId, jobId);
    return jobId;
  }

  /** L1 only；命中时刷新 LRU 顺序。 */
  sync(runId: string): string | undefined {
    if (!runId) return undefined;
    const sessionId = this.cache.get(runId);
    if (sessionId === undefined) return undefined;
    this.remember(runId, sessionId);
    return sessionId;
  }

  /** L1 → L2 同步；L2 命中写回 L1。用于事件卡片与 hydration 映射。 */
  resolveSync(runId: string): string | undefined {
    const cached = this.sync(runId);
    if (cached !== undefined) return cached;
    if (!runId) return undefined;
    const fromEvents = nonEmptyString(this.sessionForRun?.(runId));
    if (fromEvents === undefined) return undefined;
    this.remember(runId, fromEvents);
    this.negative.delete(runId);
    return fromEvents;
  }

  /** run.started：写 L1、记录 core → job、清负缓存；映射变化时调用 onResolved。 */
  observe(runId: string, sessionId: string | undefined, jobId?: string): void {
    if (!runId) return;
    this.negative.delete(runId);
    const job = nonEmptyString(jobId);
    if (job !== undefined) this.rememberJob(runId, job);
    const resolved = nonEmptyString(sessionId);
    if (resolved === undefined) return;
    const previous = this.cache.get(runId);
    this.remember(runId, resolved);
    if (previous !== resolved) this.onResolved?.(runId, resolved);
  }

  /**
   * hydration runs.list 批量预热：优先用 core_run_id 作 key，缺失回退 run_id。
   * 同时记录 `core_run_id → run_id`（job id），供 L3 使用。
   */
  prewarm(runs: readonly RunSessionRecord[]): void {
    for (const run of runs) {
      const coreRunId = nonEmptyString(run.core_run_id);
      const key = coreRunId ?? nonEmptyString(run.run_id);
      if (key === undefined) continue;
      const jobId = nonEmptyString(run.run_id);
      if (coreRunId !== undefined && jobId !== undefined) {
        this.rememberJob(coreRunId, jobId);
        // 预热等价于一次命中：之前因缺少 job 映射而负缓存的 run 可以重试。
        this.negative.delete(coreRunId);
      }
      const sessionId = nonEmptyString(run.session_id);
      if (sessionId !== undefined) {
        this.remember(key, sessionId);
        this.negative.delete(key);
      }
    }
  }

  /** L1 → L2 → 负缓存 → L3（同 runId 并发共享同一 promise）。 */
  lookup(runId: string): Promise<string | undefined> {
    if (!runId) return Promise.resolve(undefined);

    const resolved = this.resolveSync(runId);
    if (resolved !== undefined) {
      // L1 / L2 命中：回填可能迟到的卡片；reducer 无变化时返回同一 state。
      this.onResolved?.(runId, resolved);
      return Promise.resolve(resolved);
    }

    const expiresAt = this.negative.get(runId);
    if (expiresAt !== undefined) {
      if (this.now() < expiresAt) return Promise.resolve(undefined);
      this.negative.delete(runId);
    }

    const pending = this.inFlight.get(runId);
    if (pending) return pending;
    if (!this.lookupRun) return Promise.resolve(undefined);

    // `runs.get` 只认 gateway job id；core id 直接查会 404。
    const jobId = nonEmptyString(this.jobForRun?.(runId)) ?? this.cachedJob(runId);
    if (jobId === undefined && this.jobForRun !== undefined) {
      // 有 job 映射来源但尚未观测到：等下一次 run.started / 预热，不拿 core id 试错。
      this.negative.set(runId, this.now() + this.negativeTtlMs);
      return Promise.resolve(undefined);
    }
    // 未提供 jobForRun（纯注入 / 单测）：退回 core id，保持旧的 lookupRun 语义。
    const lookupKey = jobId ?? runId;

    const generation = this.generation;
    const promise = (async (): Promise<string | undefined> => {
      try {
        const run = await this.lookupRun?.(lookupKey);
        const sessionId = nonEmptyString(run?.session_id);
        if (this.generation !== generation) return undefined;
        if (sessionId === undefined) {
          this.negative.set(runId, this.now() + this.negativeTtlMs);
          return undefined;
        }
        this.remember(runId, sessionId);
        this.negative.delete(runId);
        this.onResolved?.(runId, sessionId);
        return sessionId;
      } catch {
        if (this.generation === generation) {
          this.negative.set(runId, this.now() + this.negativeTtlMs);
        }
        return undefined;
      }
    })();

    this.inFlight.set(runId, promise);
    void promise.finally(() => {
      // reset() 可能已清空并写入新一代的 promise：只清理自己。
      if (this.inFlight.get(runId) === promise) this.inFlight.delete(runId);
    });
    return promise;
  }

  /** 切 tenant / 清 token：generation++，清空 L1 / job 映射 / 负缓存 / in-flight。 */
  reset(): void {
    this.generation += 1;
    this.cache.clear();
    this.jobs.clear();
    this.negative.clear();
    this.inFlight.clear();
  }
}
