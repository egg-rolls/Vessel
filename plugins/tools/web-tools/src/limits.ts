/**
 * 三道成本闸 + 限流 + 熔断（设计 §5.4 / §5.5）。
 *
 * **为什么必须有**：按次计费 + 模型自我纠错会反复搜同一个问题。一次 run 打 200 次搜索 = 1 元，
 * 而且没人会注意。每 run 配额是「看得见」的那道，**每进程日上限**是「没人看也不会失控」的那道。
 *
 * 检查顺序（失败要快、且不花钱）：
 * `参数校验` → `缺 key` → `熔断打开?` → `每 run 配额` → `日上限` → 发请求。
 * `acquire()` 只负责后三步；前两步在工具层（参数、`secrets.readKey`），
 * 五步之中任何一步拒绝都**不产生网络往返**。
 *
 * 计数口径：**只数「会被计费的调用」**（search 且结果非空、fetch 且拿到正文）。
 * 失败不计费 ⇒ 不计入日上限；持续的失败由熔断挡——否则「失败把日配额烧光」会让工具
 * 在坏天气里彻底不可用。
 */

import {
  MAX_BILLED_CALLS_PER_DAY,
  MAX_DEEPSEEK_FETCH_PER_RUN,
  MAX_SEARCH_PER_RUN,
  type WebToolsConfig,
} from './config';
import { WebFetchError } from './types';

/** 一个 run 里最多 15 次搜索（常量与本文件所有理由见 config.ts 的同名导出） */
export { MAX_BILLED_CALLS_PER_DAY, MAX_DEEPSEEK_FETCH_PER_RUN, MAX_SEARCH_PER_RUN };
/** 连续 5 次失败（不含 4xx 客户端错）⇒ 打开 60s：够区分偶发抖动与真挂了 */
export const BREAKER_FAILURES = 5;
export const BREAKER_OPEN_MS = 60_000;
/** 重试：最多 2 次重试（3 attempts），400ms 起指数 ×2 + ±30% 抖动 */
export const RETRY_MAX = 2;
export const RETRY_BASE_MS = 400;
/** 自建限流（远低于服务端 100/25 QPS）：被 429 比慢 200ms 贵 */
export const SEARCH_QPS = 5;
export const FETCH_QPS = 3;
export const FETCH_HOST_MIN_INTERVAL_MS = 500;
/** 排队最多等 2s，超时即 `provider_rate_limited`（有界等待，不建无界队列） */
export const QUEUE_MAX_WAIT_MS = 2_000;

export type CostKind = 'search' | 'deepseek_fetch';

/**
 * 一次计费调用的结局：
 * - `billed`：会被计费（search 有结果 / fetch 拿到正文）⇒ 累加 run 与日计数；
 * - `empty`：成功但不计费（空结果）⇒ 不算配额，只重置熔断；
 * - `client_error`：上游 4xx（我们的错）⇒ 不动熔断、不计数；
 * - `failure`：5xx / 网络 / 超时 ⇒ 熔断计数；
 * - `skipped`：本地拒绝（未发请求）⇒ 只释放半开探针。
 */
export type CostOutcome = 'billed' | 'empty' | 'client_error' | 'failure' | 'skipped';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CostDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface CostSnapshot {
  runUsed: number;
  runLimit: number;
  dailyUsed: number;
  dailyLimit: number;
  breaker: BreakerState;
}

/** 一次 `acquire()` 的凭据：结局必须结算一次（幂等） */
export interface CostTicket {
  billed(): void;
  empty(): void;
  clientError(): void;
  failure(): void;
  skipped(): void;
  snapshot(): CostSnapshot;
}

interface BreakerRecord {
  failures: number;
  openedAt: number;
  probing: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

function stableInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

export class CostController {
  private readonly config: WebToolsConfig;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly billedByRun = new Map<CostKind, Map<string, number>>();
  private readonly breakers = new Map<CostKind, BreakerRecord>();
  private readonly windows = new Map<CostKind, number[]>();
  /** host → 最近一次开始时间；与下面那条 tail 链分开，避免链被旧对象覆盖 */
  private readonly hostLast = new Map<string, number>();
  private readonly hostTails = new Map<string, Promise<void>>();
  private dayKey = '';
  private dailyUsed = 0;

  constructor(config: WebToolsConfig, deps: CostDeps = {}) {
    this.config = config;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
  }

  // ---------------------------------------------------------------- 三道闸

