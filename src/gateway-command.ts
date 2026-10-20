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
import type { GatewayCommand, GatewayInstallTarget } from './cli-args';
import { resolveDataDir } from './data-paths';
import { gatewayLogPath, startGatewayDaemon } from './gateway/daemon';
import {
  type CommandRunner,
  type GatewayPidRecord,
  gatewayPidPath,
  isProcessAlive,
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

/**
 * 前台 `gateway start` / `restart` 的启动前检查：
 * 运行中 → 拒绝；死 pid / 损坏文件 → 回收。
 */
export async function prepareForegroundGatewayStart(
  options: {
    config?: VesselConfig;
    dataDir?: string;
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
    runCommand?: CommandRunner;
  } = {},
): Promise<
  | { ok: true; dataDir: string; config: VesselConfig }
  | { ok: false; error: string; runningPid?: number }
> {
  const config = options.config ?? (await loadConfig()).config;
  const dataDir = options.dataDir ?? resolveDataDir(config, options.env ?? process.env);
  const state = await readGatewayPidState(dataDir, {
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
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
    await removeGatewayPid(dataDir).catch(() => undefined);
  }
  return { ok: true, dataDir, config };
}

/** gateway 起来后写 PID，并注册退出清理（只删本进程持有的文件） */
export async function writeForegroundGatewayPid(options: {
  dataDir: string;
  host: string;
  port: number;
  version?: string;
  nodeId?: string;
}): Promise<void> {
  const record: GatewayPidRecord = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    host: options.host,
    port: options.port,
    version: options.version ?? readPackageVersion(),
    ...(options.nodeId !== undefined ? { node_id: options.nodeId } : {}),
  };
  await writeGatewayPid(options.dataDir, record);
  process.once('exit', () => removeGatewayPidIfOwnedSync(options.dataDir, process.pid));
}

/** `gateway stop`（也供 cli.ts 的前台 restart 复用） */
export async function stopGateway(
  options: GatewayCommandDeps & { timeoutMs?: number } = {},
): Promise<number> {
  const context = await resolveContext(options);
  const print = options.print ?? console.log;
  const printErr = options.printErr ?? console.error;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const sleep = options.sleep ?? sleepDefault;

  const state = await readGatewayPidState(context.dataDir, {
    platform: context.platform,
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
  });

  if (state.kind !== 'running') {
    if (state.kind !== 'absent') {
      await removeGatewayPid(context.dataDir).catch(() => undefined);
    }
    print(ui.info(t('gateway.notRunning')));
    return 0;
  }

  const pid = state.record.pid;
  if (pid === process.pid) {
    printErr(ui.err(t('gateway.stopSelf')));
    return 1;
  }

  try {
    terminateProcess(pid, context.platform);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      printErr(ui.err(t('gateway.stopFailed', { pid, detail: errorMessage(error) })));
      return 1;
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      await removeGatewayPid(context.dataDir).catch(() => undefined);
      print(ui.ok(t('gateway.stopped', { pid })));
      return 0;
    }
    await sleep(100);
  }

  printErr(ui.err(t('gateway.stopTimeout', { pid, timeout: `${timeoutMs}ms` })));
  return 1;
}

/** `gateway status [--json]` */
export async function gatewayStatus(
  options: GatewayCommandDeps & { json?: boolean } = {},
): Promise<number> {
  const context = await resolveContext(options);
  const print = options.print ?? console.log;
  const json = options.json === true;
  const now = options.now ?? Date.now;

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

/** `gateway reload [--scope ...]` */
export async function reloadGatewayCommand(
  options: GatewayCommandDeps & { scopes?: string[] } = {},
): Promise<number> {
  const context = await resolveContext(options);
  const print = options.print ?? console.log;
  const printErr = options.printErr ?? console.error;

  const state = await readGatewayPidState(context.dataDir, {
    platform: context.platform,
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
  });
  if (state.kind !== 'running') {
    printErr(ui.err(t('gateway.reloadNoGateway')));
    return 1;
  }

  const token = resolveGatewayToken(context.config, context.env);
  if (token === undefined) {
    printErr(ui.err(t('gateway.noToken')));
    return 1;
  }

  const result = await reloadGateway({
    record: state.record,
    token,
    ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
    tls: context.config.serve?.tls !== undefined,
  });
  if (!result.ok) {
    printErr(ui.err(t('gateway.reloadFailed', { detail: result.error })));
    return 1;
  }

  print(
    ui.ok(
      t('gateway.reloaded', {
        scopes: result.result.reloaded.length > 0 ? result.result.reloaded.join(', ') : '(none)',
      }),
    ),
  );
  if (result.result.requires_restart.length > 0) {
    print(
      ui.warn(t('gateway.requiresRestart', { scopes: result.result.requires_restart.join(', ') })),
    );
  }
  return 0;
}

async function startDaemonCommand(
  options: GatewayCommandDeps & { port?: number; host?: string; daemonLog?: string },
): Promise<number> {
  const context = await resolveContext(options);
  const print = options.print ?? console.log;
  const printErr = options.printErr ?? console.error;
  const logPath = options.daemonLog ?? options.logPath ?? gatewayLogPath(context.dataDir);

  const result = await startGatewayDaemon({
    dataDir: context.dataDir,
    logPath,
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
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

/** 执行一次性 gateway 子命令，返回退出码 */
export async function runGatewayCommand(
  command: GatewayCommand,
  deps: GatewayCommandDeps = {},
): Promise<number> {
  switch (command.kind) {
    case 'start':
      return startDaemonCommand({
        ...deps,
        ...(command.port !== undefined ? { port: command.port } : {}),
        ...(command.host !== undefined ? { host: command.host } : {}),
        ...(command.log !== undefined ? { daemonLog: command.log } : {}),
      });
    case 'restart': {
      const stopCode = await stopGateway({ ...deps });
      if (stopCode !== 0) return stopCode;
      return startDaemonCommand({ ...deps });
    }
    case 'stop':
      return stopGateway({ ...deps, timeoutMs: command.timeoutMs });
    case 'status':
      return gatewayStatus({ ...deps, json: command.json });
    case 'reload':
      return reloadGatewayCommand({
        ...deps,
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
