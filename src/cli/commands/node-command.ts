/**
 * `vessel node` 一次性子命令（0.49 G1）。
 *
 * Node API 单独监听（缺省 `node.port` / 8644），与 `vessel gateway start`
 * 共享同一 `<dataDir>/gateway-<instance>.pid/.lock`：同一 node 只允许一个写者。
 *
 * - `node start --daemon`：分离子进程，子进程走 cli.ts 的 node 前台管线；
 * - `node status [--json] [--rpc]`：读同一实例 PID + 探测 node 端口 health；
 * - `node stop`：gateway 托管时返回稳定非 0（提示 `gateway stop`），否则停 node；
 * - `node reload`：与 `gateway reload` 同一操作（Node API `gateway.reload` RPC）。
 *
 * @module vessel/node-command
 */

import * as path from 'node:path';
import {
  DATA_DIR_CLI_MARKER_ENV,
  loadConfig,
  type VesselConfig,
} from '../../../packages/config/src/index';
import { formatEventLine } from '../../../packages/serve/src/index';
import { expandHome, resolveDataDir } from '../../data/data-paths';
import { gatewayLogPath, startGatewayDaemon } from '../../gateway/daemon';
import { loadNodeRegistry } from '../../gateway/node-registry';
import { readSpawnedChildren, resolveNodeStopToken } from '../../gateway/node-supervisor';
import {
  cleanupGatewayStateEntry,
  collectGatewayState,
  DEFAULT_GATEWAY_INSTANCE,
  defaultCommandRunner,
  type GatewayPidRecord,
  type GatewayStateEntry,
  isProcessAlive,
  readGatewayPidRecord,
} from '../../gateway/pid';
import { gatewayBaseUrl, reloadGateway, shutdownGateway } from '../../gateway/reload';
import {
  type DrainRun,
  nodeRunSampler,
  POST_QUIESCE_EXIT_TIMEOUT_MS,
  persistStopAuditLine,
  snapshotActiveRuns,
  waitForProcessExit,
} from '../../gateway/stop-drain';
import { t } from '../../i18n';
import { effectiveNodeTokenAuto, readKnownNodeId } from '../../node/token-derive';
import { createHttpRpcClient } from '../../rpc/http-client';
import type { NodeCommand } from '../args';
import type { ControlPlaneTarget } from '../control-plane-target';
import { ui } from '../output';
import {
  formatDrainProgressLine,
  formatForcedAuditEvent,
  formatForcedAuditLine,
  gatewayStatus,
  isPlatformRecord,
  type NodeListenInfo,
  nodeListenFromConfig,
  printSplitModePortError,
  probeHttpHealth,
} from './gateway/gateway-command';
// 0.56：`node token` 与「显式 > 注入 > 派生」的 node token 解析。
import { nodeTokenCommand } from './token-command';

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

