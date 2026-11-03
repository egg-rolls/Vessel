/**
 * `vessel gateway` 一次性子命令（0.12 DECISION-023 §2.1–§2.3）。
 *
 * 前台 `start` / `restart` 由 `cli.ts` 映射进现有 `--serve` 装配管线；
 * 这里处理：
 * - `start --daemon` / `restart --daemon`（分离子进程）；
 * - `stop` / `status` / `reload`；
 * - `install-service` / `uninstall-service`。
 *
 * 所有 Human 输出走 `ui`（非 TTY 自动无 ANSI）；`status --json` 只输出 JSON。
 *
 * @module vessel/gateway-command
 */

import * as path from 'node:path';
import { loadConfig, type VesselConfig } from '../packages/config/src/index';
import type { GatewayCommand, GatewayInstallTarget, GatewaySelector } from './cli-args';
import { type ControlPlaneTarget, resolveControlPlaneTarget } from './control-plane-target';
import { expandHome, resolveDataDir } from './data-paths';
import { gatewayLogPath, startGatewayDaemon } from './gateway/daemon';
import {
  acquireGatewayInstanceLock,
  type GatewayInstanceLock,
  GatewayInstanceLockedError,
} from './gateway/instance-lock';
import {
  type CommandRunner,
  cleanupGatewayStateEntry,
  collectGatewayState,
  createCommandRunner,
  DEFAULT_GATEWAY_INSTANCE,
  deleteRecordIfOwnedSync,
  type GatewayPidRecord,
  type GatewayStateEntry,
  type GatewayStateOwner,
  type GatewayStateSnapshot,
  gatewayPidPath,
  inspectProcess,
  isGatewayCommandLine,
  isProcessAlive,
  normalizeGatewayInstance,
  writeGatewayPid,
} from './gateway/pid';
import { gatewayBaseUrl, reloadGateway } from './gateway/reload';
import {
  installService,
  resolveServiceTarget,
  serviceStatus,
  uninstallService,
} from './gateway/service';
import { t } from './i18n';
import { resolveGatewayToken } from './transport-factory';
import { ui } from './ui-style';
import { readPackageVersion } from './version';
import { inspectWebDist, webDistWarning } from './web-dist';

/** 依赖注入（CLI 只用默认值；测试注入平台/路径/命令执行） */
export interface GatewayCommandDeps {
  dataDir?: string;
  config?: VesselConfig;
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  version?: string;
  now?: () => number;
  runCommand?: CommandRunner;
  spawn?: typeof Bun.spawn;
  sleep?: (ms: number) => Promise<void>;
  logPath?: string;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  /** 0.15 测试注入：`status --rpc` 直接使用该 RPC 目标 */
  rpcTarget?: ControlPlaneTarget;
  /** 0.15：daemon 子进程透传 `--exclusive` */
  exclusive?: boolean;
  /** 内部计数探针注入；缺省 collectGatewayState。 */
  collectState?: typeof collectGatewayState;
}

interface ResolvedContext {
  dataDir: string;
  config: VesselConfig;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  version: string;
}

async function resolveContext(deps: GatewayCommandDeps): Promise<ResolvedContext> {
  const config = deps.config ?? (await loadConfig()).config;
  const env = deps.env ?? process.env;
  return {
    dataDir: deps.dataDir ?? resolveDataDir(config, env),
    config,
    platform: deps.platform ?? process.platform,
    env,
    version: deps.version ?? readPackageVersion(),
  };
}