  async acquire(kind: CostKind, runKey: string): Promise<CostTicket> {
    const limit = this.runLimit(kind);
    // ① 熔断：打开期间**不发请求**
    const breaker = this.breakerOf(kind);
    if (breaker.openedAt > 0) {
      const elapsed = this.now() - breaker.openedAt;
      if (elapsed < this.config.breakerOpenMs) {
        throw new WebFetchError(
          'circuit_open',
          `熔断打开：连续 ${breaker.failures} 次失败，${Math.ceil((this.config.breakerOpenMs - elapsed) / 1000)}s 后恢复（本次没有发出任何请求）`,
        );
      }
      if (breaker.probing) {
        throw new WebFetchError(
          'circuit_open',
          '熔断半开：已有一个探针在途（本次没有发出任何请求）',
        );
      }
      breaker.probing = true;
    }

    // ② 每 run 配额
    const used = this.runUsed(kind, runKey);
    if (used >= limit) {
      throw new WebFetchError(
        'max_uses_exceeded',
        `本次 run 的 ${kindLabel(kind)} 配额已用尽（${used}/${limit}）；继续要更多请开新 run（本次没有发出任何请求）`,
      );
    }

    // ③ 每进程日上限
    this.rollDay();
    const dailyLimit = this.config.maxBilledCallsPerDay;
    if (this.dailyUsed >= dailyLimit) {
      const error = new WebFetchError(
        'max_uses_exceeded',
        `今日计费调用已达上限（daily_used ${this.dailyUsed}/${dailyLimit}），本进程内不再发计费请求（本次没有发出任何请求）`,
      );
      throw error;
    }

    let settled = false;
    const settle = (outcome: CostOutcome): void => {
      if (settled) return;
      settled = true;
      this.applyOutcome(kind, runKey, outcome, breaker);
    };

    return {
      billed: () => settle('billed'),
      empty: () => settle('empty'),
      clientError: () => settle('client_error'),
      failure: () => settle('failure'),
      skipped: () => settle('skipped'),
      snapshot: () => this.snapshot(kind, runKey),
    };
  }

  snapshot(kind: CostKind, runKey: string): CostSnapshot {
    this.rollDay();
    return {
      runUsed: this.runUsed(kind, runKey),
      runLimit: this.runLimit(kind),
      dailyUsed: this.dailyUsed,
      dailyLimit: this.config.maxBilledCallsPerDay,
      breaker: this.breakerState(kind),
    };
  }

  /** 日计数与 run 计数器（日志/输出用；不含 key、不含 query 明文） */
  dailyCount(): number {
    this.rollDay();
    return this.dailyUsed;
  }

  private applyOutcome(
    kind: CostKind,
    runKey: string,
    outcome: CostOutcome,
    breaker: BreakerRecord,
  ): void {
    switch (outcome) {
      case 'billed': {
        const map = this.billedByRun.get(kind) ?? new Map<string, number>();
        map.set(runKey, (map.get(runKey) ?? 0) + 1);
        // run 结束没有清理钩子 ⇒ 自己封顶：超了就丢最早的那个 run 键
        while (map.size > 512) {
          const oldest = map.keys().next();
          if (oldest.done === true) break;
          map.delete(oldest.value);
        }
        this.billedByRun.set(kind, map);
        this.rollDay();
        this.dailyUsed += 1;
        this.resetBreaker(breaker);
        return;
      }
      case 'empty':
        this.resetBreaker(breaker);
        return;
      case 'failure': {
        breaker.failures += 1;
        breaker.probing = false;
        if (breaker.failures >= this.config.breakerFailures) {
          breaker.openedAt = this.now();
        }
        return;
      }
      case 'client_error':
        breaker.probing = false;
        return;
      case 'skipped':
        breaker.probing = false;
        return;
      default:
        return;
    }
  }

  private resetBreaker(breaker: BreakerRecord): void {
    breaker.failures = 0;
    breaker.openedAt = 0;
    breaker.probing = false;
  }

  private breakerOf(kind: CostKind): BreakerRecord {
    const existing = this.breakers.get(kind);
    if (existing) return existing;
    const created: BreakerRecord = { failures: 0, openedAt: 0, probing: false };
    this.breakers.set(kind, created);
    return created;
  }

  private breakerState(kind: CostKind): BreakerState {
    const breaker = this.breakerOf(kind);
    if (breaker.openedAt === 0) return 'closed';
    return this.now() - breaker.openedAt < this.config.breakerOpenMs ? 'open' : 'half_open';
  }

