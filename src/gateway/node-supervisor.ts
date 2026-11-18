/**
 * 本地 Node 子进程监督（0.49 G3b / CONTRACT-0.49-node-g3 §4）。
 *
 * - Platform Gateway 不再跑 node runtime；每个 `auto_start` 本地 node 一个子进程
 *   （argv=`node start [--config <path>]`，env 带 `VESSEL_DATA_DIR=<data_dir>`）；
 * - 子进程写自己 dataDir 的 `gateway.pid` / `gateway-default.lock`，平台写
 *   `platform.pid` / `platform-<instance>.lock`，两族文件不交叉；
 * - 启动前已有健康 node → adopt/external，不重复 spawn；
 * - 只终止本 Gateway spawn 的子进程；adopt/external 永不杀；
 * - **0.55 分段启动**：`begin()` 只做「adopt 判定 + spawn」（毫秒级、不等就绪），
 *   平台据此立刻监听；`settle()` 在后台并发等待就绪。每个节点是独立状态机
 *   （`starting` / `ready` / `failed` / `adopted` / `external`），一个节点慢、
 *   起不来或崩溃**只标它自己**（状态 + 原因 + 时刻），不回滚平台、不阻塞别人；
 * - Windows 无 POSIX 信号语义：`process.kill(pid)` 后 `taskkill /PID <pid> /T /F`
 *   兜底；`gateway stop`（另一进程）通过平台写下的 runtime manifest 找到这些
 *   PID，逐条复核 `gateway.pid` 归属后才终止。
 *
 * Manifest 是运行时状态（不是 registry、不含 token），平台退出时删除。
 *
 * @module vessel/gateway/node-supervisor
 */

import { mkdir, open, readdir, readFile, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, withDeadline } from '@vessel-agent/core';
import { readHubLockFile } from '../hub/runtime';
import { buildDaemonArgv } from './daemon';
import {
  type CommandRunner,
  createCommandRunner,
  DEFAULT_GATEWAY_INSTANCE,
  isBeforeBoot,
  isProcessAlive,
  normalizeGatewayInstance,
  readGatewayPidRecord,
} from './pid';
import {
  DEFAULT_STALL_WATCHDOG_CONFIG,
  NodeWatchdog,
  type StallWatchdogConfig,
  type WatchdogEvent,
  type WatchdogSnapshot,
  writeWatchdogSnapshot,
} from './watchdog';

/**
 * 单个 node/hub 的就绪上界（0.55）。
 *
 * 上界理由：实测冷启动（首次解压插件 + 建 WAL 尾部索引）通常 < 5s，20s 曾把
 * 慢机器上的正常节点判死；这里按 5s 的 36 倍留余量，覆盖慢磁盘 + 大 registry。
 * 超时**只**把该节点标 `failed`（原因带毫秒数），平台照常 ready；超过 3 分钟
 * 仍拿不到 `/health` 基本可判定为卡死，可由 `gateway restart` 显式重来。
 */
const DEFAULT_READINESS_TIMEOUT_MS = 180_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const POLL_MS = 100;
const HEALTH_TIMEOUT_MS = 1_000;
const ADOPT_WAIT_MS = 2_000;
const MANIFEST_VERSION = 1;
/** 0.58：看门狗快照的最小落盘间隔（事件/相位变化不受限）。 */
const WATCHDOG_STATE_WRITE_MIN_MS = 5_000;

/** 已解析的本地 node 运行参数（组合根从 registry + 各 node config 推导）。 */
export interface LocalNodeSpec {
  nodeId: string;
  name: string;
  dataDir: string;
  apiUrl: string;
  host: string;
  port: number;
  configPath?: string;
  /** 该 node 生效 token；只用于 readiness 探测，不写盘、不打印。 */
  token?: string;
  autoStart: boolean;
}

/** 0.50：gateway 自动拉起的本地 Hub 参数。 */
export interface LocalHubSpec {
  /** hub data dir（`hub.dataDir` 或 `<gatewayDataDir>/hub`）。 */
  dataDir: string;
}

export type HubSupervisorStartResult =
  | { ok: true; adopted: boolean; url: string }
  | { ok: false; code: string; message: string };

/** `beginHub` 结果：命中已有 Hub 可立刻给出 url；本进程 spawn 的就绪待 `settle`。 */
export type HubSupervisorBeginResult =
  | { ok: true; adopted: true; url: string }
  | { ok: true; adopted: false }
  | { ok: false; code: string; message: string };

/** `settle` 里 Hub 的最终结果（只出现在本进程 spawn 的 Hub 上）。 */
export type HubSupervisorSettleResult =
  | { ok: true; adopted: false; url: string }
  | { ok: false; code: string; message: string };

/**
 * 节点状态机（0.55 分段启动）。
 *
 * - `starting` 本进程已 spawn、或 dataDir 里已有活进程（adopt 候选），就绪未确认；
 * - `ready` 本进程 spawn 且已通过 `gateway.pid` + `/health` 校验；
 * - `failed` 该节点当前不可用：spawn 抛错、启动中退出、就绪超时、身份不符、已就绪
 *   后崩溃、或被本进程停止。**原因与时刻在 `reason` / `since`**，平台不受影响；
 * - `adopted` 未 spawn：已有健康进程接管，且本实例 manifest 里有它的归属记录
 *   （0.52 handoff 保活的子进程）；
 * - `external` 未 spawn：已有健康进程接管但不在 manifest（手工/外部启动，永不杀），
 *   或该节点 `auto_start: false`（本进程不管它的生命周期）。
 */
export type SupervisedNodeState = 'starting' | 'ready' | 'failed' | 'adopted' | 'external';

export interface SupervisedNodeInfo {
  nodeId: string;
  name: string;
  dataDir: string;
  state: SupervisedNodeState;
  pid?: number;
  spawned: boolean;
  /** 未就绪/不可用原因（`failed` 必有；`adopted`/`external` 说明来源）。不含 token。 */
  reason?: string;
  /** 进入当前状态的时刻（ISO 8601）。 */
  since: string;
  /** 从 `begin()` 到进入当前状态的毫秒数（`ready` 即该节点的启动耗时）。 */
  elapsedMs: number;
}

/** phase A 结果：只表示「adopt/spawn 判定已下发」，**不代表就绪**。 */
export interface NodeSupervisorBeginResult {
  /** 本阶段由本进程 spawn 的 node 子进程数。 */
  spawned: number;
  /** adopt 候选数（已有活进程，健康待 `settle` 确认）。 */
  adoptCandidates: number;
}

/** phase B 报告：每个节点的最终状态（失败只标该节点，不抛错、不回滚）。 */
export interface NodeSupervisorReport {
  nodes: SupervisedNodeInfo[];
  counts: Record<SupervisedNodeState, number>;
  /** 本进程 spawn 的 Hub 的最终结果；adopt/未起 Hub 时为 undefined。 */
  hub?: HubSupervisorSettleResult;
}