/** stop 的平台终止方式（Windows 没有 POSIX 信号语义） */
function terminateProcess(pid: number, platform: NodeJS.Platform): void {
  if (platform === 'win32') process.kill(pid);
  else process.kill(pid, 'SIGTERM');
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 解析启动实例：显式 instance > 显式 port（0 除外）> default（0.14） */
export function deriveGatewayInstance(instance?: string, port?: number): string {
  if (instance !== undefined) return normalizeGatewayInstance(instance);
  if (port !== undefined && port !== 0) return String(port);
  return DEFAULT_GATEWAY_INSTANCE;
}

/** `config.hub.dataDir` 分流时的 hub 目录；缺省交给 collect 用 `<dataDir>/hub`。 */
function configuredHubDataDir(config: VesselConfig): string | undefined {
  const configured = config.hub?.dataDir;
  return configured === undefined ? undefined : path.resolve(expandHome(configured));
}

/** 单一读入口：命令层统一从这里取状态快照。 */
async function collectStateFor(
  context: ResolvedContext,
  deps: Pick<GatewayCommandDeps, 'collectState'> = {},
): Promise<GatewayStateSnapshot> {
  const collect = deps.collectState ?? collectGatewayState;
  const token = resolveGatewayToken(context.config, context.env);
  const hubDataDir = configuredHubDataDir(context.config);
  return collect(context.dataDir, {
    ...(token !== undefined ? { token } : {}),
    ...(hubDataDir !== undefined ? { hubDataDir } : {}),
  });
}

function findStateEntry(
  entries: GatewayStateEntry[],
  instance: string,
): GatewayStateEntry | undefined {
  return entries.find((entry) => entry.instance === instance);
}

function entryPid(entry: GatewayStateEntry): number | undefined {
  return entry.record?.pid ?? entry.lock?.pid;
}

/** 进程仍被该记录占用（身份未确认也算占用，只是不可自动回收）。 */
function entryOccupied(entry: GatewayStateEntry): boolean {
  return entry.state === 'running' || entry.state === 'degraded' || entry.state === 'starting';
}

/** 选择器解析结果 */
export type GatewayTargetsResult =
  | { ok: true; entries: GatewayStateEntry[]; all: boolean }
  | { ok: false; error: string; code: 'multiple_instances' | 'invalid_selector' };

/**
 * 按 `--instance` / `--port` / `--all` 解析目标；无选择器时：
 * 0 个实例 → 空；1 个 → 该实例；≥2 个 → `multiple_instances`。
 *
 * 已收集的 entries 由调用方传入（单次扫描）；缺省时自行 collect。
 */
export async function resolveGatewayTargets(
  dataDir: string,
  selector: GatewaySelector,
  options: {
    entries?: GatewayStateEntry[];
    collectState?: typeof collectGatewayState;
    token?: string;
  } = {},
): Promise<GatewayTargetsResult> {
  const entries =
    options.entries ??
    (
      await (options.collectState ?? collectGatewayState)(dataDir, {
        ...(options.token !== undefined ? { token: options.token } : {}),
      })
    ).entries;

  if (selector.all === true) return { ok: true, entries, all: true };

  if (selector.instance !== undefined) {
    let instance: string;
    try {
      instance = normalizeGatewayInstance(selector.instance);
    } catch (error) {
      return { ok: false, error: errorMessage(error), code: 'invalid_selector' };
    }
    return {
      ok: true,
      entries: entries.filter((entry) => entry.instance === instance),
      all: false,
    };
  }

  if (selector.port !== undefined) {
    return {
      ok: true,
      entries: entries.filter((entry) => entry.record?.port === selector.port),
      all: false,
    };
  }

  if (entries.length >= 2) {
    return {
      ok: false,
      code: 'multiple_instances',
      error:
        `multiple_instances: ${entries.length} gateway instances found ` +
        `(${entries.map((entry) => entry.instance).join(', ')}). ` +
        'Select one with --instance, --port, or --all.',
    };
  }
  return { ok: true, entries, all: false };
}

/** 运行中的目标实例（身份已确认，可直接 RPC / reload） */
function runningTargets(entries: GatewayStateEntry[]): GatewayStateEntry[] {
  return entries.filter((entry) => entry.state === 'running');
}

/**
 * 显式 node_id 与其它运行实例重复时拒绝（0.14）。
 * 自动生成的 node_id 不在此检查范围。
 */
function duplicateExplicitNodeId(
  entries: GatewayStateEntry[],
  instance: string,
  config: VesselConfig,
): GatewayStateEntry | undefined {
  const nodeId = config.host?.nodeId;
  if (nodeId === undefined || nodeId === '') return undefined;
  return entries.find(
    (entry) =>
      entry.instance !== instance &&
      entry.record !== undefined &&
      (entry.state === 'running' || entry.state === 'degraded') &&
      entry.record.node_id === nodeId,
  );
}

/**
 * 前台 `gateway start` / `restart` / `--serve` 的启动前检查：
 * 运行中 → 拒绝；死 pid / 损坏文件 → 回收；获取实例锁；
 * 显式 node_id 与其它运行实例重复 → 拒绝。
 */
export async function prepareForegroundGatewayStart(
  options: {
    config?: VesselConfig;
    dataDir?: string;
    env?: Record<string, string | undefined>;
    instance?: string;
    collectState?: typeof collectGatewayState;
  } = {},
): Promise<
  | {
      ok: true;
      dataDir: string;
      config: VesselConfig;
      instance: string;
      lock: GatewayInstanceLock;
    }
  | { ok: false; error: string; runningPid?: number }
> {
  const config = options.config ?? (await loadConfig()).config;
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? resolveDataDir(config, env);
  const instance = normalizeGatewayInstance(options.instance);
  const token = resolveGatewayToken(config, env);
  const snapshot = await (options.collectState ?? collectGatewayState)(dataDir, {
    ...(token !== undefined ? { token } : {}),
  });
  const entry = findStateEntry(snapshot.entries, instance);

  if (entry !== undefined && entryOccupied(entry)) {
    const pid = entryPid(entry);
    if (entry.record !== undefined) {
      return {
        ok: false,
        error: t('gateway.alreadyRunning', {
          pid: entry.record.pid,
          url: gatewayBaseUrl(entry.record, config.serve?.tls !== undefined),
        }),
        ...(pid !== undefined ? { runningPid: pid } : {}),
      };
    }
    return {
      ok: false,
      error: t('gateway.alreadyRunningPid', { pid: pid ?? 0 }),
      ...(pid !== undefined ? { runningPid: pid } : {}),
    };
  }
  if (entry !== undefined && (entry.state === 'unknown' || entry.state === 'foreign-host')) {
    return {
      ok: false,
      error:
        entry.state === 'unknown'
          ? t('gateway.status.unknown')
          : t('gateway.status.foreignHost', { host: entry.lock?.host ?? '' }),
    };
  }
  if (entry !== undefined && entry.state === 'stale') {
    // 只有确认 stale 才条件清理；文件被别人改过则不动。
    await cleanupGatewayStateEntry(dataDir, entry).catch(() => undefined);
  }

  const duplicate = duplicateExplicitNodeId(snapshot.entries, instance, config);
  if (duplicate !== undefined) {
    const owner = duplicate.record;
    return {
      ok: false,
      error:
        `duplicate_node_id: host.nodeId "${config.host?.nodeId}" is already used by ` +
        `gateway instance "${duplicate.instance}"` +
        (owner !== undefined ? ` (pid ${owner.pid})` : '') +
        '. Set a unique host.nodeId per gateway.',
      ...(owner !== undefined ? { runningPid: owner.pid } : {}),
    };
  }

  let lock: GatewayInstanceLock;
  try {
    lock = await acquireGatewayInstanceLock({ dataDir, instance });
  } catch (error) {
    if (error instanceof GatewayInstanceLockedError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
  return { ok: true, dataDir, config, instance, lock };
}

/** gateway 起来后写 PID，并注册退出清理（只删本进程持有的文件） */
export async function writeForegroundGatewayPid(options: {
  dataDir: string;
  host: string;
  port: number;
  version?: string;
  nodeId?: string;
  instance?: string;
  /** 与实例锁共享的 started_at（epoch ms）；缺省取当前时间。 */
  startedAt?: number;
}): Promise<void> {
  const instance = normalizeGatewayInstance(options.instance);
  const record: GatewayPidRecord = {
    pid: process.pid,
    started_at: new Date(options.startedAt ?? Date.now()).toISOString(),
    host: options.host,
    port: options.port,
    version: options.version ?? readPackageVersion(),
    ...(options.nodeId !== undefined ? { node_id: options.nodeId } : {}),
    ...(instance !== DEFAULT_GATEWAY_INSTANCE ? { instance } : {}),
  };
  await writeGatewayPid(options.dataDir, record, instance);
  process.once('exit', () =>
    deleteRecordIfOwnedSync(gatewayPidPath(options.dataDir, instance), {
      pid: process.pid,
      started_at: record.started_at,
    }),
  );
}

/** `gateway stop`（也供 cli.ts 的前台 restart 复用） */
export async function stopGateway(
  options: GatewayCommandDeps & {
    timeoutMs?: number;
    selector?: GatewaySelector;
    /** 已收集的状态（restart 停前快照）；缺省自行 collect。 */
    entries?: GatewayStateEntry[];
  } = {},
): Promise<number> {
  const context = await resolveContext(options);
  const print = options.print ?? console.log;
  const printErr = options.printErr ?? console.error;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const sleep = options.sleep ?? sleepDefault;
  const selector = options.selector ?? {};
  const fallbackRunner = options.runCommand ?? createCommandRunner(2000);

  const entries = options.entries ?? (await collectStateFor(context, options)).entries;
  const token = resolveGatewayToken(context.config, context.env);
  const targets = await resolveGatewayTargets(context.dataDir, selector, {
    entries,
    ...(options.collectState !== undefined ? { collectState: options.collectState } : {}),
    ...(token !== undefined ? { token } : {}),
  });
  if (!targets.ok) {
    printErr(ui.err(targets.error));
    return 1;
  }

  if (targets.entries.length === 0) {
    print(ui.info(t('gateway.notRunning')));
    return 0;
  }

  let failed = false;
  for (const entry of targets.entries) {
    if (entry.state === 'stale') {
      // 确认 stale：条件清理 pid/lock/owner，不杀进程。
      try {
        await cleanupGatewayStateEntry(context.dataDir, entry);
        print(ui.ok(t('gateway.stop.reclaimed', { instance: entry.instance })));
      } catch (error) {
        printErr(
          ui.err(
            t('gateway.stop.cleanupFailed', {
              pid: entryPid(entry) ?? 0,
              files: errorMessage(error),
            }),
          ),
        );
        failed = true;
      }
      continue;
    }
    if (entry.state === 'starting') {
      // R4：正在启动不等待，不删除任何文件。
      printErr(ui.err(t('gateway.stop.starting', { instance: entry.instance })));
      failed = true;
      continue;
    }
    if (entry.state === 'unknown') {
      printErr(ui.err(t('gateway.status.unknown')));
      failed = true;
      continue;
    }
    if (entry.state === 'foreign-host') {
      printErr(ui.err(t('gateway.status.foreignHost', { host: entry.lock?.host ?? '' })));
      failed = true;
      continue;
    }
    if (entry.state !== 'running' && entry.state !== 'degraded') continue;

    const pid = entryPid(entry);
    if (pid === undefined) {
      printErr(ui.err(t('gateway.status.unknown')));
      failed = true;
      continue;
    }
    if (pid === process.pid) {
      printErr(ui.err(t('gateway.stopSelf')));
      failed = true;
      continue;
    }

    if (entry.state === 'degraded') {
      // R3：仅当 2s 命令行回退确认是 gateway 才杀；不可读/超时/非 gateway → 拒绝且不删。
      let alive = true;
      let commandLine: string | undefined;
      try {
        const info = await inspectProcess(pid, {
          platform: context.platform,
          runCommand: fallbackRunner,
        });
        alive = info.alive;
        commandLine = info.commandLine;
      } catch {
        commandLine = undefined;
      }
      if (alive && (commandLine === undefined || !isGatewayCommandLine(commandLine))) {
        printErr(ui.err(t('gateway.stop.notGateway', { pid })));
        failed = true;
        continue;
      }
      if (!alive) {
        // 竞态：收集后已自行退出；按已死亡处理，做条件清理。
        const clean = await cleanupStoppedEntry(context, entry, print, printErr);
        if (!clean) failed = true;
        continue;
      }
    }

    try {
      terminateProcess(pid, context.platform);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        printErr(ui.err(t('gateway.stopFailed', { pid, detail: errorMessage(error) })));
        failed = true;
        continue;
      }
    }

    const deadline = Date.now() + timeoutMs;
    let stopped = false;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        stopped = true;
        break;
      }
      await sleep(100);
    }

    if (!stopped) {
      printErr(ui.err(t('gateway.stopTimeout', { pid, timeout: `${timeoutMs}ms` })));
      failed = true;
      continue;
    }

    // 确认死亡后按 pid+started_at 条件清理（Windows 强杀补偿）。
    const clean = await cleanupStoppedEntry(context, entry, print, printErr);
    if (!clean) failed = true;
  }

  return failed ? 1 : 0;
}