  private runLimit(kind: CostKind): number {
    const configured =
      kind === 'search' ? this.config.maxUsesSearchPerRun : this.config.maxUsesFetchPerRun;
    const fallback = kind === 'search' ? MAX_SEARCH_PER_RUN : MAX_DEEPSEEK_FETCH_PER_RUN;
    return stableInt(configured, fallback);
  }

  private runUsed(kind: CostKind, runKey: string): number {
    return this.billedByRun.get(kind)?.get(runKey) ?? 0;
  }

  /** 日计数按**本地时区自然日**翻转（只在翻转或进程重启时归零） */
  private rollDay(): void {
    const today = new Date(this.now()).toDateString();
    if (today !== this.dayKey) {
      this.dayKey = today;
      this.dailyUsed = 0;
    }
  }

  // ---------------------------------------------------------------- 限流

  /** 1s 滑动窗口令牌桶；有界等待 ≤2s，超时即 `provider_rate_limited`（未发请求） */
  async throttle(kind: CostKind): Promise<void> {
    const qps = kind === 'search' ? this.config.searchQps : this.config.fetchQps;
    const limit = stableInt(qps, kind === 'search' ? SEARCH_QPS : FETCH_QPS);
    const startedAt = this.now();
    for (;;) {
      const now = this.now();
      const window = (this.windows.get(kind) ?? []).filter((at) => now - at < 1_000);
      if (window.length < limit) {
        window.push(now);
        this.windows.set(kind, window);
        return;
      }
      const oldest = window[0] ?? now;
      const waitMs = Math.max(1, 1_000 - (now - oldest));
      if (now - startedAt + waitMs > QUEUE_MAX_WAIT_MS) {
        this.windows.set(kind, window);
        throw new WebFetchError(
          'provider_rate_limited',
          `本地限流排队超过 ${QUEUE_MAX_WAIT_MS / 1000}s（${kindLabel(kind)} ${limit} QPS），本次没有发出请求`,
        );
      }
      this.windows.set(kind, window);
      await this.sleep(waitMs);
    }
  }

  /** 同一 host 串行 + 最小间隔（服务端有域名级限制，数值未知 ⇒ 保守自建） */
  async throttleHost(host: string): Promise<void> {
    const key = host.toLowerCase();
    const previous = this.hostTails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 链上排队：下一个调用者等这个 gate，避免「等着等着又并发出去」
    this.hostTails.set(
      key,
      previous.then(() => gate),
    );
    await previous;
    try {
      const last = this.hostLast.get(key) ?? 0;
      const wait = this.config.fetchHostMinIntervalMs - (this.now() - last);
      if (wait > 0) await this.sleep(Math.min(wait, QUEUE_MAX_WAIT_MS));
      this.hostLast.set(key, this.now());
    } finally {
      release();
    }
  }

  // ---------------------------------------------------------------- 重试退避

  /** 指数退避 + ±30% 抖动（必须有抖动：否则并发调用同步重试把限流变雪崩） */
  backoffMs(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      return Math.min(retryAfterMs, this.config.retryBaseMs * 4);
    }
    const base = this.config.retryBaseMs * 2 ** Math.max(0, attempt);
    const jitter = 0.7 + this.random() * 0.6;
    return Math.min(Math.round(base * jitter), 2_000);
  }
}

function kindLabel(kind: CostKind): string {
  return kind === 'search' ? '搜索' : 'deepseek 抓取';
}

// ---------------------------------------------------------------- 指标行

/** 只记白名单字段：**永不**记 query 明文 / 完整 URL 的 query string / 任何 header / key */
export interface MetricFields {
  tool: string;
  backend?: string;
  provider_id?: string;
  query_chars?: number;
  query_sha8?: string;
  count?: number;
  detail?: string;
  need_content?: boolean;
  cached?: boolean;
  cached_age_s?: number;
  results?: number;
  out_tokens_est?: number;
  latency_ms?: number;
  upstream_ms?: number;
  attempts?: number;
  status_class?: string;
  code?: string;
  breaker_state?: string;
  quota_used?: number;
  key_env?: string;
  key_present?: boolean;
  host?: string;
  url_sha8?: string;
}

export type MetricSink = (line: string) => void;

/** 插件没有 logger ⇒ 一行 JSON 到 stderr，前缀 `[web-tools]`（设计 §7） */
export function emitMetric(fields: MetricFields, sink: MetricSink = defaultSink): void {
  const payload = { ts: new Date().toISOString(), ...fields };
  try {
    sink(`[web-tools] ${JSON.stringify(payload)}`);
  } catch {
    // 指标永远不许把主流程带崩
  }
}

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
}
