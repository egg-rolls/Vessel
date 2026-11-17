/**
 * 外部存活看门狗（父进程侧；0.58）。
 *
 * 为什么必须由**父进程**做：`docs/dev/research/run-start-stall.md` 记录的僵死形态里，
 * 子进程的主线程整段停摆 —— 进程内的 100ms/250ms 定时器全部停跑、`/health` 超时、
 * 日志无新行、provider 一个请求都没收到。这个状态下**进程内部没有任何自救手段**
 * （连 `setInterval` 都不跑），唯一能推进的只有父进程，所以探活与重启都放在这里。
 *
 * 判定纪律（宁可漏杀，不许误杀）：
 * - 单次探活自带超时（缺省 2s），超时算「这一次失败」；
 * - **连续** `failureThreshold`（缺省 3）次失败才算僵死，成功一次立刻清零；
 * - 探活周期 2s × 3 次 ≈ 6–8s 窗口，跨过一次 GC 停顿 / 慢磁盘抖动；
 * - 处置只在「确认僵死」之后：强杀（POSIX `SIGKILL`）→ 重新 spawn → 记账；
 * - 重启后进入退避（1s → 2s → 4s … 上限 60s），连续 `recoveryProbes` 次探活成功才退出退避；
 * - 每小时重启上限（缺省 5）—— 超了就**停手并报错**，不把日志刷爆；
 * - 正在 stop/restart、子进程已退出、节点不是 ready/adopted 时**不探活**，走正常退出路径。
 *
 * 关掉：`gateway.supervise.enabled: false`（外部 systemd / k8s 已经在做同一件事时）。
 *
 * 状态落盘在 `<dataDir>/platform-watchdog[-<instance>].json`（运行时状态，不是 registry、
 * 不含 token），`gateway status` 据此显示「最近一次探活成功/失败 + 重启计数」。
 *
 * @module vessel/gateway/watchdog
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '@vessel-agent/core';
import { DEFAULT_GATEWAY_INSTANCE, normalizeGatewayInstance } from './pid';

/** 重启计数窗口（毫秒）。 */
const HOUR_MS = 3_600_000;

/** 解析后的生效配置（所有字段必有值）。 */
export interface StallWatchdogConfig {
  enabled: boolean;
  probeIntervalMs: number;
  probeTimeoutMs: number;
  failureThreshold: number;
  maxRestartsPerHour: number;
  backoffStartMs: number;
  backoffMaxMs: number;
  recoveryProbes: number;
}

/**
 * 缺省：**关**（0.55.1 起）/ 2s 探活 / 2s 超时 / 连续 3 次判死 / 每小时最多 5 次重启 /
 * 退避 1s 起翻倍到 60s / 连续 5 次成功退出退避。写在这里而不是散在调用点。
 *
 * 为什么默认关（真实事故）：这套探活**分不清「僵死」与「过载」**。2026-11-17 现场：
 * 前端把会话游标写歪后从 seq 1 重放 11.7 万条（WS 一条连接发了 30,061 帧 / 12.5 MB），
 * node 被打满 ⇒ `/health` 连续超时 ⇒ 看门狗 SIGKILL 重启 ⇒ 已加载状态丢掉、客户端从头再来
 * ⇒ **重启循环放大器**，10 分钟内重启 5 次。
 *
 * 正确形态需要「是否有进展」这一维（事件循环延迟、WS 字节/帧速率、RPC 完成数），
 * 在补齐之前**宁可让过载自己缓过来**，也不要杀它。要开就显式写 `gateway.supervise.enabled: true`
 * 或 `VESSEL_GATEWAY_SUPERVISE=1`，并自己承担上面那个风险。
 */
export const DEFAULT_STALL_WATCHDOG_CONFIG: StallWatchdogConfig = {
  enabled: false,
  probeIntervalMs: 2_000,
  probeTimeoutMs: 2_000,
  failureThreshold: 3,
  maxRestartsPerHour: 5,
  backoffStartMs: 1_000,
  backoffMaxMs: 60_000,
  recoveryProbes: 5,
};