/** 进程确认死亡后清理该实例的 pid/lock/owner，并核对文件确实消失。 */
async function cleanupStoppedEntry(
  context: ResolvedContext,
  entry: GatewayStateEntry,
  print: (line: string) => void,
  printErr: (line: string) => void,
): Promise<boolean> {
  const pid = entryPid(entry) ?? 0;
  try {
    await cleanupGatewayStateEntry(context.dataDir, entry);
  } catch (error) {
    printErr(ui.err(t('gateway.stop.cleanupFailed', { pid, files: errorMessage(error) })));
    return false;
  }
  const remaining: string[] = [];
  if (entry.pidPath !== undefined && (await Bun.file(entry.pidPath).exists())) {
    remaining.push(entry.pidPath);
  }
  if (entry.lockPath !== undefined && (await Bun.file(entry.lockPath).exists())) {
    remaining.push(entry.lockPath);
  }
  if (remaining.length > 0) {
    printErr(ui.err(t('gateway.stop.cleanupFailed', { pid, files: remaining.join(', ') })));
    return false;
  }
  print(ui.ok(t('gateway.stopped', { pid })));
  return true;
}

/** 单个实例的状态 JSON（0.14 字段；0.35 只为 gateway list 增加 state）。 */
function instanceStatusJson(
  entry: GatewayStateEntry,
  config: VesselConfig,
  now: () => number,
): Record<string, unknown> {
  const record = entry.record;
  const pidFile = entry.pidPath ?? entry.lockPath ?? '';
  const tls = config.serve?.tls !== undefined;
  if (record !== undefined) {
    const uptimeSeconds = Math.floor((now() - Date.parse(record.started_at)) / 1000);
    return {
      instance: entry.instance,
      running: entry.state === 'running',
      pid: record.pid,
      host: record.host,
      port: record.port,
      url: gatewayBaseUrl(record, tls),
      started_at: record.started_at,
      uptime_seconds: Math.max(0, uptimeSeconds),
      version: record.version,
      ...(record.node_id !== undefined ? { node_id: record.node_id } : {}),
      pid_file: pidFile,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    };
  }
  return {
    instance: entry.instance,
    running: false,
    pid_file: pidFile,
    ...(entry.lock !== undefined ? { pid: entry.lock.pid } : {}),
    ...(entry.state === 'stale' ? { stale: true } : {}),
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
  };
}

