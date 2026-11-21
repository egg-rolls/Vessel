/**
 * engine 池监督（engine-pool 契约 S7 + S5；阶段② M-P5）。
 *
 * gateway 监督 M 个 **detached** tools-engine 进程：spawn / 探测 / 重启预算 / adopt / stop，
 * 并作为 `routing.json` 的**唯一写者**向 node 发布数据面路由（只发布 data_token）。
 * 模板 = node-supervisor.ts（detached + 自写状态文件 + adopt/external 永不杀 + taskkill /T /F）
 * 与 tools-engine/supervisor.ts（滑动窗口重启预算，常量自 @vessel-agent/serve）。
 *
 * 冻结行为（契约 §1 S7 / §3）：
 * - **detached spawn**（argv `[execPath, entryPath]`，stdout/stderr → 日志文件，**不用 stdio 控制**）：
 *   gateway restart 不杀 detached engine，新前台 adopt（topology.md:97 重启语义）。
 * - **探测周期缺省 5s**：控制连接（control_token）ping + pid 存活复核；pid 复核带 started_at
 *   防 pid 复用（node-supervisor 归属复核同口径，只在终止/接管时收紧，不误杀）。
 * - **exit / spawn 失败 → 预算内 one-for-one respawn**（PLUGIN_MAX_RESTARTS=3 / WINDOW=10min，
 *   delay 缺省 1s）；预算尽 → disabled + routing 除名 + logger.error，**不无限重启、不静默补位**。
 * - **ping 超时 → draining（不杀，Q6 保守）**：routing 降级 node 避让；宽限观察进展维度
 *   （S4 inflight_total），v1 不自动 terminate（阈值演进另批）。busy ≠ 故障，不触发重启。
 * - **start 时 adopt**：读 S6 状态文件 + 控制 ping 通 → adopted（owned=false）；不在 manifest →
 *   external；pid 死 → 清状态文件 + 预算内 respawn（容量缺口由补位 spawn 填）。
 * - **stop**：控制连接 deactivate → 宽限 → win32 `taskkill /PID <pid> /T /F` 兜底；
 *   adopt/external **永不杀**。
 * - **routing.json 唯一写者**（S5）：atomicWrite durable 0600；只发布 data_token，control_token
 *   永不进 routing；epoch 内 revision 单调；成员/健康变化 → revision++。
 *
 * **manifest 口径（实施解释，登记供 N 审查）**：契约「不在 manifest → external」沿用
 * node-supervisor 的归属词汇，但池不新增 manifest 文件实体（宪法 10）——**上一纪元的
 * routing.json 即监督 manifest**（gateway 唯一写者，记录的正是本 gateway 谱系发布过的 engine）。
 * start 时读旧 routing 的 engine id 集合：状态文件活 engine ∈ 集合 → adopted，∉ → external
 * （手工/外部启动，永不杀）。首次 start 无旧 routing → 全部 external（保守，判据只收紧不放松）。
 *
 * 控制连接帧泵走 S10 ndjson codec（@vessel-agent/serve 导出，禁第二份序列化实现）；
 * 协议形状（EngineAuthFrame / ENGINE_WIRE / 8MiB 上限）唯一真源 = engine-client protocol.ts。
 *
 * @module vessel/gateway/pool-supervisor
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, unlink } from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { atomicWrite, type Logger, noopLogger } from '@vessel-agent/core';
import {
  ENGINE_MAX_MESSAGE_BYTES,
  ENGINE_WIRE,
  type EngineAuthFrame,
} from '@vessel-agent/engine-client';
import {
  attachNdjsonReader,
  createNdjsonWriter,
  PLUGIN_MAX_RESTARTS,
  PLUGIN_RESTART_WINDOW_MS,
} from '@vessel-agent/serve';
import { type CommandRunner, createCommandRunner, isBeforeBoot, isProcessAlive } from './pid';

// ── S7 冻结签名（逐字） ──────────────────────────────────────

export interface PoolSupervisorOptions {
  poolDir: string;
  entryPath: string;
  rootDir: string;
  size: number;
  /** {maxInflight?, rssSoftLimitMb?, dataDir(池级日志)} → VESSEL_PLUGIN_CONFIG。 */
  settings?: Record<string, unknown>;
  logger?: Logger;
  restartWindowMs?: number;
  maxRestarts?: number;
  restartDelayMs?: number;
  probeIntervalMs?: number;
  now?: () => number;
}

