/**
 * 本地 Node 子进程监督（0.49 G3b / CONTRACT-0.49-node-g3 §4）。
 *
 * - Platform Gateway 不再跑 node runtime；每个 `auto_start` 本地 node 一个子进程
 *   （argv=`node start [--config <path>]`，env 带 `VESSEL_DATA_DIR=<data_dir>`）；
 * - 子进程写自己 dataDir 的 `gateway.pid` / `gateway-default.lock`，平台写
 *   `platform.pid` / `platform-<instance>.lock`，两族文件不交叉；
 * - 启动前已有健康 node → adopt/external，不重复 spawn；
 * - 只终止本 Gateway spawn 的子进程；adopt/external 永不杀；
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
import { atomicWrite } from '@vessel-agent/core';
import { buildDaemonArgv } from './daemon';
import {
  type CommandRunner,
  createCommandRunner,
  DEFAULT_GATEWAY_INSTANCE,
  isProcessAlive,
  normalizeGatewayInstance,
  readGatewayPidRecord,
} from './pid';

const DEFAULT_READINESS_TIMEOUT_MS = 20_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const POLL_MS = 100;
const HEALTH_TIMEOUT_MS = 1_000;
const ADOPT_WAIT_MS = 2_000;
const MANIFEST_VERSION = 1;

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

export type SupervisedNodeState = 'up' | 'down' | 'external' | 'unknown';

export interface SupervisedNodeInfo {
  nodeId: string;
  name: string;
  dataDir: string;
  state: SupervisedNodeState;
  pid?: number;
  spawned: boolean;
}

export type NodeSupervisorStartResult =
  | { ok: true }
  | { ok: false; code: string; message: string; node?: string };

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
}

/** Manifest 中的一条：只记录本平台 spawn 的子进程。 */
export interface SpawnedChildRecord {
  node_id: string;
  name: string;
  pid: number;
  data_dir: string;
  started_at: string;
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
    const { node_id, name, pid, data_dir, started_at } = entry;
    if (typeof node_id !== 'string' || node_id === '') continue;
    if (typeof name !== 'string' || name === '') continue;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue;
    if (typeof data_dir !== 'string' || data_dir === '') continue;
    if (typeof started_at !== 'string') continue;
    out.push({ node_id, name, pid, data_dir, started_at });
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
): Promise<{ status: number; body?: unknown }> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
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
 */