/** 人类可读的实例状态行（status / list / stop 共用）。 */
function formatEntryState(entry: GatewayStateEntry, config: VesselConfig): string {
  const record = entry.record;
  const tls = config.serve?.tls !== undefined;
  switch (entry.state) {
    case 'running':
      return `${ui.ok(t('gateway.running'))}  pid ${record?.pid ?? 0}  ${record ? gatewayBaseUrl(record, tls) : ''}`;
    case 'degraded':
      return ui.warn(
        t('gateway.status.degraded', {
          pid: record?.pid ?? entry.lock?.pid ?? 0,
          reason: entry.reason ?? '',
        }),
      );
    case 'starting':
      return ui.warn(t('gateway.status.starting', { pid: entryPid(entry) ?? 0 }));
    case 'stale':
      return ui.warn(
        t('gateway.status.stale', {
          pid: record?.pid ?? entry.lock?.pid ?? 0,
          reason: entry.reason ?? '',
        }),
      );
    case 'unknown':
      return ui.warn(t('gateway.status.unknown'));
    case 'foreign-host':
      return ui.warn(t('gateway.status.foreignHost', { host: entry.lock?.host ?? '' }));
    default:
      return t('gateway.notRunning');
  }
}

function serviceLine(service: Awaited<ReturnType<typeof serviceStatus>>): string {
  return service.supported
    ? `${service.target} (${service.installed ? 'installed' : 'not installed'})`
    : 'unsupported on this platform';
}