export interface NodeSupervisorOptions {
  /** 平台 dataDir；node 日志与 manifest 写在这里。 */
  gatewayDataDir: string;
  instance?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  execPath?: string;
  entryPath?: string;
  spawn?: typeof Bun.spawn;
  sleep?: (ms: number) => Promise<void>;
  runCommand?: CommandRunner;
  readinessTimeoutMs?: number;
  stopTimeoutMs?: number;
  /**
   * 平台页面 Origin 列表（0.50）。只注入本平台 spawn 的本地 Node 子进程
   * （`VESSEL_PLATFORM_ORIGINS`），让 node 的 `serve.allowed_origins` 自动放行
   * 平台 WebUI 的跨源请求；adopt/external 节点不受影响。
   */
  platformOrigins?: readonly string[];
  /** 测试 seam：覆盖单进程终止；返回 false 表示未确认停止（manifest 保留）。 */
  terminate?: (pid: number) => Promise<boolean>;
  /**
   * 0.55：节点状态迁移观察者（每次变化一次，含失败原因与耗时）。I/O 由调用方
   * 决定（结构日志行 / banner），监督器本身不打印、不落盘——不新增状态实体。
   * 观察者抛错不影响状态机。
   */
  onNodeState?: (info: SupervisedNodeInfo) => void;
  /**
   * 0.58：父进程侧存活看门狗的生效配置（由组合根从 `gateway.supervise` 解析）。
   * 缺省 = 缺省配置（开启）。关掉时**不建**任何看门狗：不探活、不重启。
   */
  supervise?: StallWatchdogConfig;
  /**
   * 0.58：看门狗事件（探活判定 / 重启 / 放弃 / 恢复）。与 `onNodeState` 分开：
   * 那是状态机，这是外部看护的动作记录（一行一条结构日志）。抛错不影响判定。
   */
  onWatchdogEvent?: (event: WatchdogEvent) => void;
}

/** Manifest 中的一条：只记录本平台 spawn 的子进程。 */
export interface SpawnedChildRecord {
  node_id: string;
  name: string;
  pid: number;
  data_dir: string;
  started_at: string;
  /** 0.50：`hub` = gateway 自动拉起的本地 Hub；缺省 = node。 */
  kind?: 'node' | 'hub';
}