async function resolveNodeContext(
  deps: NodeCommandDeps,
  configPath?: string,
): Promise<ResolvedNodeContext> {
  const env = deps.env ?? process.env;
  const config =
    deps.config ??
    (
      await loadConfig({
        env,
        ...(configPath !== undefined ? { configPath } : {}),
      })
    ).config;
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
async function startNodeDaemonCommand(
  command: Extract<NodeCommand, { kind: 'start' }>,
  deps: NodeCommandDeps,
): Promise<number> {
  const configPath =
    command.configPath !== undefined ? path.resolve(expandHome(command.configPath)) : undefined;
  const context = await resolveNodeContext(deps, configPath);
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
    ...(configPath !== undefined ? { configPath } : {}),
  });

  if (result.ok) {
    const url = gatewayBaseUrl(result.record, context.config.node?.tls !== undefined);
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
  // 0.56：显式配置 > gateway 注入的 VESSEL_NODE_TOKEN > 派生（本机身份已知时）。
  const statusToken = effectiveNodeTokenAuto({
    config: context.config,
    dataDir: context.dataDir,
    env: context.env,
  });
  const token = statusToken.ok ? (statusToken.value.token ?? '') : '';

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
    context.config.node?.tls !== undefined,
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

function sameDataDir(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === '';
}

function nonEmptyStr(value: string | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * F1/SD-2 链A：stop 侧凭据以**目标 node 自己的 config/dataDir** 为权威。
 *
 * 用户 config 的显式 `node.token` 只属于缺省 node：`--data-dir` / 名称解析指向
 * dataDir 不同的舰队 node 时，把它发过去必 401（该 node 只认自己的显式 / 注入 /
 * 派生值）→ 静默强杀。判定：
 * - 目标 dataDir == config 自身数据根 → config 就是目标自己的 config，旧链不动
 *   （effectiveNodeTokenAuto：显式 > 注入 > 派生 > 匿名）；
 * - 否则 → resolveNodeStopToken：舰队 registry 查目标 config_path 加载其自身
 *   config，查不到则按目标 dataDir 的 root-secret + node.json 纯派生。
 *
 * 「config 自身数据根」= 去掉 CLI targeting 覆盖（`--data-dir` 镜像，伴生标记
 * VESSEL_DATA_DIR_CLI=1）后重新加载的 config 数据根；无标记的继承 VESSEL_DATA_DIR
 * 是 config 自身根的一部分（旧语义不动）。
 */
async function resolveStopTokenForTarget(
  context: ResolvedNodeContext,
): Promise<string | undefined> {
  const env = context.env;
  const cliDataDir =
    env[DATA_DIR_CLI_MARKER_ENV] === '1' ? nonEmptyStr(env.VESSEL_DATA_DIR) : undefined;
  let configOwnDataDir = resolveDataDir(context.config, env);
  if (cliDataDir !== undefined) {
    const envOwn = { ...env, VESSEL_DATA_DIR: undefined, [DATA_DIR_CLI_MARKER_ENV]: undefined };
    const ownLoaded = await loadConfig({ env: envOwn }).catch(() => undefined);
    configOwnDataDir =
      ownLoaded !== undefined
        ? resolveDataDir(ownLoaded.config, envOwn)
        : resolveDataDir(context.config, envOwn);
  }
  if (sameDataDir(configOwnDataDir, context.dataDir)) {
    const resolution = effectiveNodeTokenAuto({
      config: context.config,
      dataDir: context.dataDir,
      env,
    });
    return resolution.ok ? resolution.value.token : undefined;
  }
  const token = await resolveNodeStopToken({
    nodeId: readKnownNodeId(context.dataDir) ?? '',
    dataDir: context.dataDir,
    registryDataDir: configOwnDataDir,
    env,
  });
  return token === '' ? undefined : token;
}

/**
 * G3b：平台进程 spawn 的本地 node 记录在 `<gatewayDataDir>/platform-children[-<instance>].json`
 * 里。隐式节点的 dataDir == gatewayDataDir，所以 `node stop` 能读到 manifest 并
 * 拒绝越过 `gateway stop` 直接杀子进程。
 *
 * 已知限制：显式 registry 节点的 dataDir 与 gatewayDataDir 不同，`node stop`
 * 看不到 manifest；这类节点同样用 `vessel gateway stop` 停止，不新增 marker 文件。
 */
async function isManagedByPlatform(
  dataDir: string,
  record: GatewayPidRecord,
  token: string | undefined,
): Promise<boolean> {
  const snapshot = await collectGatewayState(dataDir, {
    kind: 'platform',
    ...(token !== undefined ? { token } : {}),
  });
  for (const entry of snapshot.entries) {
    if (entry.state !== 'running' && entry.state !== 'degraded' && entry.state !== 'starting') {
      continue;
    }
    const children = await readSpawnedChildren(dataDir, entry.instance);
    for (const child of children) {
      // node_id / pid / data_dir 任一匹配即认定由该平台实例监督。
      if (record.node_id !== undefined && child.node_id === record.node_id) return true;
      if (child.pid === record.pid) return true;
      if (sameDataDir(child.data_dir, dataDir)) return true;
    }
  }
  return false;
}

/** `node stop`：gateway 托管 → 稳定非 0 并提示 `gateway stop`，不杀进程。 */
async function nodeStopCommand(deps: NodeCommandDeps, force = false): Promise<number> {
  const context = await resolveNodeContext(deps);
  const print = deps.print ?? console.log;
  const printErr = deps.printErr ?? console.error;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  // F1/SD-2 链A：凭据以目标 node 自己的 config/dataDir 为权威（舰队 node 不发用户 config token）。
  const token = await resolveStopTokenForTarget(context);
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

  // 确定性判定 1（G1 legacy）：记录指向 platform 监听 → 该进程由 gateway 托管。
  const health = await probeHttpHealth(record);
  if (health?.role === 'platform') {
    printErr(ui.err(t('node.managedByGateway')));
    return 1;
  }
  // 确定性判定 2（G3b）：平台进程的 children manifest 含该 node → 由 gateway 托管。
  if (await isManagedByPlatform(context.dataDir, record, token)) {
    printErr(ui.err(t('node.managedByGateway')));
    return 1;
  }

  // 用户裁定 #5：force = 显式非正常退出 —— 快照 + 强杀 + 审计，跳过优雅等待。
  if (force) {
    let runs: DrainRun[] = [];
    let snapshotUnavailable = false;
    try {
      runs = await snapshotActiveRuns(record, token ?? '', context.config.node?.tls !== undefined);
    } catch {
      snapshotUnavailable = true;
    }
    printErr(
      ui.warn(
        formatForcedAuditLine(
          'node',
          DEFAULT_GATEWAY_INSTANCE,
          record.pid,
          runs,
          snapshotUnavailable,
        ),
      ),
    );
    // DR15-1/O7：审计持久化到 node 实例日志（停止方 stdout 不进 node log）。
    await persistStopAuditLine(
      gatewayLogPath(context.dataDir, DEFAULT_GATEWAY_INSTANCE),
      formatForcedAuditEvent(
        'node',
        DEFAULT_GATEWAY_INSTANCE,
        record.pid,
        runs,
        snapshotUnavailable,
      ),
    );
    try {
      await killNodeTree(context.platform, record.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        printErr(ui.err(t('gateway.stopFailed', { pid: record.pid, detail: String(error) })));
        return 1;
      }
    }
    return confirmNodeStopped(context, entry, record.pid, sleep, print, printErr);
  }

  // 优雅（默认）：进程内 drain-to-quiesce（fence + 不限时等活跃 run 自然跑完）
  // + 停止方不限时等死 + 5s 进度。Windows 上外部强杀（taskkill /T /F）是无条件终止，
  // 不先走这一步，在跑 run 会被直接切断（只能靠启动 sweep 对账）。
  let graceful = await shutdownGateway({
    record,
    token: token ?? '',
    tls: context.config.node?.tls !== undefined,
    requestTimeoutMs: 3_000,
  });
  // F1/SD-2：凭据错配（401）回退强杀前先试一次匿名优雅（零配置 node 回环匿名可能仍开着）。
  let samplerToken = token ?? '';
  if (!graceful.ok && graceful.code === 'unauthorized' && (token ?? '') !== '') {
    const anonymous = await shutdownGateway({
      record,
      token: '',
      tls: context.config.node?.tls !== undefined,
      requestTimeoutMs: 3_000,
    });
    if (anonymous.ok) {
      graceful = anonymous;
      samplerToken = '';
    }
  }
  if (graceful.ok) {
    // 默认不限时等死（用户裁定 #5，去掉硬编码 10s）+ 进度（哪些 run/session 还在跑）。
    // DR15-1：等死段有界兜底 —— quiesce 后 30s 未自死 → force + stop.forced 审计；
    // 候 run 段（live > 0）重置时钟，不限时语义不动（红线）。
    const wait = await waitForProcessExit(record.pid, {
      sleep,
      postQuiesceTimeoutMs: POST_QUIESCE_EXIT_TIMEOUT_MS,
      onProgress: (info) =>
        print(ui.info(formatDrainProgressLine(`node ${DEFAULT_GATEWAY_INSTANCE}`, info))),
      sampleRuns: nodeRunSampler(record, samplerToken, context.config.node?.tls !== undefined),
    });
    if (wait.dead) {
      if (entry !== undefined) {
        await cleanupGatewayStateEntry(context.dataDir, entry).catch(() => undefined);
      }
      print(ui.ok(t('node.stopped', { pid: record.pid })));
      return 0;
    }
    if (wait.quiesceTimedOut) {
      // DR15-1：drain 已完成但退出链挂死、进程未自死 → 有界兜底强杀 + 审计。
      let runs: DrainRun[] = [];
      let snapshotUnavailable = false;
      try {
        runs = await snapshotActiveRuns(
          record,
          samplerToken,
          context.config.node?.tls !== undefined,
        );
      } catch {
        snapshotUnavailable = true;
      }
      printErr(
        ui.warn(
          t('stop.quiesceExitTimeout', {
            pid: record.pid,
            timeout: `${POST_QUIESCE_EXIT_TIMEOUT_MS}ms`,
          }),
        ),
      );
      printErr(
        ui.warn(
          formatForcedAuditLine(
            'node',
            DEFAULT_GATEWAY_INSTANCE,
            record.pid,
            runs,
            snapshotUnavailable,
            'quiesce_exit_timeout',
          ),
        ),
      );
      // O7：审计持久化到 node 实例日志（停止方 stdout 不进 node log）。
      await persistStopAuditLine(
        gatewayLogPath(context.dataDir, DEFAULT_GATEWAY_INSTANCE),
        formatForcedAuditEvent(
          'node',
          DEFAULT_GATEWAY_INSTANCE,
          record.pid,
          runs,
          snapshotUnavailable,
          'quiesce_exit_timeout',
        ),
      );
      try {
        await killNodeTree(context.platform, record.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          printErr(ui.err(t('gateway.stopFailed', { pid: record.pid, detail: String(error) })));
          return 1;
        }
      }
      return confirmNodeStopped(context, entry, record.pid, sleep, print, printErr);
    }
  }
  // 优雅受理失败（老版本无该方法 / 网络）→ 回退既有强杀，代打 node.drain.skipped。
  const skippedReason = graceful.ok ? 'error' : (graceful.code ?? 'error');
  printErr(
    ui.warn(
      formatEventLine('node.drain.skipped', {
        pid: record.pid,
        reason: skippedReason,
      }),
    ),
  );
  // F1/SD-2：drain.skipped 证据持久化到 node 实例日志（对齐 stop.forced 先例，O7）。
  await persistStopAuditLine(
    gatewayLogPath(context.dataDir, DEFAULT_GATEWAY_INSTANCE),
    formatEventLine('node.drain.skipped', { pid: record.pid, reason: skippedReason }),
  );
  try {
    await killNodeTree(context.platform, record.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      printErr(ui.err(t('gateway.stopFailed', { pid: record.pid, detail: String(error) })));
      return 1;
    }
  }
  return confirmNodeStopped(context, entry, record.pid, sleep, print, printErr);
}

/**
 * TP-1 口径（对齐 node-supervisor 的 terminateChild）：强杀要带走整棵进程树。
 * POSIX 走信号（force=SIGKILL / 回退=SIGTERM）；Windows 没有进程组语义，
 * `process.kill` 只终止主进程（子进程成孤儿），统一 `taskkill /PID <pid> /T /F`
 * 整棵子树。runner 不抛错：进程已不在时 taskkill 非零退出，由 confirmNodeStopped
 * 的等死确认兜底（与旧 ESRCH 语义同效）。
 */
async function killNodeTree(
  platform: NodeJS.Platform,
  pid: number,
  posixSignal: 'SIGKILL' | 'SIGTERM',
): Promise<void> {
  if (platform === 'win32') {
    await defaultCommandRunner(['taskkill', '/PID', String(pid), '/T', '/F']);
    return;
  }
  process.kill(pid, posixSignal);
}

/** 强杀 / 回退杀后的有界确认等待（kill 应当很快）；确认死 → 条件清理 + 报告。 */
async function confirmNodeStopped(
  context: ResolvedNodeContext,
  entry: GatewayStateEntry | undefined,
  pid: number,
  sleep: (ms: number) => Promise<void>,
  print: (line: string) => void,
  printErr: (line: string) => void,
): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      if (entry !== undefined) {
        await cleanupGatewayStateEntry(context.dataDir, entry).catch(() => undefined);
      }
      print(ui.ok(t('node.stopped', { pid })));
      return 0;
    }
    await sleep(100);
  }
  printErr(ui.err(t('gateway.stopTimeout', { pid, timeout: '10000ms' })));
  return 1;
}