/** `gateway status [--json] [--instance|--port|--all]` */
export async function gatewayStatus(
  options: GatewayCommandDeps & { json?: boolean; selector?: GatewaySelector; rpc?: boolean } = {},
): Promise<number> {
  if (options.rpc === true) {
    return gatewayStatusRpc(options);
  }
  const context = await resolveContext(options);
  const print = options.print ?? console.log;
  const printErr = options.printErr ?? console.error;
  const json = options.json === true;
  const now = options.now ?? Date.now;
  const selector = options.selector ?? {};
  const useSelection =
    selector.instance !== undefined || selector.port !== undefined || selector.all === true;
  const snapshot = await collectStateFor(context, options);
  const entries = snapshot.entries;

  if (useSelection) {
    const targets = await resolveGatewayTargets(context.dataDir, selector, {
      entries,
      ...(options.collectState !== undefined ? { collectState: options.collectState } : {}),
    });
    if (!targets.ok) {
      printErr(ui.err(targets.error));
      return 1;
    }
    const selected = targets.entries;
    // R11：running/degraded/starting 都表示进程仍在，exit 0；stale/unknown/foreign-host → 1。
    const allLive = selected.length > 0 && selected.every(entryOccupied);
    if (json) {
      print(
        JSON.stringify(
          {
            as_of: new Date(now()).toISOString(),
            instances: selected.map((entry) => instanceStatusJson(entry, context.config, now)),
          },
          null,
          2,
        ),
      );
      return allLive ? 0 : 1;
    }
    print(ui.title(t('gateway.status.title')));
    print(ui.rule(48));
    if (selected.length === 0) {
      print(ui.kv(t('gateway.status.status'), t('gateway.notRunning'), 10));
      return 1;
    }
    for (const entry of selected) {
      print(ui.kv(entry.instance, formatEntryState(entry, context.config), 12));
      const pidFile = entry.pidPath ?? entry.lockPath;
      if (pidFile !== undefined) print(`  ${ui.dim(pidFile)}`);
    }
    return allLive ? 0 : 1;
  }

  const service = await serviceStatus(context.platform, {
    dataDir: context.dataDir,
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
  });
  const allLive = entries.length > 0 && entries.every(entryOccupied);
  const defaultEntry = findStateEntry(entries, DEFAULT_GATEWAY_INSTANCE);

  if (json) {
    // R2：无选择器 JSON schema 不变，仍按 default 实例输出（多实例机器视图用 list）。
    print(JSON.stringify(legacyStatusJson(defaultEntry, context, service, now), null, 2));
    return allLive ? 0 : 1;
  }

  print(ui.title(t('gateway.status.title')));
  print(ui.rule(48));
  if (entries.length === 0) {
    print(ui.kv(t('gateway.status.status'), t('gateway.notRunning'), 10));
    print(`  ${ui.dim(t('gateway.status.pidFile', { path: gatewayPidPath(context.dataDir) }))}`);
    return 1;
  }
  for (const entry of entries) {
    print(ui.kv(entry.instance, formatEntryState(entry, context.config), 12));
    const pidFile = entry.pidPath ?? entry.lockPath;
    if (pidFile !== undefined) print(`  ${ui.dim(pidFile)}`);
  }
  if (entries.length >= 2) {
    print(ui.dim(t('gateway.status.selectHint', { count: entries.length })));
  }
  print(ui.kv(t('gateway.status.service'), serviceLine(service), 10));
  return allLive ? 0 : 1;
}

/** 无选择器 `gateway status --json`：保持 0.14 顶层字段，按 default 实例输出。 */
function legacyStatusJson(
  entry: GatewayStateEntry | undefined,
  context: ResolvedContext,
  service: Awaited<ReturnType<typeof serviceStatus>>,
  now: () => number,
): Record<string, unknown> {
  const pidFile = entry?.pidPath ?? gatewayPidPath(context.dataDir);
  if (entry?.record !== undefined && entry.state === 'running') {
    const record = entry.record;
    return {
      instance: DEFAULT_GATEWAY_INSTANCE,
      running: true,
      pid: record.pid,
      host: record.host,
      port: record.port,
      url: gatewayBaseUrl(record, context.config.serve?.tls !== undefined),
      started_at: record.started_at,
      uptime_seconds: Math.max(0, Math.floor((now() - Date.parse(record.started_at)) / 1000)),
      version: record.version,
      ...(record.node_id !== undefined ? { node_id: record.node_id } : {}),
      pid_file: pidFile,
      service,
    };
  }
  return {
    running: false,
    pid_file: pidFile,
    ...(entry?.state === 'stale' ? { stale: true } : {}),
    ...(entry?.record !== undefined
      ? { pid: entry.record.pid }
      : entry?.lock !== undefined
        ? { pid: entry.lock.pid }
        : {}),
    ...(entry?.reason !== undefined ? { reason: entry.reason } : {}),
    service,
  };
}

