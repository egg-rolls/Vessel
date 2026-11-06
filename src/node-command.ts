/**
 * `vessel node` 一次性子命令（0.49 G1）。
 *
 * Node API 单独监听（缺省 `serve.port` / 8644），与 `vessel gateway start`
 * 共享同一 `<dataDir>/gateway-<instance>.pid/.lock`：同一 node 只允许一个写者。
 *
 * - `node start --daemon`：分离子进程，子进程走 cli.ts 的 node 前台管线；
 * - `node status [--json] [--rpc]`：读同一实例 PID + 探测 node 端口 health；
 * - `node stop`：gateway 托管时返回稳定非 0（提示 `gateway stop`），否则停 node；
 * - `node reload`：与 `gateway reload` 同一操作（Node API `gateway.reload` RPC）。
 *
 * @module vessel/node-command
 */

import { loadConfig, type VesselConfig } from '../packages/config/src/index';
import type { NodeCommand } from './cli-args';
import type { ControlPlaneTarget } from './control-plane-target';
import { resolveDataDir } from './data-paths';
import { gatewayLogPath, startGatewayDaemon } from './gateway/daemon';
import {
  cleanupGatewayStateEntry,
  collectGatewayState,
  DEFAULT_GATEWAY_INSTANCE,
  type GatewayPidRecord,
  isProcessAlive,
  readGatewayPidRecord,
} from './gateway/pid';
import { gatewayBaseUrl, reloadGateway } from './gateway/reload';
import {
  gatewayStatus,
  isPlatformRecord,
  type NodeListenInfo,
  nodeListenFromConfig,
  printSplitModePortError,
  probeHttpHealth,
} from './gateway-command';
import { t } from './i18n';
import { createHttpRpcClient } from './rpc/http-client';
import { resolveGatewayToken } from './transport-factory';
import { ui } from './ui-style';

/** 依赖注入（CLI 只用默认值；测试注入配置/路径/RPC 目标） */
export interface NodeCommandDeps {
  config?: VesselConfig;
  dataDir?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => Promise<void>;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  /** 测试注入：`node status --rpc` 直接使用该 RPC 目标。 */
  rpcTarget?: ControlPlaneTarget;
}

interface ResolvedNodeContext {
  config: VesselConfig;
  dataDir: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
}

async function resolveNodeContext(deps: NodeCommandDeps): Promise<ResolvedNodeContext> {
  const env = deps.env ?? process.env;
  const config = deps.config ?? (await loadConfig({ env })).config;
  return {
    config,
    dataDir: deps.dataDir ?? resolveDataDir(config, env),
    env,
    platform: deps.platform ?? process.platform,
  };
}

/** 构造 node 端口上的 RPC 目标（`--rpc` 复用 gateway 的 health/queue 视图）。 */
function nodeRpcTarget(listen: NodeListenInfo, token: string): ControlPlaneTarget {
  const client = createHttpRpcClient({
    baseUrl: listen.url,
    token,
    subscribe: false,
    requestTimeoutMs: 10_000,
  });
  return {
    kind: 'local',
    baseUrl: listen.url,
    token,
    request: <T = unknown>(method: string, params?: unknown) => client.request<T>(method, params),
    close: () => client.close(),
  };
}

function fakeRecord(listen: NodeListenInfo): GatewayPidRecord {
  return {
    pid: process.pid,
    started_at: new Date(0).toISOString(),
    host: listen.host,
    port: listen.port,
    version: '0',
  };
}

/** `node start --daemon`：分离子进程并等待 PID 文件（仅在两个监听就绪后写）。 */
async function startNodeDaemonCommand(deps: NodeCommandDeps): Promise<number> {
  const context = await resolveNodeContext(deps);
  const print = deps.print ?? console.log;
  const printErr = deps.printErr ?? console.error;
  // 0.49 G1（1 裁定）：父进程在 spawn 前拒绝 0 端口，避免 daemon 只留日志。
  const portError = printSplitModePortError(context.config, 'node', (line) =>
    printErr(ui.err(line)),
  );
  if (portError !== null) return portError;
  const instance = DEFAULT_GATEWAY_INSTANCE;
  const logPath = gatewayLogPath(context.dataDir, instance);

  const result = await startGatewayDaemon({
    dataDir: context.dataDir,
    instance,
    logPath,
    command: 'node',
  });

  if (result.ok) {
    const url = gatewayBaseUrl(result.record, context.config.serve?.tls !== undefined);
    if (result.unconfirmed === true) {
      print(ui.warn(t('gateway.startedUnconfirmed', { pid: result.record.pid })));
    } else {
      print(ui.ok(t('node.started', { pid: result.record.pid, url })));
    }
    print(ui.dim(t('gateway.logPath', { path: result.logPath })));
    return 0;
  }

  if (result.error === 'already_running') {
    printErr(ui.err(t('gateway.alreadyRunningPid', { pid: result.runningPid ?? 0 })));
  } else if (result.error === 'state_unknown') {
    printErr(ui.err(t('gateway.status.unknown')));
  } else {
    printErr(ui.err(t('gateway.startFailed', { detail: result.message })));
    printErr(ui.dim(t('gateway.logPath', { path: result.logPath })));
  }
  return 1;
}