interface Manifest {
  v: typeof MANIFEST_VERSION;
  children: SpawnedChildRecord[];
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/**
 * 节点缺席时的「怎么起」提示（0.55）。
 *
 * `auto_start: false` 的节点不由 gateway 拉起；缺席时不能只留一个空状态，
 * 要把可复制的命令写在原因里（显式 registry 带 `--config`，隐式单节点不用）。
 */
function nodeStartHint(spec: Pick<LocalNodeSpec, 'configPath'>): string {
  return spec.configPath !== undefined
    ? `vessel node start --daemon --config ${spec.configPath}`
    : 'vessel node start --daemon';
}

/** `<gatewayDataDir>/logs/node-<name>.log`（0600）；名字里的路径分隔符归一为 `_`。 */
export function nodeLogPath(gatewayDataDir: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'node';
  return path.join(gatewayDataDir, 'logs', `node-${safe}.log`);
}

/** 平台 spawn 的子进程 manifest 路径（按实例隔离）。 */
export function spawnedChildrenPath(gatewayDataDir: string, instance?: string): string {
  const name = normalizeGatewayInstance(instance);
  return path.join(
    gatewayDataDir,
    name === DEFAULT_GATEWAY_INSTANCE ? 'platform-children.json' : `platform-children-${name}.json`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseManifest(raw: unknown): SpawnedChildRecord[] {
  if (!isRecord(raw) || raw.v !== MANIFEST_VERSION || !Array.isArray(raw.children)) return [];
  const out: SpawnedChildRecord[] = [];
  for (const entry of raw.children) {
    if (!isRecord(entry)) continue;
    const { node_id, name, pid, data_dir, started_at, kind } = entry;
    if (typeof node_id !== 'string' || node_id === '') continue;
    if (typeof name !== 'string' || name === '') continue;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue;
    if (typeof data_dir !== 'string' || data_dir === '') continue;
    if (typeof started_at !== 'string') continue;
    if (kind !== undefined && kind !== 'node' && kind !== 'hub') continue;
    out.push({ node_id, name, pid, data_dir, started_at, ...(kind !== undefined ? { kind } : {}) });
  }
  return out;
}

/** 读 manifest；缺失/损坏返回空（运行时状态，不阻断 stop）。 */
export async function readSpawnedChildren(
  gatewayDataDir: string,
  instance?: string,
): Promise<SpawnedChildRecord[]> {
  try {
    const raw = await readFile(spawnedChildrenPath(gatewayDataDir, instance), 'utf8');
    return parseManifest(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

async function writeSpawnedChildren(
  gatewayDataDir: string,
  instance: string | undefined,
  children: SpawnedChildRecord[],
): Promise<void> {
  const body: Manifest = { v: MANIFEST_VERSION, children };
  await atomicWrite(
    spawnedChildrenPath(gatewayDataDir, instance),
    `${JSON.stringify(body, null, 2)}\n`,
    {
      mode: 0o600,
      ensureDir: true,
    },
  );
}

async function removeSpawnedChildren(gatewayDataDir: string, instance?: string): Promise<void> {
  try {
    await unlink(spawnedChildrenPath(gatewayDataDir, instance));
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
}

interface HealthProbeResult {
  ok: boolean;
  nodeId?: string;
  role?: string;
}

async function fetchHealthJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<{ status: number; body?: unknown }> {
  try {
    // 0.64：node 启动探活是一条「只被一次挂起的 await 等待」的路径 —— 用会真正触发的
    // 截止时间，别让 `vessel gateway start` 卡在等 node 健康检查上。
    const response = await withDeadline(timeoutMs, async (signal) =>
      fetch(url, { method: 'GET', headers, signal }),
    );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { status: response.status, ...(body !== undefined ? { body } : {}) };
  } catch {
    return { status: 0 };
  }
}

/**
 * 存活看门狗的探活（0.58）：只问「主线程还在不在跑事件循环」。
 *
 * 为什么单打 `/health`：这个僵死形态的特征就是主线程停摆 —— `/health` 超时是
 * 最灵敏的外部信号（`docs/dev/research/run-start-stall.md` §2）。**不**回退到
 * `/v1/health`，也**不**解析 body：一次探活只花一份超时预算，超时即失败。
 * `/health` 在 node 上一律开放（不需要 token），探活因此不依赖任何凭据。
 */
export async function probeNodeLiveness(
  spec: { apiUrl: string; token?: string },
  timeoutMs: number,
): Promise<boolean> {
  const base = spec.apiUrl.endsWith('/') ? spec.apiUrl : `${spec.apiUrl}/`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (spec.token !== undefined && spec.token !== '') {
    headers.authorization = `Bearer ${spec.token}`;
  }
  const response = await fetchHealthJson(`${base}health`, headers, timeoutMs);
  if (response.status < 200 || response.status >= 300) return false;
  return isRecord(response.body) ? response.body.status === 'ok' : false;
}

/** Hub `/health` 预检（回环对端免 token；无 Origin 头，不受 CORS 白名单限制）。 */
async function probeHubHealth(url: string): Promise<boolean> {
  const base = url.endsWith('/') ? url : `${url}/`;
  const response = await fetchHealthJson(`${base}health`, { accept: 'application/json' });
  return (
    response.status >= 200 &&
    response.status < 300 &&
    isRecord(response.body) &&
    response.body.ok === true
  );
}

/**
 * 探测 node 健康。`/v1/health` 带 node 身份（loopback 免 token；远程需该 node
 * token）；老监听或平台监听回退 `/health`。
 */
export async function probeNodeHealth(spec: {
  apiUrl: string;
  token?: string;
}): Promise<HealthProbeResult> {
  const base = spec.apiUrl.endsWith('/') ? spec.apiUrl : `${spec.apiUrl}/`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (spec.token !== undefined && spec.token !== '') {
    headers.authorization = `Bearer ${spec.token}`;
  }

  const read = (body: unknown): HealthProbeResult => {
    if (!isRecord(body) || body.status !== 'ok') return { ok: false };
    const role = typeof body.role === 'string' ? body.role : undefined;
    const node = isRecord(body.node) ? body.node : undefined;
    const nodeId = typeof node?.node_id === 'string' ? node.node_id : undefined;
    return {
      ok: role !== 'platform',
      ...(nodeId !== undefined ? { nodeId } : {}),
      ...(role !== undefined ? { role } : {}),
    };
  };

  const v1 = await fetchHealthJson(`${base}v1/health`, headers);
  if (v1.status >= 200 && v1.status < 300 && isRecord(v1.body)) {
    const result = read(v1.body);
    // /v1/health 已明确给出 role / node 信息；非 2xx 时才回退。
    return result;
  }
  const plain = await fetchHealthJson(`${base}health`, headers);
  if (plain.status >= 200 && plain.status < 300) return read(plain.body);
  return { ok: false };
}

/**
 * 复核 manifest 条目仍是该 node 进程（CONTRACT §4.7 FROZEN r4）。
 *
 * `pid + started_at + node_id` 任一不符 / 记录缺失 = 不是我们的进程
 * （pid 复用、重启或记录已变）：**不杀**，调用方随后清理该条。
 */
async function recordOwnsPid(record: SpawnedChildRecord): Promise<boolean> {
  if (record.started_at === '') return false;
  if (!isProcessAlive(record.pid)) return false;
  // 0.50：Hub 的归属证据是 `<hubDataDir>/hub.lock`（pid + started_at），
  // 不是 node 的 `gateway.pid`；手工/外部启动的 Hub 不在 manifest，天然不杀。
  if (record.kind === 'hub') {
    const lock = await readHubLockFile(record.data_dir);
    return (
      lock !== null &&
      lock.pid === record.pid &&
      String(lock.started_at) === record.started_at &&
      !isBeforeBoot(lock.started_at)
    );
  }
  const pidRecord = await readGatewayPidRecord(record.data_dir);
  if (pidRecord === null) return false;
  if (pidRecord.pid !== record.pid) return false;
  if (pidRecord.started_at !== record.started_at) return false;
  if (pidRecord.node_id !== undefined && pidRecord.node_id !== record.node_id) return false;
  return true;
}

async function waitUntilDead(
  pid: number,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(POLL_MS);
  }
  return !isProcessAlive(pid);
}

/**
 * 终止一个子进程。POSIX `SIGTERM`；Windows `process.kill` 后
 * `taskkill /PID <pid> /T /F` 兜底（不做按端口/进程名的批量杀）。
 *
 * 0.58：`force: true` = 僵死路径 —— 主线程停摆的进程收不到、也不会处理 SIGTERM，
 * 所以 POSIX 直接 `SIGKILL`（Windows 上 `process.kill` 本身就是强制终止）。
 */
async function terminateChild(
  pid: number,
  options: {
    platform: NodeJS.Platform;
    runCommand: CommandRunner;
    sleep: (ms: number) => Promise<void>;
    timeoutMs: number;
    force?: boolean;
  },
): Promise<boolean> {
  try {
    if (options.platform === 'win32') process.kill(pid);
    else process.kill(pid, options.force === true ? 'SIGKILL' : 'SIGTERM');
  } catch (error) {
    if (!isErrno(error, 'ESRCH')) return false;
    return true;
  }

  if (options.platform === 'win32') {
    // process.kill 已发出终止；短暂等待后用 taskkill 兜底整棵子树。
    if (await waitUntilDead(pid, 500, options.sleep)) return true;
    await options.runCommand(['taskkill', '/PID', String(pid), '/T', '/F']);
  }
  return waitUntilDead(pid, options.timeoutMs, options.sleep);
}

export interface StopSpawnedChildrenOptions {
  gatewayDataDir: string;
  instance?: string;
  /** true = 扫描该 dataDir 下所有实例的 manifest（`gateway stop --all`/无选择器）。 */
  allInstances?: boolean;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  runCommand?: CommandRunner;
  /** 测试 seam：覆盖单进程终止；返回 false 表示未确认停止（manifest 保留）。 */
  terminate?: (pid: number) => Promise<boolean>;
  /**
   * handoff：只**清点**活着的子进程，一个都不终止，manifest 也原样留在盘上，
   * 交给新平台按既有 adopt 判据接管（见 `src/gateway/handoff.ts`）。
   */
  keep?: boolean;
  /**
   * 0.55：只终止 `started_at` **不早于**该 epoch 毫秒的条目——即「本次启动才
   * spawn 的」。daemon 启动失败的回滚用它，避免把上一代就活着（本次 adopt 回来）
   * 的 node/hub 一起杀掉。缺省 undefined = 不过滤（整体关闭要停全部）。
   */
  startedSince?: number;
}

/** manifest 条目的启动时刻（node 写 ISO 8601；hub lock 写 epoch 毫秒字符串）。 */
function startedAtMs(record: SpawnedChildRecord): number | undefined {
  if (record.started_at === '') return undefined;
  const iso = Date.parse(record.started_at);
  if (!Number.isNaN(iso)) return iso;
  const epoch = Number(record.started_at);
  return Number.isFinite(epoch) && epoch > 0 ? epoch : undefined;
}

/** handoff 保活的子进程计数（按 kind 分开，便于日志说清「保留了谁」）。 */
export interface KeptChildren {
  nodes: number;
  hubs: number;
}

/** 停机可核（0.55）：被终止/未被终止的一个子进程（不含 token）。 */
export interface StoppedChildDetail {
  name: string;
  kind: 'node' | 'hub';
  pid: number;
  /** 仅在未确认终止时出现：为什么没停下来（manifest 条目已保留供重试）。 */
  reason?: string;
}

export interface StopSpawnedChildrenResult {
  stopped: number;
  failed: number;
  /** 仅在 `keep: true` 时返回：被**有意保留**的子进程。 */
  kept?: KeptChildren;
  /** 仅在 `keep` 不为真时返回：逐条终止结果（`gateway stop --no-keep-nodes` 输出用）。 */
  stoppedChildren?: StoppedChildDetail[];
  failedChildren?: StoppedChildDetail[];
}

/**
 * `gateway stop` 的另一进程路径：只终止本平台写进 manifest 的子进程。
 * 逐条复核 `gateway.pid` 归属（pid/started_at/node_id），adopt/external 不在
 * manifest，天然不受影响。
 */
export async function stopSpawnedChildren(
  options: StopSpawnedChildrenOptions,
): Promise<StopSpawnedChildrenResult> {
  const platform = options.platform ?? process.platform;
  const sleep = options.sleep ?? sleepDefault;
  const runCommand = options.runCommand ?? createCommandRunner(3_000);
  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const files: Array<{ instance?: string }> = [];

  if (options.allInstances === true) {
    const names = await readdir(options.gatewayDataDir).catch(() => [] as string[]);
    for (const name of names) {
      if (name === 'platform-children.json') files.push({});
      else if (name.startsWith('platform-children-') && name.endsWith('.json')) {
        files.push({ instance: name.slice('platform-children-'.length, -'.json'.length) });
      }
    }
  } else {
    files.push(options.instance !== undefined ? { instance: options.instance } : {});
  }

  let stopped = 0;
  let failed = 0;
  let keptNodes = 0;
  let keptHubs = 0;
  const stoppedChildren: StoppedChildDetail[] = [];
  const failedChildren: StoppedChildDetail[] = [];
  for (const file of files) {
    const children = await readSpawnedChildren(options.gatewayDataDir, file.instance);
    const remaining: SpawnedChildRecord[] = [];
    for (const child of children) {
      // 已确认死亡/不再属于该 node 的条目直接丢弃；活着的才尝试终止。
      if (!(await recordOwnsPid(child))) continue;
      if (options.keep === true) {
        // handoff：不终止、不重写 manifest（条目仍准确描述活着的进程，
        // 后续真停/下一次交接还能据此找到它们）。
        if (child.kind === 'hub') keptHubs += 1;
        else keptNodes += 1;
        continue;
      }
      const startedAt = startedAtMs(child);
      if (
        options.startedSince !== undefined &&
        startedAt !== undefined &&
        startedAt < options.startedSince
      ) {
        // 本次启动之前就在跑的（adopt 来的）：不是这次的 spawn，不动，条目留着。
        remaining.push(child);
        continue;
      }
      const ok =
        options.terminate !== undefined
          ? await options.terminate(child.pid)
          : await terminateChild(child.pid, { platform, runCommand, sleep, timeoutMs });
      const kind: 'node' | 'hub' = child.kind === 'hub' ? 'hub' : 'node';
      if (ok) {
        stopped += 1;
        stoppedChildren.push({ name: child.name, kind, pid: child.pid });
      } else {
        // 未确认停止：保留 manifest 条目，供后续 `gateway stop` 重试。
        failed += 1;
        remaining.push(child);
        failedChildren.push({
          name: child.name,
          kind,
          pid: child.pid,
          reason: `not confirmed stopped within ${timeoutMs}ms`,
        });
      }
    }
    if (options.keep === true) continue;
    if (remaining.length === 0) {
      await removeSpawnedChildren(options.gatewayDataDir, file.instance).catch(() => undefined);
    } else {
      await writeSpawnedChildren(options.gatewayDataDir, file.instance, remaining).catch(
        () => undefined,
      );
    }
  }
  if (options.keep === true) {
    return { stopped, failed, kept: { nodes: keptNodes, hubs: keptHubs } };
  }
  return { stopped, failed, stoppedChildren, failedChildren };
}

/** phase A 下发、phase B 待确认的一个节点（本进程内存，不落盘）。 */
interface PendingNode {
  spec: LocalNodeSpec;
  pid: number;
  /** true = 本进程 spawn 的子进程；false = 已有活进程（adopt 候选，不重复 spawn）。 */
  spawned: boolean;
  /** 本进程 spawn 的子进程 manifest 条目（就绪后才写盘）。 */
  manifestEntry?: SpawnedChildRecord;
}

/** phase A 下发、phase B 待确认的 Hub（同上，只有一个）。 */
interface PendingHub {
  dataDir: string;
  pid: number;
  manifestEntry: SpawnedChildRecord;
  result?: HubSupervisorSettleResult;
}

/** 平台进程内的子进程监督器。 */
export class NodeSupervisor {
  private readonly options: NodeSupervisorOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: CommandRunner;
  private spawned: SpawnedChildRecord[] = [];
  private readonly infos = new Map<string, SupervisedNodeInfo>();
  /** 每个节点 `begin()` 的时刻（`elapsedMs` 基准）。 */
  private readonly beginAt = new Map<string, number>();
  private pending: PendingNode[] = [];
  private hubPending: PendingHub | undefined;
  private settlePromise: Promise<NodeSupervisorReport> | undefined;
  /** manifest 写入串行化：并发就绪的节点不能互相覆盖对方条目。 */
  private manifestWrites: Promise<void> = Promise.resolve();
  /**
   * 上一代 gateway 留在盘上、本进程**没有** spawn 的子进程条目（handoff 保活、
   * 本次走 adopt 的 node/hub）。写 manifest 时必须原样带着它们，否则一个新节点
   * 失败就会把还在跑的 node/hub 从盘上抹掉，`gateway stop --no-keep-nodes` 之后
   * 再也找不到它们（孤儿）。
   */
  private carried: SpawnedChildRecord[] = [];
  /** 已开始停止：就绪轮询立即收尾，不再刷状态事件。 */
  private stopping = false;
  /** 0.58：每个节点一条存活看门狗（只覆盖本进程 spawn / adopt 的节点）。 */
  private readonly watchdogs = new Map<string, NodeWatchdog>();
  /** 0.58：正在「强杀 + 重起」的节点（其 `exited` 回调不许记成崩溃）。 */
  private readonly restarting = new Set<string>();
  /** 0.58：已进入关停流程 —— 看门狗**绝不许**在这个窗口里重启任何子进程。 */
  private noRestart = false;
  private readonly superviseConfig: StallWatchdogConfig;
  /** 看门狗快照落盘的串行化（`gateway status` 是另一个进程，只能靠这个文件）。 */
  private watchdogWrites: Promise<void> = Promise.resolve();
  /** 落盘节流：探活每 2s 一次，但文件没必要每 2s 重写一遍。 */
  private lastWatchdogWriteAt = 0;

  constructor(options: NodeSupervisorOptions) {
    this.options = options;
    this.sleep = options.sleep ?? sleepDefault;
    this.platform = options.platform ?? process.platform;
    this.runCommand = options.runCommand ?? createCommandRunner(3_000);
    this.superviseConfig = options.supervise ?? DEFAULT_STALL_WATCHDOG_CONFIG;
  }

  /** 当前监督视图（每个节点的状态机快照，顺序与 `begin()` 的 registry 顺序一致）。 */
  list(): SupervisedNodeInfo[] {
    return [...this.infos.values()];
  }

  /** 0.58：存活看门狗的当前快照（落盘 + `gateway status`；不含 token）。 */
  watchdogSnapshot(): WatchdogSnapshot {
    return {
      v: 1,
      updated_at: new Date(Date.now()).toISOString(),
      config: this.superviseConfig,
      nodes: [...this.watchdogs.values()].map((watchdog) => watchdog.snapshot()),
    };
  }

  /**
   * 把看门狗快照写到 `<dataDir>/platform-watchdog[-<instance>].json`。
   *
   * 关掉看门狗时也写（`nodes: []` + `config.enabled: false`）：`gateway status`
   * 必须能回答「为什么这里没有重启计数」，而不是留一行空白让人猜。
   *
   * 节流（2s 探活 ≠ 2s 一次盘写）：事件与相位变化走 `force`，其余最多 5s 一次；
   * 显示的是「最近一次探活」，5s 的粒度不影响判定与排障。
   */
  private publishWatchdogState(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastWatchdogWriteAt < WATCHDOG_STATE_WRITE_MIN_MS) return;
    this.lastWatchdogWriteAt = now;
    const snapshot = this.watchdogSnapshot();
    const { gatewayDataDir, instance } = this.options;
    this.watchdogWrites = this.watchdogWrites
      .then(() => writeWatchdogSnapshot(gatewayDataDir, instance, snapshot))
      .catch(() => undefined);
  }

  /**
   * 0.58：给一个「本进程负责的」节点起看门狗（`ready` / `adopted` 之后调用）。
   *
   * 只覆盖本进程 spawn 或从 manifest 接管的节点；`external`（手工/外部启动）
   * 永不探活、永不重启 —— 那不是我们的进程。
   */
  private startWatchdog(spec: LocalNodeSpec, pid: number): void {
    if (!this.superviseConfig.enabled) return;
    if (this.watchdogs.has(spec.nodeId)) return;
    const watchdog = new NodeWatchdog({
      nodeId: spec.nodeId,
      name: spec.name,
      pid,
      config: this.superviseConfig,
      probe: () =>
        probeNodeLiveness(
          {
            apiUrl: spec.apiUrl,
            ...(spec.token !== undefined ? { token: spec.token } : {}),
          },
          this.superviseConfig.probeTimeoutMs,
        ),
      // 正常关停 / 子进程已退出 / 节点不是 ready|adopted → 不探活（走正常退出路径）。
      paused: () => {
        if (this.noRestart) return true;
        const info = this.infos.get(spec.nodeId);
        return info === undefined || (info.state !== 'ready' && info.state !== 'adopted');
      },
      onEvent: (event) => {
        try {
          this.options.onWatchdogEvent?.(event);
        } catch {
          // 日志通道异常不影响判定。
        }
        // 事件必须立刻落盘（时间线证据不能被节流吃掉）。
        this.publishWatchdogState(true);
      },
      onChange: () => this.publishWatchdogState(),
      restart: () => this.restartStalledNode(spec),
    });
    this.watchdogs.set(spec.nodeId, watchdog);
    watchdog.start();
    this.publishWatchdogState(true);
  }

  /**
   * 停止所有看门狗（`stop()` 起手第一件事：正常关停期间绝不许探活/重启）。
   *
   * 保留 map 里的对象（只是 `stop()` 了）：快照要能继续回答「停之前最近一次
   * 探活成功是什么时候、重启过几次」——诊断信息不随关停一起消失。
   */
  private stopWatchdogs(): void {
    this.noRestart = true;
    for (const watchdog of this.watchdogs.values()) watchdog.stop();
    this.publishWatchdogState(true);
  }

  /**
   * 0.58 僵死处置：强杀 → 重新 spawn → 等就绪 → 更新 manifest / 状态机。
   *
   * 安全闸门（顺序即优先级）：
   * 1. 本进程已在停止 → 不动手（正常关停走 `stop()`）；
   * 2. `gateway.pid` 归属复核：记录已被别的 pid 改写 = 不是我们僵死的那个进程 → 不杀；
   * 3. 进程已经不在了 → 不杀，直接按「重新 spawn」走（退出路径本来也不需要探活）。
   *
   * 失败不抛：看门狗据此记一条 `supervisor.stall_restart_failed`，节点转 `failed`
   * （原因写清），随后**不再**探活 —— 起不来的节点不是「僵死」，重试只会把日志刷爆；
   * 由人工 `vessel gateway restart` 或下一单排查接手。
   */
  private async restartStalledNode(
    spec: LocalNodeSpec,
  ): Promise<{ ok: true; pid: number } | { ok: false; error: string }> {
    if (this.stopping || this.noRestart) return { ok: false, error: 'gateway is stopping' };
    const info = this.infos.get(spec.nodeId);
    const oldPid = info?.pid;
    if (oldPid === undefined) return { ok: false, error: 'node has no pid to restart' };

    this.restarting.add(spec.nodeId);
    try {
      const record = await readGatewayPidRecord(spec.dataDir).catch(() => null);
      if (record !== null && record.pid !== oldPid) {
        return {
          ok: false,
          error:
            `pid record mismatch: ${path.join(spec.dataDir, 'gateway.pid')} now points at ` +
            `${record.pid}, not the stalled ${oldPid}`,
        };
      }
      if (isProcessAlive(oldPid)) {
        const killed = await this.terminatePid(oldPid, true);
        if (!killed) return { ok: false, error: `could not terminate stalled pid ${oldPid}` };
      }
      // 旧条目（已死）先摘掉，避免 manifest 里留一条指向死 pid 的记录。
      this.spawned = this.spawned.filter(
        (child) => !(child.node_id === spec.nodeId && child.pid === oldPid),
      );
      await this.writeManifest().catch(() => undefined);
      if (this.stopping || this.noRestart) return { ok: false, error: 'gateway is stopping' };

      const entry = await this.spawnOnly(spec);
      if (entry === null) return { ok: false, error: `respawn of node "${spec.name}" failed` };
      // 重启后 `elapsedMs` 从这一刻算：否则日志会拿「平台启动到现在」冒充「重启耗时」。
      this.beginAt.set(spec.nodeId, Date.now());
      this.setState(spec, 'starting', { spawned: true, pid: entry.pid });
      // 新 pid 的 `exited` 回调此时已经登记：把 pid 与状态机对齐，重启不算崩溃。
      const ready = await this.waitForReady(spec, entry.pid);
      if (!ready.ok) {
        await this.abandonSpawned(
          { spec, pid: entry.pid, spawned: true, manifestEntry: entry },
          `${ready.code}: ${ready.message}`,
        );
        return { ok: false, error: `${ready.code}: ${ready.message}` };
      }
      const startedRecord = await readGatewayPidRecord(spec.dataDir).catch(() => null);
      if (startedRecord === null) {
        await this.abandonSpawned(
          { spec, pid: entry.pid, spawned: true, manifestEntry: entry },
          `node_start_failed: node "${spec.name}" did not write ${path.join(spec.dataDir, 'gateway.pid')}`,
        );
        return { ok: false, error: 'node did not write its pid record after restart' };
      }
      entry.started_at = startedRecord.started_at;
      await this.writeManifest();
      this.setState(spec, 'ready', { spawned: true, pid: entry.pid });
      return { ok: true, pid: entry.pid };
    } finally {
      this.restarting.delete(spec.nodeId);
    }
  }

  /** 写一条状态（`elapsedMs`/`since` 在此计算；状态变化才通知观察者）。 */
  private setState(
    target: { nodeId: string; name: string; dataDir: string },
    state: SupervisedNodeState,
    extra: { pid?: number; spawned?: boolean; reason?: string } = {},
  ): SupervisedNodeInfo {
    const previous = this.infos.get(target.nodeId);
    const now = Date.now();
    const startedAt = this.beginAt.get(target.nodeId) ?? now;
    const pid = extra.pid ?? previous?.pid;
    const spawned = extra.spawned ?? previous?.spawned ?? false;
    const info: SupervisedNodeInfo = {
      nodeId: target.nodeId,
      name: target.name,
      dataDir: target.dataDir,
      state,
      spawned,
      since: new Date(now).toISOString(),
      elapsedMs: Math.max(0, now - startedAt),
      ...(pid !== undefined ? { pid } : {}),
      ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    };
    this.infos.set(target.nodeId, info);
    // 首次登记（`previous === undefined`）不通知：调用方从 `list()`/banner 已能看到
    // 初始 `starting`，日志只记「结果」（ready/failed/adopted/external/崩溃）。
    if (previous !== undefined && !this.stopping) {
      try {
        this.options.onNodeState?.(info);
      } catch {
        // 观察者（日志）异常不影响状态机。
      }
    }
    return info;
  }

  /**
   * phase A（0.55 分段启动）：按 registry 顺序登记状态，然后**并发**给每个
   * `auto_start` 节点做 adopt/spawn 判定。只做文件读 + `spawn` 系统调用，
   * **不等就绪、不做健康探测**，所以平台可以在毫秒级继续监听（监听仍必须在
   * spawn 之后，见 gateway-command 的 0.52 句柄继承注释）。
   *
   * 单个节点在这一阶段失败（spawn 抛错、dataDir 里是别的 node_id）只把它标
   * `failed` 并带上原因，不影响其它节点，也不回滚平台。
   */
  async begin(specs: readonly LocalNodeSpec[]): Promise<NodeSupervisorBeginResult> {
    this.pending = [];
    // 盘上已有条目的子进程是上一代 gateway 留下的（本次可能 adopt 回来）：
    // 写 manifest 时要把它们一起带回去，别因为一个新节点失败就把它们抹掉。
    this.carried = await readSpawnedChildren(
      this.options.gatewayDataDir,
      this.options.instance,
    ).catch(() => []);
    for (const spec of specs) {
      this.beginAt.set(spec.nodeId, Date.now());
      if (!spec.autoStart) {
        // 不由本进程管生命周期：不 spawn。缺席时必须给出「怎么起」而不是留空。
        this.setState(spec, 'external', {
          spawned: false,
          reason: `auto_start: false — start it with: ${nodeStartHint(spec)}`,
        });
      }
    }
    await Promise.all(
      specs.map(async (spec) => {
        if (!spec.autoStart) {
          // 只读一次 pid 文件：区分「已经在跑」和「缺席」，两种都仍是 external。
          const record = await readGatewayPidRecord(spec.dataDir).catch(() => null);
          if (record === null || !isProcessAlive(record.pid)) return;
          this.setState(spec, 'external', {
            spawned: false,
            pid: record.pid,
            reason: `auto_start: false; already running outside this gateway (pid ${record.pid})`,
          });
          return;
        }
        this.setState(spec, 'starting', { spawned: false });
        await this.claim(spec);
      }),
    );
    const spawned = this.pending.filter((entry) => entry.spawned).length;
    // 0.58：先把看门狗快照落一次（即使关掉也要落：状态页要看得出「关」）。
    this.publishWatchdogState(true);
    return { spawned, adoptCandidates: this.pending.length - spawned };
  }

  /** phase A 的单节点判定：已有活进程 → adopt 候选；否则 spawn。 */
  private async claim(spec: LocalNodeSpec): Promise<void> {
    const existing = await readGatewayPidRecord(spec.dataDir);
    if (existing !== null && isProcessAlive(existing.pid)) {
      if (existing.node_id !== undefined && existing.node_id !== spec.nodeId) {
        // 不 spawn（会抢端口）、也不杀（不是我们的进程）。
        this.setState(spec, 'failed', {
          spawned: false,
          pid: existing.pid,
          reason:
            `node_identity_mismatch: node "${spec.name}": ` +
            `${path.join(spec.dataDir, 'gateway.pid')} belongs to another node_id`,
        });
        return;
      }
      // 已有健康 node 不重复 spawn；健康确认挪到 phase B（不拖住平台启动）。
      this.setState(spec, 'starting', { spawned: false, pid: existing.pid });
      this.pending.push({ spec, pid: existing.pid, spawned: false });
      return;
    }
    const manifestEntry = await this.spawnOnly(spec);
    if (manifestEntry === null) return;
    this.setState(spec, 'starting', { spawned: true, pid: manifestEntry.pid });
    this.pending.push({ spec, pid: manifestEntry.pid, spawned: true, manifestEntry });
  }

  /**
   * phase B：等待所有节点（以及本进程 spawn 的 Hub）就绪。**并发**等待，慢节点
   * 不拖住快节点；任何失败只标记该节点，不抛错、不回滚平台。幂等（重复调用复用
   * 同一次等待）。
   */
  async settle(): Promise<NodeSupervisorReport> {
    if (this.settlePromise === undefined) this.settlePromise = this.runSettle();
    return this.settlePromise;
  }

  private async runSettle(): Promise<NodeSupervisorReport> {
    const pending = this.pending;
    const hub = this.hubPending;
    await Promise.all([
      ...pending.map((entry) =>
        entry.spawned ? this.finishSpawned(entry) : this.finishAdopt(entry),
      ),
      ...(hub !== undefined ? [this.finishHub(hub)] : []),
    ]);
    const nodes = this.list();
    const counts: Record<SupervisedNodeState, number> = {
      starting: 0,
      ready: 0,
      failed: 0,
      adopted: 0,
      external: 0,
    };
    for (const info of nodes) counts[info.state] += 1;
    return { nodes, counts, ...(hub?.result !== undefined ? { hub: hub.result } : {}) };
  }

  /** 本进程 spawn 的节点：等 `gateway.pid` + `/health`；失败只标该节点。 */
  private async finishSpawned(entry: PendingNode): Promise<void> {
    const { spec } = entry;
    const ready = await this.waitForReady(spec, entry.pid);
    if (!ready.ok) {
      // 本进程正在停止：不算节点失败，也不去杀（stop() 已经在收）。
      if (ready.code === 'stopped') return;
      await this.abandonSpawned(entry, `${ready.code}: ${ready.message}`);
      return;
    }
    const record = await readGatewayPidRecord(spec.dataDir);
    if (record === null) {
      await this.abandonSpawned(
        entry,
        `node_start_failed: node "${spec.name}" did not write ${path.join(spec.dataDir, 'gateway.pid')}`,
      );
      return;
    }
    if (entry.manifestEntry !== undefined) entry.manifestEntry.started_at = record.started_at;
    await this.writeManifest();
    this.setState(spec, 'ready', { spawned: true, pid: entry.pid });
    // 0.58：就绪之后才开始探活（启动期的慢不算僵死）。
    this.startWatchdog(spec, entry.pid);
  }

  /** adopt 候选：确认健康后定 `adopted`（manifest 有记录）/ `external`（外部启动）。 */
  private async finishAdopt(entry: PendingNode): Promise<void> {
    const { spec } = entry;
    const health = await this.waitForHealth(spec, ADOPT_WAIT_MS);
    if (this.stopping) return;
    if (!health.ok) {
      // 已有活进程但不健康：不重复 spawn（会抢端口）、也不杀（不是我们的进程）。
      this.setState(spec, 'failed', {
        spawned: false,
        pid: entry.pid,
        reason:
          `node_unreachable: node "${spec.name}" already has a live process ` +
          `(pid ${entry.pid}) but is not healthy`,
      });
      return;
    }
    if (health.nodeId !== undefined && health.nodeId !== spec.nodeId) {
      this.setState(spec, 'failed', {
        spawned: false,
        pid: entry.pid,
        reason: `node_identity_mismatch: node "${spec.name}" health reports node_id ${health.nodeId}`,
      });
      return;
    }
    const adopted = await this.inThisManifest(spec.nodeId, entry.pid);
    this.setState(spec, adopted ? 'adopted' : 'external', {
      spawned: false,
      pid: entry.pid,
      reason: adopted
        ? 'taken over from a previous gateway (handoff, in this manifest)'
        : 'started outside this gateway',
    });
    // 0.58：`adopted` 是本进程接管的子进程（manifest 里有记录），僵死时由本进程强杀重起；
    // `external` 是别人起的，永不探活、永不重启。
    if (adopted) this.startWatchdog(spec, entry.pid);
  }

  /** 该 pid 是否本实例 manifest 里的条目（只用于区分 `adopted` / `external` 显示）。 */
  private async inThisManifest(nodeId: string, pid: number): Promise<boolean> {
    try {
      const children = await readSpawnedChildren(
        this.options.gatewayDataDir,
        this.options.instance,
      );
      return children.some(
        (child) => child.kind !== 'hub' && child.node_id === nodeId && child.pid === pid,
      );
    } catch {
      return false;
    }
  }

  private async waitForHealth(spec: LocalNodeSpec, timeoutMs: number): Promise<HealthProbeResult> {
    const deadline = Date.now() + timeoutMs;
    let last: HealthProbeResult = { ok: false };
    while (Date.now() < deadline) {
      last = await probeNodeHealth({
        apiUrl: spec.apiUrl,
        ...(spec.token !== undefined ? { token: spec.token } : {}),
      });
      if (last.ok) return last;
      await this.sleep(POLL_MS);
    }
    return last;
  }

  /**
   * 0.50：gateway start 自动拉起本地 Hub。
   *
   * - 已有活 Hub（`hub.lock` pid 存活且非 boot 前记录）→ adopt：不 spawn、不记
   *   manifest，外部/手工实例永不被 `gateway stop` 杀；
   * - 否则 spawn `vessel hub start --data-dir <hubDataDir>`，等 `hub.lock` 归本
   *   child 且 `/health` 通过后写入与 node 共用的 manifest（`kind:'hub'`）；
   * - 失败只返回错误，由调用方 warning，不阻断 gateway。
   *
   * 0.55：拆成 `beginHub()`（adopt 命中立刻给 url；spawn 成功立即返回，**不等就绪**）
   * + `settle()` 里的就绪等待，Hub 慢启动不再拖住平台 ready。
   */
  async beginHub(spec: LocalHubSpec): Promise<HubSupervisorBeginResult> {
    const existing = await readHubLockFile(spec.dataDir);
    if (existing !== null && isProcessAlive(existing.pid) && !isBeforeBoot(existing.started_at)) {
      return { ok: true, adopted: true, url: existing.url ?? '' };
    }

    const execPath = this.options.execPath ?? process.execPath;
    const entryPath = this.options.entryPath ?? process.argv[1];
    if (entryPath === undefined || entryPath === '') {
      return {
        ok: false,
        code: 'hub_start_failed',
        message: 'cannot resolve the vessel entry script (process.argv[1] is empty)',
      };
    }

    // 不给 Hub 子进程设 VESSEL_DATA_DIR：它必须用 `hub.dataDir` / `<dataDir>/hub`，
    // 与 gateway 的 dataDir 区分，否则会触发 `hub_data_dir_conflict`。
    const argv = [execPath, entryPath, 'hub', 'start', '--data-dir', spec.dataDir];
    const logPath = nodeLogPath(this.options.gatewayDataDir, 'hub');
    await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(logPath, 'a', 0o600);
    } catch (error) {
      return {
        ok: false,
        code: 'hub_start_failed',
        message: `hub: cannot open log ${logPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    const spawn = this.options.spawn ?? Bun.spawn;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv, {
        stdin: 'ignore',
        stdout: handle.fd,
        stderr: handle.fd,
        detached: true,
        env: {
          ...(this.options.env ?? process.env),
          ...(this.options.platformOrigins !== undefined && this.options.platformOrigins.length > 0
            ? { VESSEL_PLATFORM_ORIGINS: this.options.platformOrigins.join(',') }
            : {}),
        },
      });
    } catch (error) {
      await handle.close().catch(() => undefined);
      return {
        ok: false,
        code: 'hub_start_failed',
        message: `hub failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    await handle.close().catch(() => undefined);
    child.unref?.();

    const pid = child.pid;
    // 就绪前只存在于本进程内存（started_at 未知，不能做归属复核）；
    // 就绪后才写 manifest，失败由本进程按 pid 终止（`gateway stop` 找不到它）。
    const record: SpawnedChildRecord = {
      node_id: 'hub',
      name: 'hub',
      pid,
      data_dir: spec.dataDir,
      started_at: '',
      kind: 'hub',
    };
    this.spawned.push(record);
    this.hubPending = { dataDir: spec.dataDir, pid, manifestEntry: record };
    return { ok: true, adopted: false };
  }

  /** 兼容入口：`beginHub()` + 等就绪（阻塞版；0.55 起平台走分段启动，不用它）。 */
  async startHub(spec: LocalHubSpec): Promise<HubSupervisorStartResult> {
    const begun = await this.beginHub(spec);
    if (!begun.ok) return begun;
    if (begun.adopted) return { ok: true, adopted: true, url: begun.url };
    const pending = this.hubPending;
    if (pending === undefined) {
      return { ok: false, code: 'hub_start_failed', message: 'hub was not spawned' };
    }
    await this.finishHub(pending);
    return (
      pending.result ?? { ok: false, code: 'hub_start_failed', message: 'hub result is unknown' }
    );
  }

  /** phase B：等本进程 spawn 的 Hub 就绪；失败只报告，不回滚、不影响节点。 */
  private async finishHub(pending: PendingHub): Promise<void> {
    const ready = await this.waitForHubReady(pending.dataDir, pending.pid);
    if (!ready.ok) {
      // 本进程 spawn 的 Hub 没起来：尽力终止自己的子进程，避免孤儿。
      const stopped = await this.terminatePid(pending.pid);
      if (stopped) this.spawned = this.spawned.filter((child) => child !== pending.manifestEntry);
      await this.writeManifest().catch(() => undefined);
      pending.result = ready;
      return;
    }
    pending.manifestEntry.started_at = ready.startedAt;
    await this.writeManifest();
    pending.result = { ok: true, adopted: false, url: ready.url };
  }

  private async waitForHubReady(
    dataDir: string,
    pid: number,
  ): Promise<
    { ok: true; startedAt: string; url: string } | { ok: false; code: string; message: string }
  > {
    const timeoutMs = this.options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        return { ok: false, code: 'hub_start_failed', message: 'hub exited during startup' };
      }
      const lock = await readHubLockFile(dataDir);
      if (lock !== null && lock.pid === pid && lock.url !== undefined) {
        if (await probeHubHealth(lock.url)) {
          return { ok: true, startedAt: String(lock.started_at), url: lock.url };
        }
      }
      await this.sleep(POLL_MS);
    }
    return {
      ok: false,
      code: 'hub_start_failed',
      message: `hub was not ready within ${timeoutMs}ms`,
    };
  }

  /**
   * phase A 的 spawn 部分：只把子进程拉起来并登记 manifest 条目（`started_at`
   * 留空，就绪后才落盘），**不等就绪**。失败返回 null 并把该节点标 `failed`。
   */
  private async spawnOnly(spec: LocalNodeSpec): Promise<SpawnedChildRecord | null> {
    const fail = (code: string, message: string): null => {
      this.setState(spec, 'failed', { spawned: false, reason: `${code}: ${message}` });
      return null;
    };
    const execPath = this.options.execPath ?? process.execPath;
    const entryPath = this.options.entryPath ?? process.argv[1];
    if (entryPath === undefined || entryPath === '') {
      return fail(
        'node_start_failed',
        `node "${spec.name}": cannot resolve the vessel entry script (process.argv[1] is empty)`,
      );
    }

    const argv = buildDaemonArgv({
      execPath,
      entryPath,
      command: 'node',
      ...(spec.configPath !== undefined ? { configPath: spec.configPath } : {}),
    });
    const logPath = nodeLogPath(this.options.gatewayDataDir, spec.name);
    await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(logPath, 'a', 0o600);
    } catch (error) {
      return fail(
        'node_start_failed',
        `node "${spec.name}": cannot open log ${logPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const spawn = this.options.spawn ?? Bun.spawn;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv, {
        stdin: 'ignore',
        stdout: handle.fd,
        stderr: handle.fd,
        detached: true,
        env: {
          ...(this.options.env ?? process.env),
          VESSEL_DATA_DIR: spec.dataDir,
          // 0.56：把该 node 的**生效 token**（显式或派生）注入子进程环境。
          // node 侧「显式 > VESSEL_NODE_TOKEN > 现算派生」——所以独立启动的 node
          // 不需要任何 token 配置，被 gateway 拉起的 node 更是零配置且值一致。
          ...(spec.token !== undefined && spec.token !== ''
            ? { VESSEL_NODE_TOKEN: spec.token }
            : {}),
          ...(this.options.platformOrigins !== undefined && this.options.platformOrigins.length > 0
            ? { VESSEL_PLATFORM_ORIGINS: this.options.platformOrigins.join(',') }
            : {}),
        },
      });
    } catch (error) {
      await handle.close().catch(() => undefined);
      return fail(
        'node_start_failed',
        `node "${spec.name}" failed to spawn: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await handle.close().catch(() => undefined);
    child.unref?.();

    const pid = child.pid;
    // 就绪前只存在于本进程内存（started_at 未知，不能做 §4.7 归属复核）；
    // readiness 成功后才写 manifest，失败由 `abandonSpawned()` 按 pid 终止。
    const manifestEntry: SpawnedChildRecord = {
      node_id: spec.nodeId,
      name: spec.name,
      pid,
      data_dir: spec.dataDir,
      started_at: '',
    };
    this.spawned.push(manifestEntry);
    // 运行期崩溃：只标 failed + 原因，不重启（G3 不自动重启）。
    void child.exited.then(() => {
      const info = this.infos.get(spec.nodeId);
      if (info === undefined || info.state !== 'ready') return;
      if (this.stopping) return;
      // 0.58：pid 必须还是这条子进程的 —— 僵死重启之后状态机已经换了 pid，
      // 旧子进程的退出不能把刚起来的新进程记成 `failed`。
      if (info.pid !== pid) return;
      // 0.58：正在「强杀 + 重起」时退出是预期动作，不是崩溃（不记假事件）。
      if (this.restarting.has(spec.nodeId)) return;
      this.setState(spec, 'failed', { spawned: true, pid, reason: `node exited (pid ${pid})` });
    });
    return manifestEntry;
  }

  /**
   * 本进程 spawn 的节点没就绪：先记下归属证据（子进程若已写 `gateway.pid`），
   * 再尽力终止**自己的**子进程。终止不掉就把条目留在 manifest 里由 `gateway stop`
   * 重试——不留孤儿，也不因为一个节点拖垮整个平台。
   */
  private async abandonSpawned(entry: PendingNode, reason: string): Promise<void> {
    const { spec } = entry;
    const manifestEntry = entry.manifestEntry;
    const record = await readGatewayPidRecord(spec.dataDir).catch(() => null);
    if (record !== null && record.pid === entry.pid && manifestEntry !== undefined) {
      manifestEntry.started_at = record.started_at;
    }
    const stopped = await this.terminatePid(entry.pid);
    if (stopped && manifestEntry !== undefined) {
      this.spawned = this.spawned.filter((child) => child !== manifestEntry);
    }
    await this.writeManifest().catch(() => undefined);
    if (this.stopping) return;
    this.setState(spec, 'failed', { spawned: true, pid: entry.pid, reason });
  }

  private async terminatePid(pid: number, force = false): Promise<boolean> {
    if (this.options.terminate !== undefined) return this.options.terminate(pid);
    return terminateChild(pid, {
      platform: this.platform,
      runCommand: this.runCommand,
      sleep: this.sleep,
      timeoutMs: this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      ...(force ? { force: true } : {}),
    });
  }

  private async waitForReady(
    spec: LocalNodeSpec,
    pid: number,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const timeoutMs = this.options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // 本进程已在停止：别把「我们自己停了」写成节点失败。
      if (this.stopping) {
        return { ok: false, code: 'stopped', message: 'gateway is stopping' };
      }
      if (!isProcessAlive(pid)) {
        return {
          ok: false,
          code: 'node_start_failed',
          message: `node "${spec.name}" exited during startup`,
        };
      }
      const record = await readGatewayPidRecord(spec.dataDir);
      if (record !== null && record.pid === pid) {
        if (record.node_id !== undefined && record.node_id !== spec.nodeId) {
          return {
            ok: false,
            code: 'node_identity_mismatch',
            message: `node "${spec.name}" wrote node_id ${record.node_id}`,
          };
        }
        const health = await probeNodeHealth({
          apiUrl: spec.apiUrl,
          ...(spec.token !== undefined ? { token: spec.token } : {}),
        });
        if (health.ok) {
          if (health.nodeId !== undefined && health.nodeId !== spec.nodeId) {
            return {
              ok: false,
              code: 'node_identity_mismatch',
              message: `node "${spec.name}" health reports node_id ${health.nodeId}`,
            };
          }
          return { ok: true };
        }
      }
      await this.sleep(POLL_MS);
    }
    return {
      ok: false,
      code: 'node_start_failed',
      message: `node "${spec.name}" was not ready within ${timeoutMs}ms`,
    };
  }

  /**
   * 写 manifest（**只写已有 `started_at` 的条目**）。
   *
   * 并发就绪时，未就绪的兄弟条目 `started_at` 还是空——它没有归属证据，落盘只会
   * 让 `gateway stop`（另一进程）复核失败、把活子进程当孤儿漏掉。写入串行化，
   * 否则两个并发就绪的节点会互相覆盖对方的条目。
   */
  private writeManifest(): Promise<void> {
    const own = this.spawned.filter((child) => child.started_at !== '');
    return this.enqueueManifestWrite(own).catch(() => undefined);
  }

  private enqueueManifestWrite(own: SpawnedChildRecord[]): Promise<void> {
    this.manifestWrites = this.manifestWrites.then(async () => {
      // 合并盘上**仍活着、且本进程没有重新 spawn** 的条目：adopt 来的 node/hub
      // 不在 `this.spawned` 里，但它们属于上一代 gateway 的 manifest（`gateway stop
      //  --no-keep-nodes` 要能按它找到进程）。死条目顺手丢掉，避免跨代累积。
      const ownIds = new Set(own.map((child) => child.node_id));
      const carried = this.carried.filter(
        (child) => !ownIds.has(child.node_id) && isProcessAlive(child.pid),
      );
      const body = [...carried, ...own];
      if (body.length === 0) {
        await removeSpawnedChildren(this.options.gatewayDataDir, this.options.instance);
        return;
      }
      await writeSpawnedChildren(this.options.gatewayDataDir, this.options.instance, body);
    });
    return this.manifestWrites;
  }

  /**
   * 停止本监督器 spawn 的子进程（rollback / SIGTERM）；adopt/external 不动。
   *
   * `keep: true` = handoff（`gateway restart` 与 `gateway stop` 缺省）：**已就绪**的
   * 子进程一个都不终止，也不动内存/清单，留给新平台按 adopt 判据接管。
   * 例外：还没就绪（`started_at` 空）的子进程既没有归属证据、也还没接管端口，
   * 留着只会变成「没人认识、下次启动还可能撞端口」的孤儿 —— 这种情况下终止它。
   */
  async stop(options?: { keep?: boolean }): Promise<StopSpawnedChildrenResult> {
    const keep = options?.keep === true;
    let stopped = 0;
    let failed = 0;
    let keptNodes = 0;
    let keptHubs = 0;
    const remaining: SpawnedChildRecord[] = [];
    const stoppedChildren: StoppedChildDetail[] = [];
    // 0.55：先置停止旗标——后台 `settle()` 里的就绪/健康轮询立即收尾，不再把
    // 「我们正在停」写成节点失败事件。
    // 0.58：看门狗**先停**（不论 keep）——正常关停期间绝不许探活/重启，
    // 否则 `gateway restart` 的交接会被自己的看门狗打断。
    this.stopWatchdogs();
    if (!keep) this.stopping = true;
    await Promise.all(
      this.spawned.map(async (child) => {
        // 就绪前条目（started_at 空）只在本进程内存中，按 pid 活性回滚；
        // 已就绪条目按 §4.7 三重归属复核。不匹配/已死亡 → 丢弃该条。
        const owns =
          child.started_at === '' ? isProcessAlive(child.pid) : await recordOwnsPid(child);
        if (!owns) return;
        if (keep && child.started_at !== '') {
          if (child.kind === 'hub') keptHubs += 1;
          else keptNodes += 1;
          return;
        }
        // keep 路径下走到这里 = 还没就绪的子进程：没有归属证据、也还没接管端口，
        // 留着只会变孤儿（下次启动还可能撞端口），所以照样终止。
        const ok = await this.terminatePid(child.pid);
        const kind: 'node' | 'hub' = child.kind === 'hub' ? 'hub' : 'node';
        if (ok) {
          stopped += 1;
          stoppedChildren.push({ name: child.name, kind, pid: child.pid });
        } else {
          failed += 1;
          remaining.push(child);
        }
        if (ok && child.kind !== 'hub') {
          // 本进程管理的子进程已停止：状态机记为不可用（原因写清是主动停的）。
          const info = this.infos.get(child.node_id);
          if (info !== undefined && info.state !== 'failed') {
            this.setState(
              { nodeId: info.nodeId, name: info.name, dataDir: info.dataDir },
              'failed',
              { spawned: info.spawned, pid: child.pid, reason: 'stopped by gateway' },
            );
          }
        }
      }),
    );
    if (keep) {
      // 内存与 manifest 都不动：留着的子进程仍然「属于本进程」，盘上条目也仍然准确。
      //  只可能来自「还没就绪就被终止」的那几个（见上面的例外）。
      return {
        stopped,
        failed,
        kept: { nodes: keptNodes, hubs: keptHubs },
        ...(stoppedChildren.length > 0 ? { stoppedChildren } : {}),
      };
    }
    this.spawned = remaining;
    // 停止路径要写回未终止的条目（含 started_at 空的），所以不过滤。
    await this.enqueueManifestWrite(remaining).catch(() => undefined);
    return { stopped, failed };
  }
}