/**
 * `node restart [name]`：docker 式 stop → start（用户裁定 #6，只重启本 node）。
 *
 * 复用 nodeStopCommand（优雅不限时 + 进度 / --force）做 stop 段，startNodeDaemonCommand
 * 做 start 段。stop 未成 → 不 start（D11）。本无运行 → 直接 start（幂等）。
 * 托管节点（platform 监督）→ 不独立重启（提示 vessel restart / gateway restart），
 * 避免与平台 supervisor 的 respawn 打架（§6.2 的 stop-intent 机制属 P1，本轮未做）。
 */
export async function nodeRestartCommand(
  deps: NodeCommandDeps,
  force = false,
  name?: string,
): Promise<number> {
  let context = await resolveNodeContext(deps);
  const print = deps.print ?? console.log;
  const printErr = deps.printErr ?? console.error;
  // 名称解析（node name / dataDir 别名）：给 name → 本舰队 registry 找该 node 的 dataDir。
  if (name !== undefined && name.trim() !== '') {
    const trimmed = name.trim();
    const registry = await loadNodeRegistry(context.dataDir).catch(() => undefined);
    const node =
      registry?.kind === 'ready'
        ? registry.registry.nodes.find((item) => item.name === trimmed)
        : undefined;
    if (node !== undefined) {
      context = await resolveNodeContext({ ...deps, dataDir: node.data_dir });
    } else if (trimmed !== DEFAULT_GATEWAY_INSTANCE) {
      printErr(ui.err(t('restart.unknownTarget', { name: trimmed, dataDir: context.dataDir })));
      return 1;
    }
  }
  // F1/SD-2 链A：与 nodeStopCommand 同口径 —— 目标 node 自己的 config/dataDir 为权威。
  const token = await resolveStopTokenForTarget(context);
  const snapshot = await collectGatewayState(context.dataDir, {
    ...(token !== undefined ? { token } : {}),
  });
  const entry = snapshot.entries.find((item) => item.instance === DEFAULT_GATEWAY_INSTANCE);
  const record = entry?.record;
  const running = record !== undefined && isProcessAlive(record.pid);

  if (running && record !== undefined) {
    // 托管判定（镜像 nodeStopCommand）：托管节点不独立重启，指路舰队/平台 restart。
    const health = await probeHttpHealth(record);
    const managed =
      health?.role === 'platform' || (await isManagedByPlatform(context.dataDir, record, token));
    if (managed) {
      printErr(ui.err(t('node.restartManaged')));
      return 1;
    }
    const stopCode = await nodeStopCommand(deps, force);
    if (stopCode !== 0) {
      printErr(ui.err(t('restart.stopFailed')));
      return stopCode;
    }
  }
  // start 段（本无运行 / 刚停成）：复用 node daemon start 接缝。
  print(ui.info(t('restart.starting', { instance: 'node' })));
  return startNodeDaemonCommand({ kind: 'start', daemon: true }, deps);
}