/** `VESSEL_GATEWAY_SUPERVISE` 的关闭词（显式意图，优先于配置文件）。 */
const ENV_DISABLED_WORDS: readonly string[] = ['0', 'off', 'false', 'no', 'disabled'];
/** `VESSEL_GATEWAY_SUPERVISE` 的开启词。 */
const ENV_ENABLED_WORDS: readonly string[] = ['1', 'on', 'true', 'yes', 'enabled'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

/**
 * 把 `gateway.supervise`（可能未配置 / 未通过校验）解析成生效配置。
 *
 * 优先级：环境变量 > 配置文件 > 缺省。非法数值一律回退缺省值（配置校验已经拦过
 * 一次；这里只做防御，绝不因为一个笔误让看门狗变成「每次探活都重启」）。
 */
export function resolveStallWatchdogConfig(
  raw?: unknown,
  env?: Record<string, string | undefined>,
): StallWatchdogConfig {
  const source = isRecord(raw) ? raw : {};
  const backoffStartMs = positiveInt(
    source.backoffStartMs,
    DEFAULT_STALL_WATCHDOG_CONFIG.backoffStartMs,
  );
  const backoffMaxMs = Math.max(
    backoffStartMs,
    positiveInt(source.backoffMaxMs, DEFAULT_STALL_WATCHDOG_CONFIG.backoffMaxMs),
  );
  const config: StallWatchdogConfig = {
    enabled:
      typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_STALL_WATCHDOG_CONFIG.enabled,
    probeIntervalMs: positiveInt(
      source.probeIntervalMs,
      DEFAULT_STALL_WATCHDOG_CONFIG.probeIntervalMs,
    ),
    probeTimeoutMs: positiveInt(
      source.probeTimeoutMs,
      DEFAULT_STALL_WATCHDOG_CONFIG.probeTimeoutMs,
    ),
    failureThreshold: positiveInt(
      source.failureThreshold,
      DEFAULT_STALL_WATCHDOG_CONFIG.failureThreshold,
    ),
    maxRestartsPerHour: positiveInt(
      source.maxRestartsPerHour,
      DEFAULT_STALL_WATCHDOG_CONFIG.maxRestartsPerHour,
    ),
    backoffStartMs,
    backoffMaxMs,
    recoveryProbes: positiveInt(
      source.recoveryProbes,
      DEFAULT_STALL_WATCHDOG_CONFIG.recoveryProbes,
    ),
  };
  const flag = (env?.VESSEL_GATEWAY_SUPERVISE ?? '').trim().toLowerCase();
  if (ENV_DISABLED_WORDS.includes(flag)) config.enabled = false;
  else if (ENV_ENABLED_WORDS.includes(flag)) config.enabled = true;
  return config;
}

/** 看门狗对单个节点的相位（`gateway status` 直接显示）。 */
export type WatchdogPhase =
  /** 正常周期探活。 */
  | 'watching'
  /** 刚重启过，等连续成功够次数才退出退避（期间探活照跑）。 */
  | 'backoff'
  /** 正在强杀 + 重起。 */
  | 'restarting'
  /** 暂时不探活（正在 stop / 子进程已退出 / 节点不是 ready）。 */
  | 'paused'
  /** 撞上每小时重启上限：停手，等人处理。 */
  | 'exhausted';

/** 单个节点的看门狗快照（落盘 + `gateway status` 展示；不含 token）。 */
export interface WatchdogNodeSnapshot {
  node_id: string;
  name: string;
  pid: number | null;
  phase: WatchdogPhase;
  /** 最近一次探活**成功**的时刻（ISO 8601；从未成功 = null）。 */
  last_ok_at: string | null;
  /** 最近一次探活**失败**的时刻（ISO 8601；从未失败 = null）。 */
  last_fail_at: string | null;
  consecutive_failures: number;
  /** 连续成功次数（退出退避的判据）。 */
  consecutive_ok: number;
  restarts_total: number;
  /** 最近一小时内已用掉的自动重启次数。 */
  restarts_last_hour: number;
  /** 当前退避（下一次重启后的暂停时长，毫秒）。 */
  backoff_ms: number;
  last_restart_at: string | null;
  last_error: string | null;
}

/** `gateway status` / 落盘用的整体快照。 */
export interface WatchdogSnapshot {
  v: 1;
  updated_at: string;
  config: StallWatchdogConfig;
  nodes: WatchdogNodeSnapshot[];
}

/** 看门狗事件（一条事件 = 一行结构日志；名字即日志里的 `event=`）。 */
export type WatchdogEvent =
  | {
      kind: 'supervisor.stall_restart';
      nodeId: string;
      name: string;
      pid: number;
      consecutiveFailures: number;
      /** 最近一次探活成功时刻（epoch ms；从未成功 = null）。 */
      lastOkMs: number | null;
      /** 距最近一次成功的毫秒数（用于回答「僵了多久」；null = 从未成功）。 */
      stalledForMs: number | null;
      probeTimeoutMs: number;
      attemptInHour: number;
      maxRestartsPerHour: number;
      backoffMs: number;
    }
  | {
      kind: 'supervisor.stall_restart_failed';
      nodeId: string;
      name: string;
      pid: number;
      consecutiveFailures: number;
      probeTimeoutMs: number;
      error: string;
    }
  | {
      kind: 'supervisor.stall_restart_gave_up';
      nodeId: string;
      name: string;
      pid: number;
      consecutiveFailures: number;
      lastOkMs: number | null;
      stalledForMs: number | null;
      restartsLastHour: number;
      maxRestartsPerHour: number;
      reason: string;
    }
  | {
      kind: 'supervisor.stall_recovered';
      nodeId: string;
      name: string;
      pid: number;
      consecutiveOk: number;
    };

/** 一次重启请求（由看门狗给，由监督器执行）。 */
export interface NodeWatchdogRestartRequest {
  pid: number;
  consecutiveFailures: number;
  lastOkMs: number | null;
}

export interface NodeWatchdogOptions {
  nodeId: string;
  name: string;
  pid: number;
  config: StallWatchdogConfig;
  /** 一次探活；只回答「活/不活」，自己不许抛。 */
  probe: () => Promise<boolean>;
  /** 强杀 + 重新 spawn；返回新 pid 或失败原因（不许抛）。 */
  restart: (
    request: NodeWatchdogRestartRequest,
  ) => Promise<{ ok: true; pid: number } | { ok: false; error: string }>;
  /** true = 这一轮不探活（正在 stop / 子进程已退出 / 节点不是 ready）。 */
  paused?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (event: WatchdogEvent) => void;
  onChange?: (snapshot: WatchdogNodeSnapshot) => void;
}

function iso(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}

/**
 * 单节点看门狗（一个 node 一条循环；节点互不牵连）。
 *
 * 生命周期：`start()` 起循环 → `stop()` 收尾（幂等，`stop()` 之后不再探活，
 * 也不会再重启）。所有时间都走注入的 `now` / `sleep`，便于用假时钟验证窗口。
 */
export class NodeWatchdog {
  private readonly options: NodeWatchdogOptions;
  private readonly config: StallWatchdogConfig;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private pid: number;
  private stopped = false;
  private loopStarted = false;
  private readonly stopSignal: Promise<void>;
  private signalStop: () => void = () => undefined;

  private failures = 0;
  private oks = 0;
  private exhausted = false;
  private busy = false;
  private pausedNow = false;
  private inRecovery = false;

  private backoffMs: number;
  private restartGateUntil = 0;
  private restartTimes: number[] = [];
  private restartsTotal = 0;
  private lastOkAt: number | null = null;
  private lastFailAt: number | null = null;
  private lastRestartAt: number | null = null;
  private lastError: string | null = null;

  constructor(options: NodeWatchdogOptions) {
    this.options = options;
    this.config = options.config;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.pid = options.pid;
    this.backoffMs = this.config.backoffStartMs;
    this.stopSignal = new Promise<void>((resolve) => {
      this.signalStop = resolve;
    });
  }

  /** 起循环（重复调用无副作用）。 */
  start(): void {
    if (this.stopped || this.loopStarted) return;
    this.loopStarted = true;
    void this.loop();
  }

  /** 收尾：`stop()` 之后的探活结果全部忽略（正常关停期间不许触发）。 */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.signalStop();
  }

  /** 当前快照（`gateway status` / 落盘）。 */
  snapshot(): WatchdogNodeSnapshot {
    return {
      node_id: this.options.nodeId,
      name: this.options.name,
      pid: this.pid,
      phase: this.phase(),
      last_ok_at: iso(this.lastOkAt),
      last_fail_at: iso(this.lastFailAt),
      consecutive_failures: this.failures,
      consecutive_ok: this.oks,
      restarts_total: this.restartsTotal,
      restarts_last_hour: this.restartsLastHour(),
      backoff_ms: this.backoffMs,
      last_restart_at: iso(this.lastRestartAt),
      last_error: this.lastError,
    };
  }

  private phase(): WatchdogPhase {
    if (this.exhausted) return 'exhausted';
    if (this.busy) return 'restarting';
    if (this.pausedNow) return 'paused';
    return this.inRecovery ? 'backoff' : 'watching';
  }

  private restartsLastHour(): number {
    const now = this.now();
    this.restartTimes = this.restartTimes.filter((at) => now - at < HOUR_MS);
    return this.restartTimes.length;
  }

  private emitChange(): void {
    try {
      this.options.onChange?.(this.snapshot());
    } catch {
      // 观察者（落盘）异常不影响看门狗本身。
    }
  }

  private emitEvent(event: WatchdogEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // 同上：日志通道异常不能改变判定。
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped && !this.exhausted) {
      await this.waitOrStop(this.config.probeIntervalMs);
      if (this.stopped || this.exhausted) return;
      // 退避窗口内不探活：窗口本身是「刚重启过，先给它一口气」。
      if (this.now() < this.restartGateUntil) continue;
      const paused = this.options.paused?.() === true;
      if (paused !== this.pausedNow) {
        this.pausedNow = paused;
        this.emitChange();
      }
      if (paused) continue;
      await this.probeOnce();
    }
  }

  private async probeOnce(): Promise<void> {
    const ok = await this.probeWithTimeout();
    if (this.stopped) return;
    const at = this.now();
    if (ok) {
      this.failures = 0;
      this.lastOkAt = at;
      this.oks += 1;
      if (this.inRecovery && this.oks >= this.config.recoveryProbes) {
        // 连续成功够次数：退出退避，退避重置回起点（下一次僵死仍然反应得快）。
        this.inRecovery = false;
        this.backoffMs = this.config.backoffStartMs;
        this.lastError = null;
        this.emitEvent({
          kind: 'supervisor.stall_recovered',
          nodeId: this.options.nodeId,
          name: this.options.name,
          pid: this.pid,
          consecutiveOk: this.oks,
        });
      }
      this.emitChange();
      return;
    }
    this.oks = 0;
    this.failures += 1;
    this.lastFailAt = at;
    this.emitChange();
    if (this.failures < this.config.failureThreshold) return;
    await this.handleStall();
  }

  /** 单次探活：`probeTimeoutMs` 内没有答复就算失败（僵死现场 `/health` 就是这个形态）。 */
  private async probeWithTimeout(): Promise<boolean> {
    const probe = (async () => {
      try {
        return (await this.options.probe()) === true;
      } catch {
        return false;
      }
    })();
    const timeout = this.waitOrStop(this.config.probeTimeoutMs).then(() => false);
    const outcome = await Promise.race([probe, timeout]);
    return outcome === true;
  }

  private async handleStall(): Promise<void> {
    const at = this.now();
    this.restartTimes = this.restartTimes.filter((entry) => at - entry < HOUR_MS);
    const attempt = this.restartTimes.length + 1;
    const stalledForMs = this.lastOkAt === null ? null : at - this.lastOkAt;
    if (attempt > this.config.maxRestartsPerHour) {
      // 上界：停手 + 一条明确的错误，等人工处理（不无限重启、不刷屏）。
      this.exhausted = true;
      this.lastError =
        `stall restart cap reached: already restarted ${this.config.maxRestartsPerHour} ` +
        'time(s) within the last hour; watchdog stopped for this node ' +
        '(run `vessel gateway restart` or investigate the stall)';
      this.emitEvent({
        kind: 'supervisor.stall_restart_gave_up',
        nodeId: this.options.nodeId,
        name: this.options.name,
        pid: this.pid,
        consecutiveFailures: this.failures,
        lastOkMs: this.lastOkAt,
        stalledForMs,
        restartsLastHour: this.config.maxRestartsPerHour,
        maxRestartsPerHour: this.config.maxRestartsPerHour,
        reason: this.lastError,
      });
      this.emitChange();
      return;
    }

    this.restartTimes.push(at);
    this.restartsTotal += 1;
    const backoffMs = this.backoffMs;
    this.busy = true;
    this.emitChange();
    // 先记事件再杀：进程被杀之后日志通道只剩父进程自己，先落字才看得见时间线。
    this.emitEvent({
      kind: 'supervisor.stall_restart',
      nodeId: this.options.nodeId,
      name: this.options.name,
      pid: this.pid,
      consecutiveFailures: this.failures,
      lastOkMs: this.lastOkAt,
      stalledForMs,
      probeTimeoutMs: this.config.probeTimeoutMs,
      attemptInHour: attempt,
      maxRestartsPerHour: this.config.maxRestartsPerHour,
      backoffMs,
    });

    let outcome: { ok: true; pid: number } | { ok: false; error: string };
    try {
      outcome = await this.options.restart({
        pid: this.pid,
        consecutiveFailures: this.failures,
        lastOkMs: this.lastOkAt,
      });
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.busy = false;
    if (this.stopped) return;

    this.lastRestartAt = this.now();
    this.failures = 0;
    this.oks = 0;
    this.inRecovery = true;
    this.restartGateUntil = this.lastRestartAt + backoffMs;
    this.backoffMs = Math.min(backoffMs * 2, this.config.backoffMaxMs);
    if (outcome.ok) {
      this.pid = outcome.pid;
      this.lastError = null;
    } else {
      this.lastError = outcome.error;
      this.emitEvent({
        kind: 'supervisor.stall_restart_failed',
        nodeId: this.options.nodeId,
        name: this.options.name,
        pid: this.pid,
        consecutiveFailures: this.config.failureThreshold,
        probeTimeoutMs: this.config.probeTimeoutMs,
        error: outcome.error,
      });
    }
    this.emitChange();
  }

  /** `sleep`，但 `stop()` 能立刻打断（关停不等探活周期）。 */
  private waitOrStop(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return Promise.race([this.sleep(ms), this.stopSignal]);
  }
}