async function terminateChild(
  pid: number,
  options: {
    platform: NodeJS.Platform;
    runCommand: CommandRunner;
    sleep: (ms: number) => Promise<void>;
    timeoutMs: number;
  },
): Promise<boolean> {
  try {
    if (options.platform === 'win32') process.kill(pid);
    else process.kill(pid, 'SIGTERM');
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
}

export interface StopSpawnedChildrenResult {
  stopped: number;
  failed: number;
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
  for (const file of files) {
    const children = await readSpawnedChildren(options.gatewayDataDir, file.instance);
    const remaining: SpawnedChildRecord[] = [];
    for (const child of children) {
      // 已确认死亡/不再属于该 node 的条目直接丢弃；活着的才尝试终止。
      if (!(await recordOwnsPid(child))) continue;
      const ok =
        options.terminate !== undefined
          ? await options.terminate(child.pid)
          : await terminateChild(child.pid, { platform, runCommand, sleep, timeoutMs });
      if (ok) stopped += 1;
      else {
        // 未确认停止：保留 manifest 条目，供后续 `gateway stop` 重试。
        failed += 1;
        remaining.push(child);
      }
    }
    if (remaining.length === 0) {
      await removeSpawnedChildren(options.gatewayDataDir, file.instance).catch(() => undefined);
    } else {
      await writeSpawnedChildren(options.gatewayDataDir, file.instance, remaining).catch(
        () => undefined,
      );
    }
  }
  return { stopped, failed };
}

/** 平台进程内的子进程监督器。 */
export class NodeSupervisor {
  private readonly options: NodeSupervisorOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: CommandRunner;
  private spawned: SpawnedChildRecord[] = [];
  private readonly infos = new Map<string, SupervisedNodeInfo>();

  constructor(options: NodeSupervisorOptions) {
    this.options = options;
    this.sleep = options.sleep ?? sleepDefault;
    this.platform = options.platform ?? process.platform;
    this.runCommand = options.runCommand ?? createCommandRunner(3_000);
  }

  /** 当前监督视图（spawn/adopt 结果与运行期崩溃标记）。 */
  list(): SupervisedNodeInfo[] {
    return [...this.infos.values()];
  }

  /**
   * 按 registry 顺序启动 `auto_start` 节点；任一失败 → 回滚本进程已 spawn 的子进程
   * 并返回稳定错误码。运行期崩溃只标 down（由 `child.exited` 标记），不自动重启。
   */
  async start(specs: readonly LocalNodeSpec[]): Promise<NodeSupervisorStartResult> {
    for (const spec of specs) {
      if (!spec.autoStart) {
        this.infos.set(spec.nodeId, {
          nodeId: spec.nodeId,
          name: spec.name,
          dataDir: spec.dataDir,
          state: 'unknown',
          spawned: false,
        });
        continue;
      }
      const existing = await this.adoptOrSpawn(spec);
      if (!existing.ok) {
        await this.stop();
        return existing;
      }
    }
    return { ok: true };
  }

  private async adoptOrSpawn(spec: LocalNodeSpec): Promise<NodeSupervisorStartResult> {
    const existing = await readGatewayPidRecord(spec.dataDir);
    if (existing !== null && isProcessAlive(existing.pid)) {
      if (existing.node_id !== undefined && existing.node_id !== spec.nodeId) {
        return {
          ok: false,
          code: 'node_identity_mismatch',
          node: spec.name,
          message: `node "${spec.name}": ${path.join(spec.dataDir, 'gateway.pid')} belongs to another node_id`,
        };
      }
      const health = await this.waitForHealth(spec, ADOPT_WAIT_MS);
      if (!health.ok) {
        return {
          ok: false,
          code: 'node_unreachable',
          node: spec.name,
          message: `node "${spec.name}" already has a live process (pid ${existing.pid}) but is not healthy`,
        };
      }
      if (health.nodeId !== undefined && health.nodeId !== spec.nodeId) {
        return {
          ok: false,
          code: 'node_identity_mismatch',
          node: spec.name,
          message: `node "${spec.name}" health reports node_id ${health.nodeId}`,
        };
      }
      this.infos.set(spec.nodeId, {
        nodeId: spec.nodeId,
        name: spec.name,
        dataDir: spec.dataDir,
        state: 'external',
        pid: existing.pid,
        spawned: false,
      });
      return { ok: true };
    }
    return this.spawn(spec);
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

  private async spawn(spec: LocalNodeSpec): Promise<NodeSupervisorStartResult> {
    const execPath = this.options.execPath ?? process.execPath;
    const entryPath = this.options.entryPath ?? process.argv[1];
    if (entryPath === undefined || entryPath === '') {
      return {
        ok: false,
        code: 'node_start_failed',
        node: spec.name,
        message: 'cannot resolve the vessel entry script (process.argv[1] is empty)',
      };
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
      return {
        ok: false,
        code: 'node_start_failed',
        node: spec.name,
        message: `node "${spec.name}": cannot open log ${logPath}: ${
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
          VESSEL_DATA_DIR: spec.dataDir,
          ...(this.options.platformOrigins !== undefined && this.options.platformOrigins.length > 0
            ? { VESSEL_PLATFORM_ORIGINS: this.options.platformOrigins.join(',') }
            : {}),
        },
      });
    } catch (error) {
      await handle.close().catch(() => undefined);
      return {
        ok: false,
        code: 'node_start_failed',
        node: spec.name,
        message: `node "${spec.name}" failed to spawn: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    await handle.close().catch(() => undefined);
    child.unref?.();

    const pid = child.pid;
    this.infos.set(spec.nodeId, {
      nodeId: spec.nodeId,
      name: spec.name,
      dataDir: spec.dataDir,
      state: 'down',
      pid,
      spawned: true,
    });
    // 就绪前只存在于本进程内存（started_at 未知，不能做 §4.7 归属复核）；
    // readiness 成功后才写 manifest。启动失败由本进程 stop() 回滚。
    const manifestEntry: SpawnedChildRecord = {
      node_id: spec.nodeId,
      name: spec.name,
      pid,
      data_dir: spec.dataDir,
      started_at: '',
    };
    this.spawned.push(manifestEntry);
    // 运行期崩溃：只标 down，不重启（G3 不自动重启）。
    void child.exited.then(() => {
      const info = this.infos.get(spec.nodeId);
      if (info !== undefined) info.state = 'down';
    });

    const ready = await this.waitForReady(spec, pid);
    if (!ready.ok) return ready;

    const record = await readGatewayPidRecord(spec.dataDir);
    if (record === null) {
      return {
        ok: false,
        code: 'node_start_failed',
        node: spec.name,
        message: `node "${spec.name}" did not write ${path.join(spec.dataDir, 'gateway.pid')}`,
      };
    }
    manifestEntry.started_at = record.started_at;
    await this.writeManifest();
    const info = this.infos.get(spec.nodeId);
    if (info !== undefined) info.state = 'up';
    return { ok: true };
  }

  private async waitForReady(spec: LocalNodeSpec, pid: number): Promise<NodeSupervisorStartResult> {
    const timeoutMs = this.options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        return {
          ok: false,
          code: 'node_start_failed',
          node: spec.name,
          message: `node "${spec.name}" exited during startup`,
        };
      }
      const record = await readGatewayPidRecord(spec.dataDir);
      if (record !== null && record.pid === pid) {
        if (record.node_id !== undefined && record.node_id !== spec.nodeId) {
          return {
            ok: false,
            code: 'node_identity_mismatch',
            node: spec.name,
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
              node: spec.name,
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
      node: spec.name,
      message: `node "${spec.name}" was not ready within ${timeoutMs}ms`,
    };
  }

  private async writeManifest(): Promise<void> {
    await writeSpawnedChildren(this.options.gatewayDataDir, this.options.instance, this.spawned);
  }

  /** 停止本监督器 spawn 的子进程（rollback / SIGTERM）；adopt/external 不动。 */
  async stop(): Promise<StopSpawnedChildrenResult> {
    const timeoutMs = this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    let stopped = 0;
    let failed = 0;
    const remaining: SpawnedChildRecord[] = [];
    await Promise.all(
      this.spawned.map(async (child) => {
        // 就绪前条目（started_at 空）只在本进程内存中，按 pid 活性回滚；
        // 已就绪条目按 §4.7 三重归属复核。不匹配/已死亡 → 丢弃该条。
        const owns =
          child.started_at === '' ? isProcessAlive(child.pid) : await recordOwnsPid(child);
        if (!owns) return;
        const ok =
          this.options.terminate !== undefined
            ? await this.options.terminate(child.pid)
            : await terminateChild(child.pid, {
                platform: this.platform,
                runCommand: this.runCommand,
                sleep: this.sleep,
                timeoutMs,
              });
        if (ok) stopped += 1;
        else {
          failed += 1;
          remaining.push(child);
        }
        const info = this.infos.get(child.node_id);
        if (info !== undefined) info.state = ok ? 'down' : info.state;
      }),
    );
    this.spawned = remaining;
    if (remaining.length === 0) {
      await removeSpawnedChildren(this.options.gatewayDataDir, this.options.instance).catch(
        () => undefined,
      );
    } else {
      await this.writeManifest().catch(() => undefined);
    }
    return { stopped, failed };
  }
}