/** `node reload`：与 `gateway reload` 同一操作（Node API `gateway.reload`）。 */
async function nodeReloadCommand(
  command: Extract<NodeCommand, { kind: 'reload' }>,
  deps: NodeCommandDeps,
): Promise<number> {
  const context = await resolveNodeContext(deps);
  const print = deps.print ?? console.log;
  const printErr = deps.printErr ?? console.error;
  const reloadTokenResolution = effectiveNodeTokenAuto({
    config: context.config,
    dataDir: context.dataDir,
    env: context.env,
  });
  const token = reloadTokenResolution.ok ? reloadTokenResolution.value.token : undefined;
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
      tls: context.config.node?.tls !== undefined,
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

/**
 * `node token [--print] [--json] [--node <id>]`（0.56）。
 *
 * 数据根用本进程解析出的 node dataDir（`--data-dir` / `VESSEL_DATA_DIR` / config），
 * 这样独立启动的 node 也能拿到「它自己会用的那个 token」。
 */
async function nodeTokenSubcommand(
  command: Extract<NodeCommand, { kind: 'token' }>,
  deps: NodeCommandDeps,
): Promise<number> {
  const context = await resolveNodeContext(deps);
  const print = deps.print ?? console.log;
  const printErr = deps.printErr ?? console.error;
  const result = await nodeTokenCommand(
    {
      print: command.print,
      json: command.json,
      ...(command.nodeId !== undefined ? { nodeId: command.nodeId } : {}),
    },
    { dataDir: context.dataDir, env: context.env, config: context.config },
  );
  if (result.stdout !== '') print(result.stdout);
  if (result.stderr !== '') printErr(ui.err(result.stderr));
  return result.exitCode;
}

/** 执行一次性 node 子命令，返回退出码 */
export async function runNodeCommand(
  command: NodeCommand,
  deps: NodeCommandDeps = {},
): Promise<number> {
  switch (command.kind) {
    case 'start':
      return startNodeDaemonCommand(command, deps);
    case 'status':
      return nodeStatusCommand(command, deps);
    case 'stop':
      return nodeStopCommand(deps, command.force === true);
    case 'restart':
      return nodeRestartCommand(deps, command.force === true, command.name);
    case 'reload':
      return nodeReloadCommand(command, deps);
    case 'token':
      return nodeTokenSubcommand(command, deps);
  }
}