/** 定时器不挂住进程退出（daemon 关停不被看门狗拖住）。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms) as unknown as { unref?: () => void };
    timer.unref?.();
  });
}

/** `<dataDir>/platform-watchdog[-<instance>].json`（运行时状态；0600）。 */
export function watchdogSnapshotPath(dataDir: string, instance?: string): string {
  const name = normalizeGatewayInstance(instance);
  return path.join(
    dataDir,
    name === DEFAULT_GATEWAY_INSTANCE ? 'platform-watchdog.json' : `platform-watchdog-${name}.json`,
  );
}

/** 落盘（原子写）：`gateway status` 是另一个进程，只能靠这个文件看内部状态。 */
export async function writeWatchdogSnapshot(
  dataDir: string,
  instance: string | undefined,
  snapshot: WatchdogSnapshot,
): Promise<void> {
  await atomicWrite(
    watchdogSnapshotPath(dataDir, instance),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    { mode: 0o600, ensureDir: true },
  );
}

/**
 * 读快照；缺失/损坏返回 null（只读展示，绝不因此报错）。
 *
 * 字段做形状兜底：半个文件（旧版本写的、写到一半被杀的）也能显示成「未知」，
 * 而不是让 `gateway status` 整条挂掉。
 */
export async function readWatchdogSnapshot(
  dataDir: string,
  instance?: string,
): Promise<WatchdogSnapshot | null> {
  let raw: string;
  try {
    raw = await readFile(watchdogSnapshotPath(dataDir, instance), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return null;
  const nodesRaw = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const nodes: WatchdogNodeSnapshot[] = [];
  for (const entry of nodesRaw) {
    if (!isRecord(entry)) continue;
    if (typeof entry.node_id !== 'string' || entry.node_id === '') continue;
    nodes.push({
      node_id: entry.node_id,
      name: typeof entry.name === 'string' ? entry.name : entry.node_id,
      pid: typeof entry.pid === 'number' ? entry.pid : null,
      phase: isPhase(entry.phase) ? entry.phase : 'paused',
      last_ok_at: typeof entry.last_ok_at === 'string' ? entry.last_ok_at : null,
      last_fail_at: typeof entry.last_fail_at === 'string' ? entry.last_fail_at : null,
      consecutive_failures:
        typeof entry.consecutive_failures === 'number' ? entry.consecutive_failures : 0,
      consecutive_ok: typeof entry.consecutive_ok === 'number' ? entry.consecutive_ok : 0,
      restarts_total: typeof entry.restarts_total === 'number' ? entry.restarts_total : 0,
      restarts_last_hour:
        typeof entry.restarts_last_hour === 'number' ? entry.restarts_last_hour : 0,
      backoff_ms: typeof entry.backoff_ms === 'number' ? entry.backoff_ms : 0,
      last_restart_at: typeof entry.last_restart_at === 'string' ? entry.last_restart_at : null,
      last_error: typeof entry.last_error === 'string' ? entry.last_error : null,
    });
  }
  return {
    v: 1,
    updated_at:
      typeof parsed.updated_at === 'string' ? parsed.updated_at : new Date(0).toISOString(),
    config: resolveStallWatchdogConfig(parsed.config),
    nodes,
  };
}

const PHASES: readonly WatchdogPhase[] = [
  'watching',
  'backoff',
  'restarting',
  'paused',
  'exhausted',
];

function isPhase(value: unknown): value is WatchdogPhase {
  return typeof value === 'string' && (PHASES as readonly string[]).includes(value);
}