export interface PoolMemberView {
  id: string;
  port: number;
  status: 'starting' | 'ready' | 'draining' | 'disabled' | 'adopted' | 'external';
  restarts: number;
  owned: boolean;
}

export interface PoolSupervisor {
  start(): Promise<void>;
  /** terminate owned engines；adopt/external 永不杀。 */
  stop(): Promise<void>;
  members(): readonly PoolMemberView[];
}

// ── 常量（缺省值；契约冻结项标注） ───────────────────────────

/** S7：探测周期缺省 5s [推断调参]。 */
const DEFAULT_PROBE_INTERVAL_MS = 5_000;
/** S2：5s 未鉴权 → close（客户端同口径放弃）。 */
const AUTH_TIMEOUT_MS = 5_000;
/** plugin.hello 握手超时（child.ts PLUGIN_TIMEOUTS.handshake 同值）。 */
const HELLO_TIMEOUT_MS = 5_000;
/** plugin.activate 超时（child.ts PLUGIN_TIMEOUTS.activate 同值）。 */
const ACTIVATE_TIMEOUT_MS = 10_000;
/** 控制 ping 探测超时（探测周期同量级；数据面心跳 15s 是另一口径，S8）。 */
const PING_TIMEOUT_MS = 5_000;
/** draining 进展维度 engine.health 观测超时（S4）。 */
const HEALTH_TIMEOUT_MS = 5_000;
/** plugin.deactivate 超时（child.ts PLUGIN_TIMEOUTS.deactivate 同值）。 */
const DEACTIVATE_TIMEOUT_MS = 2_000;
/** spawn 就绪上界（状态文件 + 控制握手）；超时按 spawn 失败走预算路径。 */
const SPAWN_READY_TIMEOUT_MS = 30_000;
/** stop 宽限（deactivate 后等自死；node-supervisor DEFAULT_STOP_TIMEOUT_MS 同值）。 */
const STOP_GRACE_MS = 5_000;
/** 强杀后确认死亡预算。 */
const KILL_CONFIRM_MS = 5_000;
const POLL_MS = 100;
const LOOPBACK_HOST = '127.0.0.1';

// ── 内部形状（S5/S6 冻结文件的读面；不导出） ─────────────────

/** S6 engines/<id>.json（engine 自写；gateway 只读）。 */
interface EngineStateFile {
  v: 1;
  id: string;
  pid: number;
  port: number;
  control_token: string;
  data_token: string;
  version: string;
  started_at: number;
}

/** S5 routing.json 引擎条目（只发布 data_token；control_token 永不进 routing）。 */
interface RoutingEngineEntry {
  id: string;
  port: number;
  data_token: string;
  status: 'ready' | 'draining' | 'disabled';
}

/** S5 routing.json（gateway 唯一写者）。 */
interface RoutingFile {
  v: 1;
  epoch: string;
  revision: number;
  updated_at: number;
  engines: RoutingEngineEntry[];
}

/** 控制连接句柄（S10 codec 泵 + JSON-RPC pending 关联，消费方自持）。 */
interface ControlLink {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  close(): void;
  readonly closed: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 池成员 = 一个 engine 槽位（respawn 换新 id，重启历史随槽位继承）。 */
interface PoolMember {
  id: string;
  port: number;
  pid: number;
  startedAt: number;
  controlToken: string;
  dataToken: string;
  owned: boolean;
  origin: 'spawned' | 'adopted' | 'external';
  status: PoolMemberView['status'];
  restarts: number;
  restartTimestamps: number[];
  restartTimer?: ReturnType<typeof setTimeout>;
  link?: ControlLink;
  spawn?: ReturnType<typeof Bun.spawn>;
  probing: boolean;
  drainingSince?: number;
  lastInflight?: number;
}

// ── 模块级工具 ───────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rpcErrorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return 'control request failed';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** S6 形状机械校验（形状不过 → undefined；调用方不据此删文件，保守）。 */
function parseStateFile(raw: unknown, expectedId: string): EngineStateFile | undefined {
  if (!isRecord(raw) || raw.v !== 1) return undefined;
  const id = raw.id;
  const pid = raw.pid;
  const port = raw.port;
  const controlToken = raw.control_token;
  const dataToken = raw.data_token;
  const version = raw.version;
  const startedAt = raw.started_at;
  if (typeof id !== 'string' || id !== expectedId) return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  if (typeof controlToken !== 'string' || controlToken === '') return undefined;
  if (typeof dataToken !== 'string' || dataToken === '') return undefined;
  if (typeof version !== 'string') return undefined;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) {
    return undefined;
  }
  return {
    v: 1,
    id,
    pid,
    port,
    control_token: controlToken,
    data_token: dataToken,
    version,
    started_at: startedAt,
  };
}

