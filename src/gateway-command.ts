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

import { loadConfig, type VesselConfig } from '../packages/config/src/index';
import type { GatewayCommand, GatewayInstallTarget, GatewaySelector } from './cli-args';
import { type ControlPlaneTarget, resolveControlPlaneTarget } from './control-plane-target';
import { resolveDataDir } from './data-paths';
import { gatewayLogPath, startGatewayDaemon } from './gateway/daemon';
import {
  acquireGatewayInstanceLock,
  type GatewayInstanceLock,
  GatewayInstanceLockedError,
} from './gateway/instance-lock';
import {
  type CommandRunner,
  DEFAULT_GATEWAY_INSTANCE,
  type GatewayPidEntry,
  type GatewayPidRecord,
  gatewayPidPath,
  type InspectProcessOptions,
  isProcessAlive,
  listGatewayPidStates,
  normalizeGatewayInstance,
  readGatewayPidState,
  removeGatewayPid,
  removeGatewayPidIfOwnedSync,
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

function formatUptime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
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

function inspectOptions(options: InspectProcessOptions): InspectProcessOptions {
  return {
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
    ...(options.readCmdline !== undefined ? { readCmdline: options.readCmdline } : {}),
  };
}

/** 选择器解析结果 */
export type GatewayTargetsResult =
  | { ok: true; entries: GatewayPidEntry[]; all: boolean }
  | { ok: false; error: string; code: 'multiple_instances' | 'invalid_selector' };

/**
 * 按 `--instance` / `--port` / `--all` 解析目标；无选择器时：
 * 0 个实例 → 空；1 个 → 该实例；≥2 个 → `multiple_instances`。
 */
export async function resolveGatewayTargets(
  dataDir: string,
  selector: GatewaySelector,
  options: { platform?: NodeJS.Platform; runCommand?: CommandRunner } = {},
): Promise<GatewayTargetsResult> {
  const entries = await listGatewayPidStates(dataDir, inspectOptions(options));

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
      entries: entries.filter(
        (entry) =>
          (entry.state.kind === 'running' || entry.state.kind === 'stale') &&
          entry.state.record.port === selector.port,
      ),
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

/** 运行中的目标实例 */
function runningTargets(entries: GatewayPidEntry[]): GatewayPidEntry[] {
  return entries.filter((entry) => entry.state.kind === 'running');
}

/**
 * 显式 node_id 与其它运行实例重复时拒绝（0.14）。
 * 自动生成的 node_id 不在此检查范围。
 */
async function duplicateExplicitNodeId(
  dataDir: string,
  instance: string,
  config: VesselConfig,
  options: InspectProcessOptions,
): Promise<GatewayPidEntry | undefined> {
  const nodeId = config.host?.nodeId;
  if (nodeId === undefined || nodeId === '') return undefined;
  const entries = await listGatewayPidStates(dataDir, inspectOptions(options));
  return entries.find(
    (entry) =>
      entry.instance !== instance &&
      entry.state.kind === 'running' &&
      entry.state.record.node_id === nodeId,
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
    platform?: NodeJS.Platform;
    runCommand?: CommandRunner;
    readCmdline?: (pid: number) => Promise<string | undefined>;
    instance?: string;
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
  const dataDir = options.dataDir ?? resolveDataDir(config, options.env ?? process.env);
  const instance = normalizeGatewayInstance(options.instance);
  const state = await readGatewayPidState(dataDir, {
    instance,
    ...inspectOptions(options),
  });

  if (state.kind === 'running') {
    return {
      ok: false,
      error: t('gateway.alreadyRunning', {
        pid: state.record.pid,
        url: gatewayBaseUrl(state.record, config.serve?.tls !== undefined),
      }),
      runningPid: state.record.pid,
    };
  }
  if (state.kind !== 'absent') {
    await removeGatewayPid(dataDir, instance).catch(() => undefined);
  }

  const duplicate = await duplicateExplicitNodeId(dataDir, instance, config, options);
  if (duplicate !== undefined) {
    const owner = duplicate.state.kind === 'running' ? duplicate.state.record : undefined;
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
}): Promise<void> {
  const instance = normalizeGatewayInstance(options.instance);
  const record: GatewayPidRecord = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    host: options.host,
    port: options.port,
    version: options.version ?? readPackageVersion(),
    ...(options.nodeId !== undefined ? { node_id: options.nodeId } : {}),
    ...(instance !== DEFAULT_GATEWAY_INSTANCE ? { instance } : {}),
  };
  await writeGatewayPid(options.dataDir, record, instance);
  process.once('exit', () => removeGatewayPidIfOwnedSync(options.dataDir, process.pid, instance));
}

/** `gateway stop`（也供 cli.ts 的前台 restart 复用） */
export async function stopGateway(
  options: GatewayCommandDeps & {
    timeoutMs?: number;
    selector?: GatewaySelector;
  } = {},
): Promise<number> {
  const context = await resolveContext(options);
  const print = options.print ?? console.log;
  const printErr = options.printErr ?? console.error;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const sleep = options.sleep ?? sleepDefault;
  const selector = options.selector ?? {};

  const targets = await resolveGatewayTargets(context.dataDir, selector, {
    platform: context.platform,
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
  });
  if (!targets.ok) {
    printErr(ui.err(targets.error));
    return 1;
  }

  // 选择器命中的 stale/invalid 文件直接回收；未选中的实例不动。
  for (const entry of targets.entries) {
    if (entry.state.kind === 'stale' || entry.state.kind === 'invalid') {
      await removeGatewayPid(context.dataDir, entry.instance).catch(() => undefined);
    }
  }

  const running = runningTargets(targets.entries);
  if (running.length === 0) {
    print(ui.info(t('gateway.notRunning')));
    return 0;
  }

  let failed = false;
  for (const entry of running) {
    if (entry.state.kind !== 'running') continue;
    const pid = entry.state.record.pid;
    if (pid === process.pid) {
      printErr(ui.err(t('gateway.stopSelf')));
      failed = true;
      continue;
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
    await removeGatewayPid(context.dataDir, entry.instance).catch(() => undefined);
    print(ui.ok(t('gateway.stopped', { pid })));
  }

  return failed ? 1 : 0;
}

/** 单个实例的状态 JSON（0.14） */
function instanceStatusJson(
  entry: GatewayPidEntry,
  config: VesselConfig,
  now: () => number,
): Record<string, unknown> {
  const state = entry.state;
  const tls = config.serve?.tls !== undefined;
  if (state.kind === 'running') {
    const record = state.record;
    const uptimeSeconds = Math.floor((now() - Date.parse(record.started_at)) / 1000);
    return {
      instance: entry.instance,
      running: true,
      pid: record.pid,
      host: record.host,
      port: record.port,
      url: gatewayBaseUrl(record, tls),
      started_at: record.started_at,
      uptime_seconds: Math.max(0, uptimeSeconds),
      version: record.version,
      ...(record.node_id !== undefined ? { node_id: record.node_id } : {}),
      pid_file: entry.path,
    };
  }
  return {
    instance: entry.instance,
    running: false,
    pid_file: entry.path,
    ...(state.kind === 'stale'
      ? { stale: true, pid: state.record.pid, reason: state.reason }
      : state.kind === 'invalid'
        ? { reason: state.reason }
        : {}),
  };
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

  if (useSelection) {
    const targets = await resolveGatewayTargets(context.dataDir, selector, {
      platform: context.platform,
      ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
    });
    if (!targets.ok) {
      printErr(ui.err(targets.error));
      return 1;
    }
    const entries = targets.entries;
    const allRunning = entries.length > 0 && runningTargets(entries).length === entries.length;
    if (json) {
      print(
        JSON.stringify(
          {
            as_of: new Date(now()).toISOString(),
            instances: entries.map((entry) => instanceStatusJson(entry, context.config, now)),
          },
          null,
          2,
        ),
      );
      return allRunning ? 0 : 1;
    }
    print(ui.title(t('gateway.status.title')));
    print(ui.rule(48));
    if (entries.length === 0) {
      print(ui.kv(t('gateway.status.status'), t('gateway.notRunning'), 10));
      return 1;
    }
    for (const entry of entries) {
      const status = instanceStatusJson(entry, context.config, now);
      const stateText =
        status.running === true ? ui.ok(t('gateway.running')) : t('gateway.notRunning');
      print(
        ui.kv(
          entry.instance,
          `${stateText}${status.url !== undefined ? `  ${String(status.url)}` : ''}`,
          12,
        ),
      );
    }
    return allRunning ? 0 : 1;
  }

  const state = await readGatewayPidState(context.dataDir, {
    platform: context.platform,
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
  });
  const service = await serviceStatus(context.platform, {
    dataDir: context.dataDir,
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
  });

  if (state.kind !== 'running') {
    const stale = state.kind === 'stale' || state.kind === 'invalid';
    if (json) {
      print(
        JSON.stringify(
          {
            running: false,
            pid_file: gatewayPidPath(context.dataDir),
            ...(stale ? { stale: true } : {}),
            ...(state.kind === 'stale'
              ? { pid: state.record.pid, reason: state.reason }
              : state.kind === 'invalid'
                ? { reason: state.reason }
                : {}),
            service,
          },
          null,
          2,
        ),
      );
    } else {
      print(ui.title(t('gateway.status.title')));
      print(ui.rule(48));
      print(ui.kv(t('gateway.status.status'), t('gateway.notRunning'), 10));
      if (state.kind === 'stale') {
        print(
          `  ${ui.warn(
            t('gateway.status.stale', { pid: state.record.pid, reason: state.reason }),
          )}`,
        );
      } else if (state.kind === 'invalid') {
        print(`  ${ui.warn(t('gateway.status.invalid', { reason: state.reason }))}`);
      }
      print(`  ${ui.dim(t('gateway.status.pidFile', { path: gatewayPidPath(context.dataDir) }))}`);
    }
    return 1;
  }

  const record = state.record;
  const tls = context.config.serve?.tls !== undefined;
  const url = gatewayBaseUrl(record, tls);
  const uptimeSeconds = Math.floor((now() - Date.parse(record.started_at)) / 1000);

  if (json) {
    print(
      JSON.stringify(
        {
          instance: DEFAULT_GATEWAY_INSTANCE,
          running: true,
          pid: record.pid,
          host: record.host,
          port: record.port,
          url,
          started_at: record.started_at,
          uptime_seconds: Math.max(0, uptimeSeconds),
          version: record.version,
          ...(record.node_id !== undefined ? { node_id: record.node_id } : {}),
          pid_file: gatewayPidPath(context.dataDir),
          service,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  print(ui.title(t('gateway.status.title')));
  print(ui.rule(48));
  const rows: Array<[string, string]> = [
    [t('gateway.status.status'), ui.ok(t('gateway.running'))],
    [t('gateway.status.instance'), DEFAULT_GATEWAY_INSTANCE],
    [t('gateway.status.pid'), String(record.pid)],
    [t('gateway.status.address'), url],
    [t('gateway.status.uptime'), formatUptime(uptimeSeconds)],
    [t('gateway.status.version'), record.version],
  ];
  if (record.node_id !== undefined) rows.push([t('gateway.status.node'), record.node_id]);
  rows.push([
    t('gateway.status.service'),
    service.supported
      ? `${service.target} (${service.installed ? 'installed' : 'not installed'})`
      : 'unsupported on this platform',
  ]);
  for (const [label, value] of rows) print(ui.kv(label, value, 10));
  return 0;
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
  const targetOptions = {
    config: context.config,
    env: context.env,
    dataDir: context.dataDir,
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
  };
  const views: GatewayRpcView[] = [];
  const instances: string[] = [];

  if (selector.all === true) {
    const entries = await listGatewayPidStates(context.dataDir, {
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
    });
    for (const entry of entries) {
      if (entry.state.kind !== 'running') continue;
      instances.push(entry.instance);
    }
  } else if (selector.instance !== undefined) {
    instances.push(selector.instance);
  } else if (selector.port !== undefined) {
    const targets = await resolveGatewayTargets(context.dataDir, selector, {
      platform: context.platform,
      ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
    });
    if (!targets.ok) {
      printErr(ui.err(targets.error));
      return 1;
    }
    for (const entry of targets.entries) {
      if (entry.state.kind === 'running') instances.push(entry.instance);
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
export async function gatewayList(
  options: GatewayCommandDeps & { json?: boolean } = {},
): Promise<number> {
  const context = await resolveContext(options);
  const print = options.print ?? console.log;
  const json = options.json === true;
  const now = options.now ?? Date.now;
  const entries = await listGatewayPidStates(context.dataDir, {
    platform: context.platform,
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
  });

  if (json) {
    print(
      JSON.stringify(
        {
          as_of: new Date(now()).toISOString(),
          instances: entries.map((entry) => instanceStatusJson(entry, context.config, now)),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  print(ui.title(t('gateway.list.title')));
  print(ui.rule(48));
  if (entries.length === 0) {
    print(ui.info(t('gateway.list.empty')));
    return 0;
  }
  for (const entry of entries) {
    const status = instanceStatusJson(entry, context.config, now);
    const running = status.running === true;
    const detail = running
      ? `${status.pid}  ${String(status.url)}`
      : entry.state.kind === 'stale'
        ? `stale (${entry.state.reason})`
        : entry.state.kind === 'invalid'
          ? `invalid (${entry.state.reason})`
          : 'not running';
    print(ui.kv(entry.instance, `${running ? ui.ok(t('gateway.running')) : detail}`, 12));
    if (running) print(`  ${ui.dim(String(detail))}`);
    print(`  ${ui.dim(entry.path)}`);
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

  const targets = await resolveGatewayTargets(context.dataDir, selector, {
    platform: context.platform,
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
  });
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
    if (entry.state.kind !== 'running') continue;
    const prefix = running.length > 1 ? `[${entry.instance}] ` : '';
    const result = await reloadGateway({
      record: entry.state.record,
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

  const duplicate = await duplicateExplicitNodeId(context.dataDir, instance, context.config, {
    platform: context.platform,
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
  });
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
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.exclusive === true ? { exclusive: true } : {}),
    ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    platform: context.platform,
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
  });

  if (result.ok) {
    const url = gatewayBaseUrl(result.record, context.config.serve?.tls !== undefined);
    print(ui.ok(t('gateway.started', { pid: result.record.pid, url })));
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
  const targets = await resolveGatewayTargets(context.dataDir, command, {
    platform: context.platform,
    ...(deps.runCommand !== undefined ? { runCommand: deps.runCommand } : {}),
  });
  if (!targets.ok) {
    printErr(ui.err(targets.error));
    return 1;
  }
  const running = runningTargets(targets.entries);

  const stopCode = await stopGateway({ ...deps, selector: command });
  if (stopCode !== 0) return stopCode;

  if (command.all === true) {
    if (running.length === 0) return startDaemonCommand({ ...deps });
    let failed = false;
    for (const entry of running) {
      if (entry.state.kind !== 'running') continue;
      const record = entry.state.record;
      const code = await startDaemonCommand({
        ...deps,
        instance: entry.instance,
        ...(record.port !== 0 ? { port: record.port } : {}),
        host: record.host,
      });
      if (code !== 0) failed = true;
    }
    return failed ? 1 : 0;
  }

  const previous = running[0];
  const previousRecord = previous?.state.kind === 'running' ? previous.state.record : undefined;
  return startDaemonCommand({
    ...deps,
    ...(command.instance !== undefined
      ? { instance: command.instance }
      : previous !== undefined
        ? { instance: previous.instance }
        : {}),
    ...(command.port !== undefined
      ? { port: command.port }
      : previousRecord !== undefined && previousRecord.port !== 0
        ? { port: previousRecord.port }
        : {}),
    ...(previousRecord !== undefined ? { host: previousRecord.host } : {}),
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