/** `node status [--json] [--rpc]`：读同一实例 PID + 探测 node 端口。 */
async function nodeStatusCommand(
  command: Extract<NodeCommand, { kind: 'status' }>,
  deps: NodeCommandDeps,
): Promise<number> {
  const context = await resolveNodeContext(deps);
  const print = deps.print ?? console.log;
  const printErr = deps.printErr ?? console.error;
  const listen = nodeListenFromConfig(context.config);
  const token = resolveGatewayToken(context.config, context.env) ?? '';

  if (command.rpc) {
    const target = deps.rpcTarget ?? nodeRpcTarget(listen, token);
    return gatewayStatus({
      config: context.config,
      dataDir: context.dataDir,
      env: context.env,
      rpc: true,
      json: command.json,
      rpcTarget: target,
      ...(deps.print !== undefined ? { print: deps.print } : {}),
      ...(deps.printErr !== undefined ? { printErr: deps.printErr } : {}),
    });
  }

  const record = await readGatewayPidRecord(context.dataDir);
  const alive = record !== null && isProcessAlive(record.pid);
  const health = await probeHttpHealth(
    fakeRecord(listen),
    1500,
    context.config.serve?.tls !== undefined,
  );
  const running = alive && health !== undefined;

  if (command.json) {
    print(
      JSON.stringify(
        {
          as_of: new Date(Date.now()).toISOString(),
          running,
          node: {
            host: listen.host,
            port: listen.port,
            url: listen.url,
            ...(health !== undefined ? { health } : {}),
          },
          ...(record !== null ? { pid: record.pid } : {}),
        },
        null,
        2,
      ),
    );
    return running ? 0 : 1;
  }

  if (running) {
    print(ui.ok(t('node.running', { url: listen.url })));
    return 0;
  }
  printErr(ui.err(t('node.notRunning')));
  return 1;
}

/** `node stop`：gateway 托管 → 稳定非 0 并提示 `gateway stop`，不杀进程。 */
async function nodeStopCommand(deps: NodeCommandDeps): Promise<number> {
  const context = await resolveNodeContext(deps);
  const print = deps.print ?? console.log;
  const printErr = deps.printErr ?? console.error;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const token = resolveGatewayToken(context.config, context.env);
  const snapshot = await collectGatewayState(context.dataDir, {
    ...(token !== undefined ? { token } : {}),
  });
  const entry = snapshot.entries.find((item) => item.instance === DEFAULT_GATEWAY_INSTANCE);
  const record = entry?.record;

  if (record === undefined || !isProcessAlive(record.pid)) {
    if (entry !== undefined && entry.state === 'stale') {
      await cleanupGatewayStateEntry(context.dataDir, entry).catch(() => undefined);
    }
    printErr(ui.err(t('node.notRunning')));
    return 1;
  }

  // 确定性判定：记录指向 platform 监听 → 该进程由 gateway 托管。
  const health = await probeHttpHealth(record);
  if (health?.role === 'platform') {
    printErr(ui.err(t('node.managedByGateway')));
    return 1;
  }

  try {
    if (context.platform === 'win32') process.kill(record.pid);
    else process.kill(record.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      printErr(ui.err(t('gateway.stopFailed', { pid: record.pid, detail: String(error) })));
      return 1;
    }
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(record.pid)) {
      if (entry !== undefined) {
        await cleanupGatewayStateEntry(context.dataDir, entry).catch(() => undefined);
      }
      print(ui.ok(t('node.stopped', { pid: record.pid })));
      return 0;
    }
    await sleep(100);
  }

  printErr(ui.err(t('gateway.stopTimeout', { pid: record.pid, timeout: '10000ms' })));
  return 1;
}

/** `node reload`：与 `gateway reload` 同一操作（Node API `gateway.reload`）。 */
async function nodeReloadCommand(
  command: Extract<NodeCommand, { kind: 'reload' }>,
  deps: NodeCommandDeps,
): Promise<number> {
  const context = await resolveNodeContext(deps);
  const print = deps.print ?? console.log;
  const printErr = deps.printErr ?? console.error;
  const token = resolveGatewayToken(context.config, context.env);
  const entries = (
    await collectGatewayState(context.dataDir, {
      ...(token !== undefined ? { token } : {}),
    })
  ).entries;
  const running = entries.filter(
    (entry) =>
      entry.record !== undefined && (entry.state === 'running' || entry.state === 'degraded'),
  );
  if (running.length === 0) {
    printErr(ui.err(t('node.reloadNoNode')));
    return 1;
  }

  const listen = nodeListenFromConfig(context.config);
  const reloadToken = token ?? '';
  let failed = false;
  for (const entry of running) {
    if (entry.record === undefined) continue;
    const record = (await isPlatformRecord(entry.record))
      ? { ...entry.record, host: listen.host, port: listen.port }
      : entry.record;
    const result = await reloadGateway({
      record,
      token: reloadToken,
      ...(command.scopes !== undefined ? { scopes: command.scopes } : {}),
      tls: context.config.serve?.tls !== undefined,
    });
    if (!result.ok) {
      printErr(ui.err(t('gateway.reloadFailed', { detail: result.error })));
      failed = true;
      continue;
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
        ui.warn(
          t('gateway.requiresRestart', { scopes: result.result.requires_restart.join(', ') }),
        ),
      );
    }
  }
  return failed ? 1 : 0;
}

/** 前台 `node start` 由 cli.ts 接进 serve 管线；其余进一次性注册表。 */
export function isForegroundNodeCommand(command: NodeCommand): boolean {
  return command.kind === 'start' && command.daemon === false;
}

/** 执行一次性 node 子命令，返回退出码 */
export async function runNodeCommand(
  command: NodeCommand,
  deps: NodeCommandDeps = {},
): Promise<number> {
  switch (command.kind) {
    case 'start':
      return startNodeDaemonCommand(deps);
    case 'status':
      return nodeStatusCommand(command, deps);
    case 'stop':
      return nodeStopCommand(deps);
    case 'reload':
      return nodeReloadCommand(command, deps);
  }
}