/**
 * 拨号控制连接：首行 S2 auth 帧（control role），回包 `{ok:true}` 后进入 JSON-RPC 请求面。
 * 帧泵 = S10 codec（attachNdjsonReader / createNdjsonWriter）；pending 关联本消费方自持。
 * 失败 close（不返回错误帧，S2）；超时/违约/对端 close → 折 reject。
 */
function dialControl(
  port: number,
  token: string,
  timeoutMs: number,
  onClose?: () => void,
): Promise<ControlLink> {
  return new Promise<ControlLink>((resolve, reject) => {
    const socket = net.createConnection({ host: LOOPBACK_HOST, port });
    const pending = new Map<number, PendingRequest>();
    let nextId = 1;
    let authenticated = false;
    let closed = false;
    let dialSettled = false;

    function finishDial(error?: Error): void {
      if (dialSettled) return;
      dialSettled = true;
      clearTimeout(authTimer);
      if (error !== undefined) {
        closeLink();
        reject(error);
      } else {
        resolve(link);
      }
    }

    function closeLink(): void {
      if (closed) return;
      closed = true;
      clearTimeout(authTimer);
      reader.close();
      socket.destroy();
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('control connection closed'));
      }
      pending.clear();
      if (!dialSettled) {
        dialSettled = true;
        reject(new Error('control connection closed before auth'));
      }
      onClose?.();
    }

    const authTimer = setTimeout(() => {
      finishDial(new Error(`control auth timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const reader = attachNdjsonReader(socket, {
      maxBytes: ENGINE_MAX_MESSAGE_BYTES,
      onFrame: (frame) => {
        if (!authenticated) {
          if (frame.ok === true) {
            authenticated = true;
            finishDial();
          } else {
            finishDial(new Error('control auth rejected'));
          }
          return;
        }
        // 回包帧（id + result/error）→ settle pending；engine→gateway 请求不在控制方法面，忽略。
        const id = typeof frame.id === 'number' ? frame.id : undefined;
        if (id === undefined) return;
        const p = pending.get(id);
        if (p === undefined) return;
        if (frame.result === undefined && frame.error === undefined) return;
        pending.delete(id);
        clearTimeout(p.timer);
        if (frame.error !== undefined) p.reject(new Error(rpcErrorMessage(frame.error)));
        else p.resolve(frame.result);
      },
      onViolation: () => closeLink(),
    });
    const writer = createNdjsonWriter(socket, {
      maxBytes: ENGINE_MAX_MESSAGE_BYTES,
      // 写端不产生入站帧（child.ts 同口径）；出站超限 → closeLink fail-closed。
      onFrame: () => {},
      onViolation: () => closeLink(),
    });

    const link: ControlLink = {
      get closed() {
        return closed;
      },
      close: closeLink,
      request(method: string, params: unknown, requestTimeoutMs: number): Promise<unknown> {
        if (closed || !authenticated) {
          return Promise.reject(new Error('control connection not ready'));
        }
        const id = nextId;
        nextId += 1;
        return new Promise<unknown>((res, rej) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`${method} timed out after ${requestTimeoutMs}ms`));
          }, requestTimeoutMs);
          pending.set(id, { resolve: res, reject: rej, timer });
          if (!writer.writeFrame({ jsonrpc: '2.0', id, method, params })) {
            pending.delete(id);
            clearTimeout(timer);
            rej(new Error(`${method} request frame exceeds byte limit`));
          }
        });
      },
    };

    socket.on('error', () => closeLink());
    socket.on('close', () => closeLink());
    socket.on('connect', () => {
      const auth: EngineAuthFrame = { kind: 'auth', role: 'control', token };
      if (!writer.writeFrame({ ...auth })) closeLink();
    });
  });
}

async function waitUntilDead(pid: number, timeoutMs: number, now: () => number): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(POLL_MS);
  }
  return !isProcessAlive(pid);
}

/**
 * 强杀兜底（node-supervisor terminateChild 先例）：win32 `process.kill` 后
 * `taskkill /PID <pid> /T /F` 兜底整棵子树；POSIX SIGTERM → SIGKILL。不做按端口/进程名批量杀。
 */
async function killPid(pid: number, runCommand: CommandRunner, now: () => number): Promise<void> {
  try {
    if (process.platform === 'win32') process.kill(pid);
    else process.kill(pid, 'SIGTERM');
  } catch {
    // ESRCH = 已死；EPERM 等 = 杀不动，交回调用方 waitUntilDead 判定。
    return;
  }
  if (process.platform === 'win32') {
    if (await waitUntilDead(pid, 500, now)) return;
    await runCommand(['taskkill', '/PID', String(pid), '/T', '/F']).catch(() => undefined);
    return;
  }
  if (await waitUntilDead(pid, STOP_GRACE_MS, now)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // ESRCH = 已死。
  }
}

// ── 组件 ─────────────────────────────────────────────────────

export function createPoolSupervisor(options: PoolSupervisorOptions): PoolSupervisor {
  const logger = options.logger ?? noopLogger;
  const restartWindowMs = options.restartWindowMs ?? PLUGIN_RESTART_WINDOW_MS;
  const maxRestarts = options.maxRestarts ?? PLUGIN_MAX_RESTARTS;
  const restartDelayMs = options.restartDelayMs ?? 1_000;
  const probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const runCommand = createCommandRunner();

  const enginesDir = path.join(options.poolDir, 'engines');
  const routingPath = path.join(options.poolDir, 'routing.json');
  // 池级日志目录 = settings.dataDir（S7 注释）；缺省回落 poolDir。
  const settingsDataDir =
    typeof options.settings?.dataDir === 'string' ? options.settings.dataDir : undefined;
  const logBaseDir = settingsDataDir ?? options.poolDir;

  const memberList: PoolMember[] = [];
  let epoch = '';
  let revision = 0;
  let publishChain: Promise<void> = Promise.resolve();
  let probeTimer: ReturnType<typeof setInterval> | undefined;
  let started = false;
  let stopped = false;
  let startPromise: Promise<void> | undefined;

  // ── 文件读面 ───────────────────────────────────────────────

  async function readStateFile(id: string): Promise<EngineStateFile | undefined> {
    try {
      const raw = await readFile(path.join(enginesDir, `${id}.json`), 'utf8');
      return parseStateFile(JSON.parse(raw), id);
    } catch {
      return undefined;
    }
  }

  /** pid 死 / 归属终止后清状态文件（S7）；形状不过的文件不删（保守）。 */
  async function unlinkStateFile(id: string): Promise<void> {
    await unlink(path.join(enginesDir, `${id}.json`)).catch(() => undefined);
  }

  /** 上一纪元 routing = 监督 manifest（见模块 doc）；读失败 → 空集合（全 external，保守）。 */
  async function readPreviousRoutingIds(): Promise<Set<string>> {
    try {
      const raw = await readFile(routingPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.engines)) {
        return new Set();
      }
      const ids = new Set<string>();
      for (const entry of parsed.engines) {
        if (isRecord(entry) && typeof entry.id === 'string') ids.add(entry.id);
      }
      return ids;
    } catch {
      return new Set();
    }
  }

  // ── routing 发布（S5；唯一写者） ───────────────────────────

  function routingIncluded(member: PoolMember): boolean {
    if (member.port <= 0 || member.dataToken === '') return false;
    if (stopped && member.owned) return false; // stop 先除名 owned（drain 信号），再终止。
    return (
      member.status === 'ready' ||
      member.status === 'adopted' ||
      member.status === 'external' ||
      member.status === 'draining'
    );
  }

  /** revision++（epoch 内单调）；快照按调用序串行落盘（atomicWrite durable 0600）。 */
  function publish(): Promise<void> {
    revision += 1;
    const snapshot: RoutingFile = {
      v: 1,
      epoch,
      revision,
      updated_at: now(),
      engines: memberList.filter(routingIncluded).map((member) => ({
        id: member.id,
        port: member.port,
        data_token: member.dataToken,
        status: member.status === 'draining' ? ('draining' as const) : ('ready' as const),
      })),
    };
    const write = publishChain.then(() =>
      atomicWrite(routingPath, JSON.stringify(snapshot), {
        durable: true,
        mode: 0o600,
        ensureDir: true,
      }),
    );
    publishChain = write.then(
      () => undefined,
      (error: unknown) => {
        logger.error('pool routing.json publish failed', { message: errorMessage(error) });
      },
    );
    return publishChain;
  }

  // ── 状态机 ─────────────────────────────────────────────────

  function healthyStatus(member: PoolMember): PoolMemberView['status'] {
    if (member.owned) return 'ready';
    return member.origin === 'adopted' ? 'adopted' : 'external';
  }

  function markHealthy(member: PoolMember): void {
    if (stopped) return;
    const target = healthyStatus(member);
    if (member.status === target) return;
    member.status = target;
    member.drainingSince = undefined;
    member.lastInflight = undefined;
    logger.info('pool engine recovered', { id: member.id, port: member.port });
    void publish();
  }

  /** Q6 保守：ping 超时只降级 draining（routing 避让），**不杀**；v1 不自动 terminate。 */
  function markDraining(member: PoolMember, reason: string): void {
    if (stopped || member.status === 'draining') return;
    member.status = 'draining';
    member.drainingSince = now();
    member.lastInflight = undefined;
    logger.warn('pool engine draining (not killing; Q6 conservative)', {
      id: member.id,
      pid: member.pid,
      reason,
    });
    void publish();
  }

  /** draining 宽限观察进展维度（S4 inflight_total）；只记录，v1 不据此 terminate。 */
  async function observeProgress(member: PoolMember, link: ControlLink): Promise<void> {
    if (link.closed) return;
    try {
      const health = await link.request(ENGINE_WIRE.health, {}, HEALTH_TIMEOUT_MS);
      if (isRecord(health) && typeof health.inflight_total === 'number') {
        const previous = member.lastInflight;
        member.lastInflight = health.inflight_total;
        logger.info('pool engine draining: inflight observation', {
          id: member.id,
          inflight_total: health.inflight_total,
          previous_inflight: previous,
          draining_since: member.drainingSince,
        });
      }
    } catch {
      // health 也不应答：保持 draining，等 pid / 探测判定。
    }
  }

  function removeMember(member: PoolMember): void {
    const index = memberList.indexOf(member);
    if (index >= 0) memberList.splice(index, 1);
  }

  /**
   * exit / pid 死 → one-for-one 容量恢复（external 除外：不监督、不补位）。
   * 重启历史随槽位继承；预算尽 → disabled + routing 除名 + escalate。
   */
  function handleExit(member: PoolMember): void {
    if (stopped || member.status === 'disabled') return;
    if (member.restartTimer !== undefined) return; // 已排上重启（exited 与探测可能同批到达）
    member.spawn = undefined; // 作废旧 settleSpawn
    const link = member.link;
    member.link = undefined;
    link?.close();
    void unlinkStateFile(member.id);
    if (member.origin === 'external') {
      removeMember(member);
      logger.info('external pool engine exited (not supervised)', { id: member.id });
      void publish();
      return;
    }
    logger.warn('pool engine exited', { id: member.id, pid: member.pid, owned: member.owned });
    scheduleRespawn(member);
  }

  /** 滑动窗口预算（tools-engine/supervisor.ts 同口径）；预算尽 disabled，不静默补位。 */
  function scheduleRespawn(member: PoolMember): void {
    if (stopped || member.status === 'disabled') return;
    if (member.restartTimer !== undefined) return;
    const timestamp = now();
    member.restartTimestamps = member.restartTimestamps.filter(
      (ts) => timestamp - ts < restartWindowMs,
    );
    member.status = 'starting';
    member.port = 0;
    member.pid = 0;
    member.startedAt = 0;
    member.controlToken = '';
    member.dataToken = '';
    if (member.restartTimestamps.length >= maxRestarts) {
      member.status = 'disabled';
      logger.error('pool engine disabled after repeated failures (not replacing)', {
        id: member.id,
        restarts: member.restartTimestamps.length,
        windowMs: restartWindowMs,
      });
      void publish(); // routing 除名
      return;
    }
    member.restartTimestamps.push(timestamp);
    void publish(); // 死 engine 立即除名（starting 不入 routing）
    member.restartTimer = setTimeout(() => {
      member.restartTimer = undefined;
      if (stopped) return;
      void spawnEngine(member, true);
    }, restartDelayMs);
  }

  // ── spawn / 就绪 ───────────────────────────────────────────

  /**
   * detached spawn env：最小运行环境 allowlist（child.ts buildPluginEnv 同口径）+
   * 契约三变量。**不透传 VESSEL_DATA_DIR / gateway token / 其它 VESSEL_***（Q9：dirs 权威
   * 在 host 装配，经 data 连接 auth 帧下发，不进 engine 进程全局 env）。
   */
  function buildEngineEnv(id: string): Record<string, string> {
    const inherited = process.env;
    const env: Record<string, string> = {};
    const allow = [
      'PATH',
      'Path',
      'HOME',
      'USERPROFILE',
      'SystemRoot',
      'SYSTEMROOT',
      'SystemDrive',
      'windir',
      'TEMP',
      'TMP',
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'TZ',
      'NODE_ENV',
    ];
    for (const key of allow) {
      const value = inherited[key];
      if (value !== undefined) env[key] = value;
    }
    env.VESSEL_ENGINE_POOL_DIR = options.poolDir;
    env.VESSEL_ENGINE_ID = id;
    env.VESSEL_PLUGIN_CONFIG = JSON.stringify(options.settings ?? {});
    return env;
  }

  function blankMember(): PoolMember {
    return {
      id: '',
      port: 0,
      pid: 0,
      startedAt: 0,
      controlToken: '',
      dataToken: '',
      owned: true,
      origin: 'spawned',
      status: 'starting',
      restarts: 0,
      restartTimestamps: [],
      probing: false,
    };
  }

  /** detached spawn（不用 stdio 控制）；就绪结算后台跑，失败走预算路径。 */
  async function spawnEngine(member: PoolMember, isRespawn: boolean): Promise<void> {
    if (stopped) return;
    const id = `e-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    member.id = id;
    member.origin = 'spawned';
    member.owned = true;
    member.status = 'starting';
    member.port = 0;
    member.pid = 0;
    member.startedAt = 0;
    member.controlToken = '';
    member.dataToken = '';
    const oldLink = member.link;
    member.link = undefined;
    oldLink?.close();

    const logDir = path.join(logBaseDir, 'logs');
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      await mkdir(logDir, { recursive: true, mode: 0o700 });
      handle = await open(path.join(logDir, `engine-${id}.log`), 'a', 0o600);
    } catch (error) {
      logger.error('pool engine log open failed', { id, message: errorMessage(error) });
      scheduleRespawn(member);
      return;
    }

    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([process.execPath, options.entryPath], {
        cwd: options.rootDir,
        stdin: 'ignore',
        stdout: handle.fd,
        stderr: handle.fd,
        detached: true,
        env: buildEngineEnv(id),
      });
    } catch (error) {
      await handle.close().catch(() => undefined);
      logger.error('pool engine spawn failed', { id, message: errorMessage(error) });
      scheduleRespawn(member);
      return;
    }
    await handle.close().catch(() => undefined);
    child.unref?.();
    member.pid = child.pid;
    member.spawn = child;
    // 运行期 exit：只认当前 spawn（旧 child 迟到上报不触发重启）。
    void child.exited.then(() => {
      if (stopped || member.spawn !== child || member.status === 'disabled') return;
      handleExit(member);
    });
    void settleSpawn(member, child, isRespawn);
  }

  /** 就绪 = 状态文件（pid 匹配）+ 控制 hello/activate（port loopback 复核）→ ready + 发布。 */
  async function settleSpawn(
    member: PoolMember,
    child: ReturnType<typeof Bun.spawn>,
    isRespawn: boolean,
  ): Promise<void> {
    const deadline = now() + SPAWN_READY_TIMEOUT_MS;
    let state: EngineStateFile | undefined;
    while (!stopped && member.spawn === child && now() < deadline) {
      const candidate = await readStateFile(member.id);
      if (candidate !== undefined && candidate.pid === child.pid) {
        state = candidate;
        break;
      }
      await sleep(POLL_MS);
    }
    if (stopped || member.spawn !== child) return;
    if (state === undefined) {
      await failSpawn(member, child, 'state file not written before deadline');
      return;
    }
    member.port = state.port;
    member.startedAt = state.started_at;
    member.controlToken = state.control_token;
    member.dataToken = state.data_token;

    let link: ControlLink;
    try {
      link = await dialControl(state.port, state.control_token, AUTH_TIMEOUT_MS, () =>
        onLinkClosed(member),
      );
      if (stopped || member.spawn !== child) {
        link.close();
        return;
      }
      member.link = link;
      await link.request('plugin.hello', {}, HELLO_TIMEOUT_MS);
      const activated = await link.request('plugin.activate', {}, ACTIVATE_TIMEOUT_MS);
      // activate 自报 port（S19）；gateway loopback 复核（拨号本身即 127.0.0.1）。
      if (!isRecord(activated) || activated.ok !== true || activated.port !== state.port) {
        throw new Error('plugin.activate did not confirm the state-file port');
      }
    } catch (error) {
      if (stopped || member.spawn !== child) return;
      await failSpawn(member, child, `control handshake failed: ${errorMessage(error)}`);
      return;
    }
    if (stopped || member.spawn !== child) {
      link.close();
      return;
    }
    member.status = 'ready';
    if (isRespawn) member.restarts += 1;
    logger.info('pool engine ready', {
      id: member.id,
      port: member.port,
      pid: member.pid,
      restart: isRespawn,
    });
    void publish();
  }

  /** spawn 失败 / 就绪超时：终止本会话 spawn（归属明确），预算内 respawn，不留孤儿。 */
  async function failSpawn(
    member: PoolMember,
    child: ReturnType<typeof Bun.spawn>,
    reason: string,
  ): Promise<void> {
    logger.error('pool engine start failed', { id: member.id, pid: child.pid, reason });
    member.spawn = undefined;
    const link = member.link;
    member.link = undefined;
    link?.close();
    await killPid(child.pid, runCommand, now);
    await waitUntilDead(child.pid, KILL_CONFIRM_MS, now);
    await unlinkStateFile(member.id);
    scheduleRespawn(member);
  }

  /** 控制连接断 ≠ engine 死（detached，S19）；pid 死才走 exit 路径，否则探测重拨。 */
  function onLinkClosed(member: PoolMember): void {
    if (stopped || member.status === 'starting' || member.status === 'disabled') return;
    if (!isProcessAlive(member.pid)) handleExit(member);
  }

  // ── 探测 ───────────────────────────────────────────────────

  async function probe(member: PoolMember): Promise<void> {
    if (member.probing || stopped) return;
    if (member.status === 'starting' || member.status === 'disabled') return;
    member.probing = true;
    try {
      if (!isProcessAlive(member.pid)) {
        handleExit(member);
        return;
      }
      if (member.link === undefined || member.link.closed) {
        member.link = await dialControl(member.port, member.controlToken, AUTH_TIMEOUT_MS, () =>
          onLinkClosed(member),
        ).catch(() => undefined);
      }
      const link = member.link;
      if (link === undefined || link.closed) {
        markDraining(member, 'control_unreachable');
        return;
      }
      try {
        await link.request('ping', {}, PING_TIMEOUT_MS);
        markHealthy(member);
      } catch {
        markDraining(member, 'ping_timeout');
        await observeProgress(member, link);
      }
    } finally {
      member.probing = false;
    }
  }

  // ── start / stop ───────────────────────────────────────────

  async function doStart(): Promise<void> {
    await mkdir(enginesDir, { recursive: true, mode: 0o700 });
    epoch = randomUUID();
    revision = 0;
    const manifest = await readPreviousRoutingIds();
    const entries = await readdir(enginesDir).catch(() => [] as string[]);
    const discovered: PoolMember[] = [];
    await Promise.all(
      entries
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          const id = name.slice(0, -'.json'.length);
          const state = await readStateFile(id);
          if (state === undefined) {
            logger.warn('pool engine state file unreadable/invalid; left untouched', { id });
            return;
          }
          if (!isProcessAlive(state.pid) || isBeforeBoot(state.started_at)) {
            // pid 死（或 boot 前复用）→ 清状态文件；容量缺口由下方补位 spawn 填（预算内）。
            await unlinkStateFile(id);
            logger.info('pool engine state cleared (pid dead)', { id, pid: state.pid });
            return;
          }
          const origin: 'adopted' | 'external' = manifest.has(state.id) ? 'adopted' : 'external';
          const member: PoolMember = {
            id: state.id,
            port: state.port,
            pid: state.pid,
            startedAt: state.started_at,
            controlToken: state.control_token,
            dataToken: state.data_token,
            owned: false,
            origin,
            status: origin,
            restarts: 0,
            restartTimestamps: [],
            probing: false,
          };
          let link: ControlLink | undefined;
          try {
            link = await dialControl(state.port, state.control_token, AUTH_TIMEOUT_MS, () =>
              onLinkClosed(member),
            );
            await link.request('ping', {}, PING_TIMEOUT_MS);
            member.link = link;
          } catch {
            link?.close();
            member.status = 'draining';
            member.drainingSince = now();
            logger.warn('pool engine discovered but control ping failed (draining; never killed)', {
              id: state.id,
              origin,
            });
          }
          discovered.push(member);
        }),
    );
    memberList.push(...discovered);
    // one-for-one 容量：supervised = owned + adopted；external 不占池规模。
    const supervised = memberList.filter((m) => m.owned || m.origin === 'adopted').length;
    const deficit = Math.max(0, options.size - supervised);
    const spawns: Promise<void>[] = [];
    for (let i = 0; i < deficit; i += 1) {
      const member = blankMember();
      memberList.push(member);
      spawns.push(spawnEngine(member, false));
    }
    await Promise.all(spawns);
    await publish();
    probeTimer = setInterval(() => {
      for (const member of [...memberList]) void probe(member);
    }, probeIntervalMs);
    logger.info('pool supervisor started', {
      poolDir: options.poolDir,
      size: options.size,
      adopted: discovered.filter((m) => m.origin === 'adopted').length,
      external: discovered.filter((m) => m.origin === 'external').length,
      spawned: deficit,
    });
  }

  async function start(): Promise<void> {
    if (startPromise !== undefined) return startPromise;
    if (stopped) throw new Error('pool supervisor is stopped');
    started = true;
    startPromise = doStart();
    return startPromise;
  }

  /**
   * 终止 owned engine（adopt/external 永不杀）：归属复核（pid + started_at）→ 控制 deactivate
   * → 宽限等自死 → win32 taskkill /PID /T /F 兜底。先 routing 除名 owned（drain 信号）。
   */
  async function terminateMember(member: PoolMember): Promise<boolean> {
    const state = await readStateFile(member.id);
    let verified =
      state !== undefined &&
      state.pid === member.pid &&
      state.started_at === member.startedAt &&
      !isBeforeBoot(state.started_at);
    if (!verified && member.status === 'starting' && member.spawn !== undefined && member.pid > 0) {
      // 本会话 spawn 未就绪：尚无状态文件证据，但 pid 是本次 spawn（abandonSpawned 同口径）。
      verified = isProcessAlive(member.pid);
    }
    if (!verified) {
      logger.warn('pool engine terminate skipped: ownership unverified', {
        id: member.id,
        pid: member.pid,
      });
      return false;
    }
    const link = member.link;
    if (link !== undefined && !link.closed) {
      await link.request('plugin.deactivate', {}, DEACTIVATE_TIMEOUT_MS).catch(() => undefined);
    }
    if (await waitUntilDead(member.pid, STOP_GRACE_MS, now)) {
      await unlinkStateFile(member.id);
      link?.close();
      return true;
    }
    await killPid(member.pid, runCommand, now);
    const dead = await waitUntilDead(member.pid, KILL_CONFIRM_MS, now);
    await unlinkStateFile(member.id);
    link?.close();
    return dead;
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (probeTimer !== undefined) {
      clearInterval(probeTimer);
      probeTimer = undefined;
    }
    for (const member of memberList) {
      if (member.restartTimer !== undefined) {
        clearTimeout(member.restartTimer);
        member.restartTimer = undefined;
      }
    }
    if (!started) return;
    await publish(); // owned 除名（routingIncluded 在 stopped 时排除 owned）
    const owned = memberList.filter((m) => m.owned);
    const results = await Promise.all(
      owned.map(async (member) => ({ member, dead: await terminateMember(member) })),
    );
    for (const { member, dead } of results) {
      if (dead) removeMember(member);
    }
    for (const member of memberList) member.link?.close();
    logger.info('pool supervisor stopped', { terminated: results.filter((r) => r.dead).length });
  }

  function members(): readonly PoolMemberView[] {
    return memberList.map((member) => ({
      id: member.id,
      port: member.port,
      status: member.status,
      restarts: member.restarts,
      owned: member.owned,
    }));
  }

  return { start, stop, members };
}