interface GatewayRpcView {
  instance: string;
  url: string;
  ok: boolean;
  error?: string;
  health?: Record<string, unknown>;
  queue?: { queued: number; running: number };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function collectRpcView(
  target: ControlPlaneTarget,
  instance: string,
): Promise<GatewayRpcView> {
  const view: GatewayRpcView = { instance, url: target.baseUrl, ok: false };
  try {
    const health = await target.request<unknown>('health.get');
    view.health = isRecordValue(health) ? health : {};
    view.ok = true;
  } catch (error) {
    view.error = error instanceof Error ? error.message : String(error);
  }
  try {
    const listed = await target.request<unknown>('runs.list');
    const runs = isRecordValue(listed) && Array.isArray(listed.runs) ? listed.runs : [];
    let queued = 0;
    let running = 0;
    for (const run of runs) {
      if (!isRecordValue(run)) continue;
      const status = run.status;
      if (status === 'queued' || status === 'pending') queued += 1;
      else if (status === 'running') running += 1;
    }
    view.queue = { queued, running };
  } catch {
    // runs.list 不可用时只报 health。
  }
  return view;
}

/** `gateway status --rpc [--json]`：查询 health / queue（只读，不 attach runtime）。 */
async function gatewayStatusRpc(
  options: GatewayCommandDeps & { json?: boolean; selector?: GatewaySelector },
): Promise<number> {
  const context = await resolveContext(options);
  const print = options.print ?? console.log;
  const printErr = options.printErr ?? console.error;
  const json = options.json === true;
  const selector = options.selector ?? {};
  const snapshot = await collectStateFor(context, options);
  const entries = snapshot.entries;
  const targetOptions = {
    config: context.config,
    env: context.env,
    dataDir: context.dataDir,
    entries,
  };
  const views: GatewayRpcView[] = [];
  const instances: string[] = [];

  if (selector.all === true) {
    for (const entry of entries) {
      if (entry.state !== 'running' && entry.state !== 'degraded') continue;
      instances.push(entry.instance);
    }
  } else if (selector.instance !== undefined) {
    instances.push(selector.instance);
  } else if (selector.port !== undefined) {
    const targets = await resolveGatewayTargets(context.dataDir, selector, { entries });
    if (!targets.ok) {
      printErr(ui.err(targets.error));
      return 1;
    }
    for (const entry of targets.entries) {
      if (entry.state === 'running' || entry.state === 'degraded') {
        instances.push(entry.instance);
      }
    }
  }

  if (options.rpcTarget !== undefined) {
    views.push(await collectRpcView(options.rpcTarget, options.rpcTarget.instance ?? 'default'));
  } else if (instances.length === 0) {
    const resolved = await resolveControlPlaneTarget(targetOptions);
    if (!resolved.ok) {
      if (json) {
        print(JSON.stringify({ rpc: true, ok: false, error: resolved.error }, null, 2));
      } else {
        printErr(ui.err(resolved.error));
      }
      return 1;
    }
    try {
      views.push(await collectRpcView(resolved.target, resolved.target.instance ?? 'default'));
    } finally {
      await resolved.target.close().catch(() => undefined);
    }
  } else {
    for (const instance of instances) {
      const resolved = await resolveControlPlaneTarget({ ...targetOptions, instance });
      if (!resolved.ok) {
        views.push({
          instance,
          url: '',
          ok: false,
          error: resolved.error,
        });
        continue;
      }
      try {
        views.push(await collectRpcView(resolved.target, instance));
      } finally {
        await resolved.target.close().catch(() => undefined);
      }
    }
  }

  const exitCode = views.length > 0 && views.every((view) => view.ok) ? 0 : 1;
  if (json) {
    const running = [...views].sort((a, b) => a.instance.localeCompare(b.instance));
    print(
      JSON.stringify(
        { as_of: new Date(Date.now()).toISOString(), rpc: true, instances: running },
        null,
        2,
      ),
    );
    return exitCode;
  }

  print(ui.title(t('gateway.status.title')));
  print(ui.rule(48));
  for (const view of views) {
    const node = isRecordValue(view.health?.node) ? view.health.node : undefined;
    const statusText =
      node?.status !== undefined
        ? String(node.status)
        : view.health?.status !== undefined
          ? String(view.health.status)
          : '-';
    print(
      ui.kv(
        view.instance,
        view.ok
          ? `${ui.ok(t('gateway.status.rpcOk'))}  ${view.url}`
          : ui.err(t('gateway.status.rpcFailed', { error: view.error ?? 'unknown' })),
        12,
      ),
    );
    if (!view.ok) continue;
    print(`  ${ui.kv(t('gateway.status.status'), statusText, 12)}`);
    const nodeId = node?.node_id ?? view.health?.node_id;
    if (nodeId !== undefined) print(`  ${ui.kv(t('gateway.status.node'), String(nodeId), 12)}`);
    const currentRun = view.health?.current_run_id ?? node?.current_run_id;
    if (currentRun !== undefined) {
      print(`  ${ui.kv(t('gateway.status.currentRun'), String(currentRun), 12)}`);
    }
    if (view.queue !== undefined) {
      print(
        `  ${ui.kv(
          t('gateway.status.queue'),
          `${view.queue.queued} queued / ${view.queue.running} running`,
          12,
        )}`,
      );
    }
  }
  return exitCode;
}

/** `gateway list [--json]`（0.14） */
/** owner 展示/JSON 只保留非敏感字段，token 永不输出（R9）。 */
function ownerView(owner: GatewayStateOwner): Record<string, unknown> {
  return {
    pid: owner.pid,
    host: owner.host,
    port: owner.port,
    tenant_id: owner.tenant_id,
    started_at: owner.started_at,
  };
}

export async function gatewayList(
  options: GatewayCommandDeps & { json?: boolean } = {},
): Promise<number> {
  const context = await resolveContext(options);
  const print = options.print ?? console.log;
  const json = options.json === true;
  const now = options.now ?? Date.now;
  const snapshot = await collectStateFor(context, options);
  const entries = snapshot.entries;

  if (json) {
    print(
      JSON.stringify(
        {
          as_of: new Date(now()).toISOString(),
          instances: entries.map((entry) => ({
            ...instanceStatusJson(entry, context.config, now),
            state: entry.state,
            ...(entry.lock !== undefined
              ? {
                  lock: {
                    pid: entry.lock.pid,
                    started_at: entry.lock.started_at,
                    host: entry.lock.host,
                  },
                }
              : {}),
            ...(entry.owner !== undefined ? { owner: ownerView(entry.owner) } : {}),
          })),
          ...(snapshot.owners.length > 0
            ? { owners: snapshot.owners.map((owner) => ownerView(owner)) }
            : {}),
          ...(snapshot.hub !== undefined ? { hub: snapshot.hub } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  print(ui.title(t('gateway.list.title')));
  print(ui.rule(48));
  if (entries.length === 0 && snapshot.owners.length === 0 && snapshot.hub === undefined) {
    print(ui.info(t('gateway.list.empty')));
    return 0;
  }
  for (const entry of entries) {
    print(ui.kv(entry.instance, formatEntryState(entry, context.config), 12));
    if (entry.pidPath !== undefined) print(`  ${ui.dim(entry.pidPath)}`);
    if (entry.lockPath !== undefined) print(`  ${ui.dim(`lock ${entry.lockPath}`)}`);
    if (entry.owner !== undefined) {
      print(
        `  ${ui.dim(
          `owner pid ${entry.owner.pid} ${entry.owner.host}:${entry.owner.port} tenant ${entry.owner.tenant_id}`,
        )}`,
      );
    }
  }
  for (const owner of snapshot.owners) {
    print(
      ui.kv(
        t('gateway.list.owner'),
        `pid ${owner.pid} ${owner.host}:${owner.port} tenant ${owner.tenant_id}`,
        12,
      ),
    );
  }
  if (snapshot.hub !== undefined) {
    const hub = snapshot.hub;
    const detail =
      hub.state === 'running'
        ? `running${hub.record !== undefined ? ` pid ${hub.record.pid}` : ''}${hub.record?.url !== undefined ? ` ${hub.record.url}` : ''}`
        : `${hub.state}${hub.reason !== undefined ? ` (${hub.reason})` : ''}`;
    print(
      ui.kv(t('gateway.list.hub'), hub.state === 'running' ? ui.ok(detail) : ui.warn(detail), 12),
    );
    print(`  ${ui.dim(hub.path)}`);
  }
  return 0;
}

/** `gateway reload [--scope ...] [--instance|--port|--all]` */
export async function reloadGatewayCommand(
  options: GatewayCommandDeps & { scopes?: string[]; selector?: GatewaySelector } = {},
): Promise<number> {
  const context = await resolveContext(options);
  const print = options.print ?? console.log;
  const printErr = options.printErr ?? console.error;
  const selector = options.selector ?? {};

  const entries = (await collectStateFor(context, options)).entries;
  const targets = await resolveGatewayTargets(context.dataDir, selector, { entries });
  if (!targets.ok) {
    printErr(ui.err(targets.error));
    return 1;
  }
  const running = runningTargets(targets.entries);
  if (running.length === 0) {
    printErr(ui.err(t('gateway.reloadNoGateway')));
    return 1;
  }

  const token = resolveGatewayToken(context.config, context.env);
  if (token === undefined) {
    printErr(ui.err(t('gateway.noToken')));
    return 1;
  }

  let failed = false;
  for (const entry of running) {
    if (entry.record === undefined) continue;
    const prefix = running.length > 1 ? `[${entry.instance}] ` : '';
    const result = await reloadGateway({
      record: entry.record,
      token,
      ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
      tls: context.config.serve?.tls !== undefined,
    });
    if (!result.ok) {
      printErr(ui.err(`${prefix}${t('gateway.reloadFailed', { detail: result.error })}`));
      failed = true;
      continue;
    }

    print(
      ui.ok(
        `${prefix}${t('gateway.reloaded', {
          scopes: result.result.reloaded.length > 0 ? result.result.reloaded.join(', ') : '(none)',
        })}`,
      ),
    );
    if (result.result.requires_restart.length > 0) {
      print(
        ui.warn(
          `${prefix}${t('gateway.requiresRestart', {
            scopes: result.result.requires_restart.join(', '),
          })}`,
        ),
      );
    }
  }
  return failed ? 1 : 0;
}

async function startDaemonCommand(
  options: GatewayCommandDeps & {
    instance?: string;
    port?: number;
    host?: string;
    daemonLog?: string;
  },
): Promise<number> {
  const context = await resolveContext(options);
  const print = options.print ?? console.log;
  const printErr = options.printErr ?? console.error;
  const instance = deriveGatewayInstance(options.instance, options.port);
  const logPath = options.daemonLog ?? options.logPath ?? gatewayLogPath(context.dataDir, instance);

  // 启动诊断：只提示，不在这里构建 —— 本进程随后就会退出（真正长驻的是被 spawn
  // 的 daemon 子进程，它走前台 gateway 路径，由 `cli.ts` 负责后台重建）。
  // 在这里起构建会随父进程退出被杀掉。
  const staticDir = context.env.VESSEL_STATIC_DIR;
  const warning = webDistWarning(await inspectWebDist(staticDir ? { staticDir } : {}));
  if (warning) printErr(ui.warn(warning));

  const snapshot = await collectStateFor(context, options);
  const duplicate = duplicateExplicitNodeId(snapshot.entries, instance, context.config);
  if (duplicate !== undefined) {
    printErr(
      ui.err(
        `duplicate_node_id: host.nodeId "${context.config.host?.nodeId}" is already used by ` +
          `gateway instance "${duplicate.instance}". Set a unique host.nodeId per gateway.`,
      ),
    );
    return 1;
  }

  const result = await startGatewayDaemon({
    dataDir: context.dataDir,
    instance,
    logPath,
    state: snapshot,
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.exclusive === true ? { exclusive: true } : {}),
    ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
  });

  if (result.ok) {
    const url = gatewayBaseUrl(result.record, context.config.serve?.tls !== undefined);
    if (result.unconfirmed === true) {
      print(ui.warn(t('gateway.startedUnconfirmed', { pid: result.record.pid })));
    } else {
      print(ui.ok(t('gateway.started', { pid: result.record.pid, url })));
    }
    print(ui.dim(t('gateway.logPath', { path: result.logPath })));
    return 0;
  }

  if (result.error === 'already_running') {
    printErr(
      ui.err(
        t('gateway.alreadyRunningPid', {
          pid: result.runningPid ?? 0,
        }),
      ),
    );
  } else if (result.error === 'state_unknown') {
    printErr(ui.err(t('gateway.status.unknown')));
  } else {
    printErr(ui.err(t('gateway.startFailed', { detail: result.message })));
    printErr(ui.dim(t('gateway.logPath', { path: result.logPath })));
  }
  return 1;
}

async function installServiceCommand(
  options: GatewayCommandDeps & { target?: GatewayInstallTarget },
): Promise<number> {
  const context = await resolveContext(options);
  const print = options.print ?? console.log;
  const printErr = options.printErr ?? console.error;

  const resolved = resolveServiceTarget(context.platform, options.target);
  if (!resolved.ok) {
    printErr(ui.err(resolved.error));
    return 1;
  }

  const result = await installService(resolved.target, {
    dataDir: context.dataDir,
    platform: context.platform,
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
  });
  if (!result.ok) {
    printErr(ui.err(t('gateway.serviceInstallFailed', { detail: result.error })));
    return 1;
  }
  print(
    ui.ok(
      t('gateway.serviceInstalled', {
        target: result.target,
        path: result.path ?? result.target,
      }),
    ),
  );
  return 0;
}

async function uninstallServiceCommand(options: GatewayCommandDeps = {}): Promise<number> {
  const context = await resolveContext(options);
  const print = options.print ?? console.log;
  const printErr = options.printErr ?? console.error;

  const resolved = resolveServiceTarget(context.platform);
  if (!resolved.ok) {
    printErr(ui.err(resolved.error));
    return 1;
  }

  const result = await uninstallService(resolved.target, {
    dataDir: context.dataDir,
    platform: context.platform,
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
  });
  if (!result.ok) {
    printErr(ui.err(t('gateway.serviceUninstallFailed', { detail: result.error })));
    return 1;
  }
  print(ui.ok(t('gateway.serviceUninstalled', { target: result.target })));
  return 0;
}

/** `gateway restart --daemon`（0.14：支持选择器与 --all） */
async function restartDaemonCommand(
  command: Extract<GatewayCommand, { kind: 'restart' }>,
  deps: GatewayCommandDeps,
): Promise<number> {
  const context = await resolveContext(deps);
  const printErr = deps.printErr ?? console.error;
  // 停前快照：instance/port/host 原样保留（lock-only 也保留 instance）。
  const entries = (await collectStateFor(context, deps)).entries;
  const targets = await resolveGatewayTargets(context.dataDir, command, { entries });
  if (!targets.ok) {
    printErr(ui.err(targets.error));
    return 1;
  }

  const stopCode = await stopGateway({ ...deps, selector: command, entries });
  if (stopCode !== 0) return stopCode;

  if (command.all === true) {
    if (targets.entries.length === 0) return startDaemonCommand({ ...deps });
    let failed = false;
    for (const entry of targets.entries) {
      const code = await startDaemonCommand({
        ...deps,
        instance: entry.instance,
        ...(command.port !== undefined
          ? { port: command.port }
          : entry.record !== undefined
            ? { port: entry.record.port }
            : {}),
        ...(entry.record !== undefined ? { host: entry.record.host } : {}),
      });
      if (code !== 0) failed = true;
    }
    return failed ? 1 : 0;
  }

  const previous = targets.entries[0];
  return startDaemonCommand({
    ...deps,
    ...(command.instance !== undefined
      ? { instance: command.instance }
      : previous !== undefined
        ? { instance: previous.instance }
        : {}),
    ...(command.port !== undefined
      ? { port: command.port }
      : previous?.record !== undefined
        ? { port: previous.record.port }
        : {}),
    ...(previous?.record !== undefined ? { host: previous.record.host } : {}),
  });
}

/** 执行一次性 gateway 子命令，返回退出码 */
export async function runGatewayCommand(
  command: GatewayCommand,
  deps: GatewayCommandDeps = {},
): Promise<number> {
  switch (command.kind) {
    case 'start':
      return startDaemonCommand({
        ...deps,
        ...(command.instance !== undefined ? { instance: command.instance } : {}),
        ...(command.port !== undefined ? { port: command.port } : {}),
        ...(command.host !== undefined ? { host: command.host } : {}),
        ...(command.log !== undefined ? { daemonLog: command.log } : {}),
      });
    case 'restart':
      return restartDaemonCommand(command, deps);
    case 'stop':
      return stopGateway({ ...deps, timeoutMs: command.timeoutMs, selector: command });
    case 'status':
      return gatewayStatus({ ...deps, json: command.json, rpc: command.rpc, selector: command });
    case 'list':
      return gatewayList({ ...deps, json: command.json });
    case 'reload':
      return reloadGatewayCommand({
        ...deps,
        selector: command,
        ...(command.scopes !== undefined ? { scopes: command.scopes } : {}),
      });
    case 'install-service':
      return installServiceCommand({
        ...deps,
        ...(command.target !== undefined ? { target: command.target } : {}),
      });
    case 'uninstall-service':
      return uninstallServiceCommand(deps);
  }
}

/** 前台 `start`/`restart` 是否由 cli.ts 处理（其余进一次性注册表） */
export function isForegroundGatewayCommand(command: GatewayCommand): boolean {
  return (command.kind === 'start' || command.kind === 'restart') && command.daemon === false;
}
