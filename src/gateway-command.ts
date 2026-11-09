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

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  type ConfigValidationError,
  checkPlatformTokenConflict,
  DEFAULT_GATEWAY_OPTIONS,
  DEFAULT_SERVE_OPTIONS,
  loadConfig,
  resolveGatewayNodePorts,
  resolvePlatformToken,
  type VesselConfig,
} from '../packages/config/src/index';
import { startPlatformGateway } from '../packages/serve/src/index';
import type { GatewayCommand, GatewayInstallTarget, GatewaySelector } from './cli-args';
import { formatConfigErrors } from './config-error-format';
import { type ControlPlaneTarget, resolveControlPlaneTarget } from './control-plane-target';
import { expandHome, resolveDataDir } from './data-paths';
import { gatewayLogPath, startGatewayDaemon } from './gateway/daemon';
import {
  acquireGatewayInstanceLock,
  type GatewayInstanceLock,
  GatewayInstanceLockedError,
} from './gateway/instance-lock';
import {
  assertNodeDataDirMatches,
  loadNodeRegistry,
  type NodeRegistryEntry,
  NodeRegistryError,
  resolveNodeIdForRegistryAdd,
  synthesizeImplicitNode,
} from './gateway/node-registry';
import { type LocalNodeSpec, NodeSupervisor, stopSpawnedChildren } from './gateway/node-supervisor';
import {
  type CommandRunner,
  cleanupGatewayStateEntry,
  collectGatewayState,
  createCommandRunner,
  DEFAULT_GATEWAY_INSTANCE,
  deleteRecordIfOwnedSync,
  type GatewayPidRecord,
  type GatewayStateEntry,
  type GatewayStateKind,
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
  type ServiceStatus,
  serviceStatus,
  uninstallService,
} from './gateway/service';
import { type PlatformStartupHub, renderPlatformStartup } from './gateway-banner';
import { HUB_DEFAULT_HOSTNAME, HUB_DEFAULT_PORT } from './hub/server';
import { t } from './i18n';
import { createHttpRpcClient } from './rpc/http-client';
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
  /** 内部计数探针注入；缺省 collectGatewayState。 */
  collectState?: typeof collectGatewayState;
  /**
   * 0.49 G3b：读哪一族状态文件。gateway 命令缺省 platform；
   * legacy `VESSEL_LEGACY_SERVE=1` 下退回 node。
   */
  stateKind?: GatewayStateKind;
}

function gatewayStateKind(
  options: Pick<GatewayCommandDeps, 'stateKind'>,
  env: Record<string, string | undefined>,
): GatewayStateKind {
  return options.stateKind ?? (env.VESSEL_LEGACY_SERVE === '1' ? 'node' : 'platform');
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

function splitModePortFailure(path: string, label: string): ConfigValidationError {
  return {
    path,
    message:
      `${label}=0 is not allowed in split mode: split mode requires a fixed port ` +
      '(registry/CORS/pid depend on it); a stable port is required. ' +
      'Set an explicit non-zero port.',
  };
}

/**
 * 0.49 G1（1 裁定）：拆分模式显式拒绝 0 端口。
 *
 * - `gateway` 模式：`gateway.port`、`serve.port` 与显式 `--port 0` 都必须非 0；
 * - `node` 模式：`serve.port` 必须非 0（独立 node 不使用 `gateway.port`，无 `--port`）；
 * - legacy `--serve` / `VESSEL_LEGACY_SERVE=1` 不调用（仍允许 0 = 系统分配）。
 */
export function splitModePortError(
  config: VesselConfig,
  mode: 'gateway' | 'node',
  explicitPort?: number,
): ConfigValidationError | null {
  if (mode === 'gateway' && explicitPort === 0) {
    return splitModePortFailure('gateway.port', '--port');
  }
  const checks: Array<{ path: string; value: number | undefined }> =
    mode === 'gateway'
      ? [
          { path: 'gateway.port', value: config.gateway?.port },
          { path: 'serve.port', value: config.serve?.port },
        ]
      : [{ path: 'serve.port', value: config.serve?.port }];
  for (const check of checks) {
    if (check.value === 0) {
      return splitModePortFailure(check.path, check.path);
    }
  }
  return null;
}

/**
 * 打印拆分模式端口错误（复用 config 错误格式），返回退出码 2；无错误返回 null。
 * 调用方据此在 spawn / bind 前 fail-fast。
 */
export function printSplitModePortError(
  config: VesselConfig,
  mode: 'gateway' | 'node',
  printErr: (line: string) => void = (line) => console.error(line),
  explicitPort?: number,
): number | null {
  const error = splitModePortError(config, mode, explicitPort);
  if (error === null) return null;
  printErr(formatConfigErrors([error]));
  return 2;
}

/** `config.hub.dataDir` 分流时的 hub 目录；缺省交给 collect 用 `<dataDir>/hub`。 */
function configuredHubDataDir(config: VesselConfig): string | undefined {
  const configured = config.hub?.dataDir;
  return configured === undefined ? undefined : path.resolve(expandHome(configured));
}

/** 单一读入口：命令层统一从这里取状态快照。 */
async function collectStateFor(
  context: ResolvedContext,
  deps: Pick<GatewayCommandDeps, 'collectState' | 'stateKind'> = {},
): Promise<GatewayStateSnapshot> {
  const collect = deps.collectState ?? collectGatewayState;
  const token = resolveGatewayToken(context.config, context.env);
  const hubDataDir = configuredHubDataDir(context.config);
  return collect(context.dataDir, {
    ...(token !== undefined ? { token } : {}),
    ...(hubDataDir !== undefined ? { hubDataDir } : {}),
    kind: gatewayStateKind(deps, context.env),
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

/** node 监听描述（0.49 G1：`serve.port` 显式值，否则 8644）。 */
export interface NodeListenInfo {
  host: string;
  port: number;
  url: string;
}

export function nodeListenFromConfig(config: VesselConfig): NodeListenInfo {
  const host = (config.serve?.hostname ?? DEFAULT_SERVE_OPTIONS.hostname).trim();
  const { nodePort } = resolveGatewayNodePorts(config, 'gateway');
  const url = gatewayBaseUrl(
    {
      pid: 0,
      started_at: new Date(0).toISOString(),
      host,
      port: nodePort,
      version: '0',
    },
    config.serve?.tls !== undefined,
  );
  return { host, port: nodePort, url };
}

/**
 * 读取任意 PID 记录指向端口的 `/health`（GET，不发送 token）。
 * 0.49 G1：gateway 拆分模式的记录 host/port 是 **platform** 监听。
 */
export async function probeHttpHealth(
  record: GatewayPidRecord,
  timeoutMs = 800,
  tls = false,
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(`${gatewayBaseUrl(record, tls)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return isRecordValue(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

/** platform `/health` 的 `role` 是 CLI 区分平台监听与 node 监听的可判定字段。 */
export async function isPlatformRecord(record: GatewayPidRecord): Promise<boolean> {
  const health = await probeHttpHealth(record);
  return health?.role === 'platform';
}

/** `gateway status` 的本地节点投影（0.49 G3b；只读、无 token）。 */
export interface LocalNodeStatusView {
  node_id: string;
  name: string;
  api_url: string;
  status: 'up' | 'down' | 'unknown';
  auto_start: boolean;
}

/** 从 registry（或隐式单节点）解析本地节点的地址与健康；不读 token。 */
async function localNodeStatusViews(
  config: VesselConfig,
  env: Record<string, string | undefined>,
  gatewayDataDir: string,
): Promise<LocalNodeStatusView[]> {
  const load = await loadNodeRegistry(gatewayDataDir).catch(() => null);
  if (load === null) return [];
  const entries: NodeRegistryEntry[] =
    load.kind === 'ready'
      ? load.registry.nodes
      : [await synthesizeImplicitNode({ config, dataDir: gatewayDataDir })];

  return Promise.all(
    entries.map(async (entry): Promise<LocalNodeStatusView> => {
      const autoStart = entry.auto_start;
      if (entry.config_path === undefined) {
        const listen = nodeListenFromConfig(config);
        const health = await probeHttpHealth({
          pid: 0,
          started_at: new Date(0).toISOString(),
          host: listen.host,
          port: listen.port,
          version: '0',
        });
        return {
          node_id: entry.node_id,
          name: entry.name,
          api_url: listen.url,
          status: health !== undefined && health.role !== 'platform' ? 'up' : 'down',
          auto_start: autoStart,
        };
      }
      try {
        const loaded = await loadConfig({
          configPath: entry.config_path,
          env: { ...env, VESSEL_DATA_DIR: entry.data_dir },
        });
        const listen = nodeListenFromConfig(loaded.config);
        const health = await probeHttpHealth(
          {
            pid: 0,
            started_at: new Date(0).toISOString(),
            host: listen.host,
            port: listen.port,
            version: '0',
          },
          800,
          loaded.config.serve?.tls !== undefined,
        );
        return {
          node_id: entry.node_id,
          name: entry.name,
          api_url: listen.url,
          status: health !== undefined && health.role !== 'platform' ? 'up' : 'down',
          auto_start: autoStart,
        };
      } catch {
        return {
          node_id: entry.node_id,
          name: entry.name,
          api_url: '',
          status: 'unknown',
          auto_start: autoStart,
        };
      }
    }),
  );
}

/**
 * 0.49 G1：`gateway status --rpc` 是 node 侧 alias。PID 记录在 gateway 模式下指向
 * platform 时，把本地 target 换成 node 端口（否则 `/v1/rpc` 会落到平台 404）。
 */
async function adoptNodeTarget(
  target: ControlPlaneTarget,
  config: VesselConfig,
): Promise<ControlPlaneTarget> {
  if (target.record === undefined || !(await isPlatformRecord(target.record))) return target;
  const listen = nodeListenFromConfig(config);
  const token = resolveGatewayToken(config, process.env) ?? '';
  await target.close().catch(() => undefined);
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
    ...(target.instance !== undefined ? { instance: target.instance } : {}),
    record: target.record,
    request: (method, params) => client.request(method, params),
    close: () => client.close(),
  };
}

/** 0.49 G1：标出由 platform 监听的实例，用于展示 platform + node 两个监听。 */
async function platformInstances(entries: GatewayStateEntry[]): Promise<Set<string>> {
  const found = new Set<string>();
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.record === undefined) return;
      if (await isPlatformRecord(entry.record)) found.add(entry.instance);
    }),
  );
  return found;
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
  /** 0.49 G3b：缺省 node（`gateway.pid`）；platform 写 `platform.pid`。 */
  kind?: GatewayStateKind;
  /** 与实例锁共享的 started_at（epoch ms）；缺省取当前时间。 */
  startedAt?: number;
}): Promise<void> {
  const instance = normalizeGatewayInstance(options.instance);
  const kind = options.kind ?? 'node';
  const record: GatewayPidRecord = {
    pid: process.pid,
    started_at: new Date(options.startedAt ?? Date.now()).toISOString(),
    host: options.host,
    port: options.port,
    version: options.version ?? readPackageVersion(),
    ...(options.nodeId !== undefined ? { node_id: options.nodeId } : {}),
    ...(instance !== DEFAULT_GATEWAY_INSTANCE ? { instance } : {}),
  };
  await writeGatewayPid(options.dataDir, record, instance, kind);
  process.once('exit', () =>
    deleteRecordIfOwnedSync(gatewayPidPath(options.dataDir, instance, kind), {
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

  let failed = false;

  // 0.49 G3b（CONTRACT §4.3）：只终止本 Gateway spawn 的子进程。
  // 子进程先停，再停平台；adopt/external 不在 manifest 中，天然不受影响。
  if (gatewayStateKind(options, context.env) === 'platform') {
    const selectorSpecified =
      selector.instance !== undefined || selector.port !== undefined || selector.all === true;
    const instances =
      selector.all === true
        ? null
        : targets.entries.length > 0
          ? [...new Set(targets.entries.map((entry) => entry.instance))]
          : selectorSpecified
            ? [normalizeGatewayInstance(selector.instance)]
            : null;
    const cleanupTargets = instances ?? [undefined];
    for (const instance of cleanupTargets) {
      const result = await stopSpawnedChildren({
        gatewayDataDir: context.dataDir,
        ...(instance === undefined || selector.all === true
          ? { allInstances: true }
          : { instance }),
        platform: context.platform,
        ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
        ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      if (result.failed > 0) failed = true;
    }
  }

  if (targets.entries.length === 0) {
    print(ui.info(t('gateway.notRunning')));
    return failed ? 1 : 0;
  }

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
  platform = false,
): Record<string, unknown> {
  const record = entry.record;
  const pidFile = entry.pidPath ?? entry.lockPath ?? '';
  // 平台监听只有 http；node 监听才可能带 serve.tls。
  const tls = !platform && config.serve?.tls !== undefined;
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
      ...(platform ? { node: nodeListenFromConfig(config) } : {}),
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
  // 无选择器：服务查询与状态收集并行；有选择器时不启动 schtasks（提前返回）。
  const servicePromise = useSelection
    ? undefined
    : serviceStatus(context.platform, {
        dataDir: context.dataDir,
        ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
        ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
      });
  // collect 抛错时 service 不再被 await，挂空 catch 避免 unhandled rejection（错误语义不变）。
  servicePromise?.catch(() => undefined);
  const snapshot = await collectStateFor(context, options);
  const entries = snapshot.entries;
  // 0.49 G1：`gateway start` 的记录 host/port 是 platform 监听；附带 node 监听展示。
  const platforms = await platformInstances(entries);
  const stateKind = gatewayStateKind(options, context.env);
  // 0.49 G3b：多节点投影只读 registry + 各 node 健康；不含 token。
  const nodeViews =
    stateKind === 'platform'
      ? await localNodeStatusViews(context.config, context.env, context.dataDir)
      : [];
  let printedNodeViews = false;
  const printNodeViews = (): void => {
    if (printedNodeViews || nodeViews.length === 0) return;
    printedNodeViews = true;
    for (const node of nodeViews) {
      print(
        `  ${ui.dim(
          `node ${node.name}  ${node.api_url || '-'}  ${node.status}` +
            (node.auto_start ? '' : '  (auto_start: false)'),
        )}`,
      );
    }
  };

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
            instances: selected.map((entry) =>
              instanceStatusJson(entry, context.config, now, platforms.has(entry.instance)),
            ),
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
      if (platforms.has(entry.instance)) printNodeViews();
      const pidFile = entry.pidPath ?? entry.lockPath;
      if (pidFile !== undefined) print(`  ${ui.dim(pidFile)}`);
    }
    return allLive ? 0 : 1;
  }

  // 有选择器分支已在上面提前返回，此处 servicePromise 必然存在。
  const service = await (servicePromise as Promise<ServiceStatus>);
  const allLive = entries.length > 0 && entries.every(entryOccupied);
  const defaultEntry = findStateEntry(entries, DEFAULT_GATEWAY_INSTANCE);

  if (json) {
    // R2：无选择器 JSON schema 不变，仍按 default 实例输出（多实例机器视图用 list）。
    print(
      JSON.stringify(
        legacyStatusJson(
          defaultEntry,
          context,
          service,
          now,
          defaultEntry !== undefined && platforms.has(defaultEntry.instance),
          nodeViews,
          stateKind,
        ),
        null,
        2,
      ),
    );
    return allLive ? 0 : 1;
  }

  print(ui.title(t('gateway.status.title')));
  print(ui.rule(48));
  if (entries.length === 0) {
    print(ui.kv(t('gateway.status.status'), t('gateway.notRunning'), 10));
    print(
      `  ${ui.dim(
        t('gateway.status.pidFile', {
          path: gatewayPidPath(context.dataDir, undefined, stateKind),
        }),
      )}`,
    );
    return 1;
  }
  for (const entry of entries) {
    print(ui.kv(entry.instance, formatEntryState(entry, context.config), 12));
    if (platforms.has(entry.instance)) printNodeViews();
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
  platform = false,
  nodes: LocalNodeStatusView[] = [],
  stateKind: GatewayStateKind = 'node',
): Record<string, unknown> {
  const pidFile = entry?.pidPath ?? gatewayPidPath(context.dataDir, undefined, stateKind);
  if (entry?.record !== undefined && entry.state === 'running') {
    const record = entry.record;
    return {
      instance: DEFAULT_GATEWAY_INSTANCE,
      running: true,
      pid: record.pid,
      host: record.host,
      port: record.port,
      url: gatewayBaseUrl(record, stateKind === 'node' && context.config.serve?.tls !== undefined),
      started_at: record.started_at,
      uptime_seconds: Math.max(0, Math.floor((now() - Date.parse(record.started_at)) / 1000)),
      version: record.version,
      ...(record.node_id !== undefined ? { node_id: record.node_id } : {}),
      pid_file: pidFile,
      ...(platform ? { node: nodeListenFromConfig(context.config) } : {}),
      ...(platform && nodes.length > 0 ? { nodes } : {}),
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
    const target = await adoptNodeTarget(resolved.target, resolved.config);
    try {
      views.push(await collectRpcView(target, target.instance ?? 'default'));
    } finally {
      await target.close().catch(() => undefined);
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
      const target = await adoptNodeTarget(resolved.target, resolved.config);
      try {
        views.push(await collectRpcView(target, instance));
      } finally {
        await target.close().catch(() => undefined);
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
  const platforms = await platformInstances(entries);

  if (json) {
    print(
      JSON.stringify(
        {
          as_of: new Date(now()).toISOString(),
          instances: entries.map((entry) => ({
            ...instanceStatusJson(entry, context.config, now, platforms.has(entry.instance)),
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
    if (platforms.has(entry.instance)) {
      print(`  ${ui.dim(`node ${nodeListenFromConfig(context.config).url}`)}`);
    }
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

  // 0.49 G1（PLAN §9.1 裁决 2）：`gateway reload` 兼容主命令，实际调用 Node API
  // 现有的 `gateway.reload` RPC（node 端口 + node token）。无显式 node token 时
  // 按 node 回环匿名语义发送无 Authorization 请求，不在此提前失败。
  const nodeListen = nodeListenFromConfig(context.config);
  const token = resolveGatewayToken(context.config, context.env) ?? '';

  let failed = false;
  for (const entry of running) {
    if (entry.record === undefined) continue;
    const prefix = running.length > 1 ? `[${entry.instance}] ` : '';
    // gateway 拆分模式下 PID 记录指向 platform；reload 必须打到 node 端口。
    const record = (await isPlatformRecord(entry.record))
      ? { ...entry.record, host: nodeListen.host, port: nodeListen.port }
      : entry.record;
    const result = await reloadGateway({
      record,
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
  // 0.49 G1：父进程在 spawn 前拒绝 0 端口（含显式 `--port 0`），避免 daemon
  // 只留日志。legacy 逃生口（VESSEL_LEGACY_SERVE=1）仍允许系统分配。
  const portError =
    context.env.VESSEL_LEGACY_SERVE === '1'
      ? null
      : printSplitModePortError(
          context.config,
          'gateway',
          (line) => printErr(ui.err(line)),
          options.port,
        );
  if (portError !== null) return portError;
  const stateKind = gatewayStateKind(options, context.env);
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
    stateKind,
    // 平台要等每个 auto_start 节点就绪后才写 PID；节点 readiness 上限 20s，
    // 父进程等待必须覆盖“启动失败 → 平台回滚退出”的路径，避免过早硬杀。
    ...(stateKind === 'platform' ? { waitMs: 60_000 } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
  });

  if (result.ok) {
    // 平台监听只有 http（platform server 不带 TLS）。
    const url = gatewayBaseUrl(
      result.record,
      stateKind === 'node' && context.config.serve?.tls !== undefined,
    );
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

// ── 0.49 G3b：平台专用前台启动（gateway start/restart）──────────────
//
// 平台进程只做平台监听 + 本地 node 子进程监督；**不**加载 node runtime /
// tenant 锁 / plugin host / node 监听。`gateway start --daemon` 的父进程
// 通过 `platform.pid` 确认启动完成。

/** 与 `src/gateway/node-supervisor.ts` 共享的运行参数（组合根解析结果）。 */
interface ResolvedLocalNode {
  entry: NodeRegistryEntry;
  config: VesselConfig;
  listen: NodeListenInfo;
  token?: string;
  apiUrl: string;
}

/** node 配置 / 身份 / 端口校验失败（错误体不含 token）。 */
class LocalNodeStartError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LocalNodeStartError';
    this.code = code;
  }
}

function normalizeOriginHost(host: string): string {
  const normalized = host.trim();
  if (normalized === '0.0.0.0') return '127.0.0.1';
  if (normalized === '::' || normalized === '[::]') return '[::1]';
  if (normalized.includes(':') && !normalized.startsWith('[')) return `[${normalized}]`;
  return normalized;
}

function nodeOriginOf(host: string, port: number, tls: boolean): string {
  return `${tls ? 'https' : 'http'}://${normalizeOriginHost(host)}:${port}`;
}

/**
 * 平台页面的浏览器 Origin 列表（0.50）：平台永远是 http 监听，回环/通配绑定下
 * 用户可能用 `127.0.0.1` / `localhost` / `[::1]` 任一地址打开页面，三种都注入；
 * 具体非通配 host 只注入它自己。只产出合法 `scheme://host[:port]` origin。
 */
function platformBrowserOrigins(host: string, port: number): string[] {
  const normalized = host.trim().toLowerCase();
  const loopbackish =
    normalized === '' ||
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '[::]';
  if (!loopbackish) return [nodeOriginOf(host, port, false)];
  return [
    nodeOriginOf('127.0.0.1', port, false),
    nodeOriginOf('localhost', port, false),
    nodeOriginOf('::1', port, false),
  ];
}

async function preparePlatformStart(options: {
  config: VesselConfig;
  dataDir: string;
  env: Record<string, string | undefined>;
  instance: string;
  collectState?: typeof collectGatewayState;
}): Promise<{ ok: true; lock: GatewayInstanceLock } | { ok: false; error: string }> {
  const token = resolveGatewayToken(options.config, options.env);
  const snapshot = await (options.collectState ?? collectGatewayState)(options.dataDir, {
    kind: 'platform',
    ...(token !== undefined ? { token } : {}),
  });
  const entry = findStateEntry(snapshot.entries, options.instance);
  if (entry !== undefined && entryOccupied(entry)) {
    return {
      ok: false,
      error: t('gateway.alreadyRunningPid', { pid: entryPid(entry) ?? 0 }),
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
    await cleanupGatewayStateEntry(options.dataDir, entry).catch(() => undefined);
  }
  // CONTRACT §4.6（FROZEN r4）：同实例重复启动仍由
  // `platform-<instance>.lock` 拦截；不同实例各有 PID/锁，不新增全局拒绝。
  try {
    const lock = await acquireGatewayInstanceLock({
      dataDir: options.dataDir,
      instance: options.instance,
      kind: 'platform',
    });
    return { ok: true, lock };
  } catch (error) {
    if (error instanceof GatewayInstanceLockedError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/**
 * 解析 registry 中全部本地 node：每节点独立 config / data_dir / identity / port /
 * token。隐式单节点不触发平台 token 冲突（CONTRACT §3 / §9）；端口冲突、身份
 * 不一致、config 不可读一律 fail-fast。
 */
async function resolveLocalNodes(options: {
  config: VesselConfig;
  env: Record<string, string | undefined>;
  gatewayDataDir: string;
  platformPort: number;
  platformToken?: string;
}): Promise<ResolvedLocalNode[]> {
  let load: Awaited<ReturnType<typeof loadNodeRegistry>>;
  try {
    load = await loadNodeRegistry(options.gatewayDataDir);
  } catch (error) {
    if (error instanceof NodeRegistryError) {
      throw new LocalNodeStartError(error.code, error.message);
    }
    throw error;
  }

  const entries: NodeRegistryEntry[] =
    load.kind === 'ready'
      ? load.registry.nodes
      : [
          await synthesizeImplicitNode({
            config: options.config,
            dataDir: options.gatewayDataDir,
          }),
        ];

  const seenPorts = new Map<number, string>();
  const resolved: ResolvedLocalNode[] = [];

  for (const entry of entries) {
    const implicit = entry.config_path === undefined;
    let nodeConfig: VesselConfig;
    let token: string | undefined;
    let listen: NodeListenInfo;

    if (implicit) {
      // 隐式单节点：全局配置 + G1 同 token 行为（允许与平台同源）。
      nodeConfig = options.config;
      token = resolveGatewayToken(options.config, options.env);
      listen = nodeListenFromConfig(options.config);
    } else {
      const configPath = entry.config_path as string;
      const loaded = await loadConfig({
        configPath,
        env: { ...options.env, VESSEL_DATA_DIR: entry.data_dir },
      });
      if (loaded.validation.errors.length > 0) {
        const first = loaded.validation.errors[0];
        const detail = first !== undefined ? `${first.path}: ${first.message}` : 'invalid config';
        throw new LocalNodeStartError(
          'registry_invalid',
          `node "${entry.name}": config validation failed: ${detail}`,
        );
      }
      nodeConfig = loaded.config;
      try {
        assertNodeDataDirMatches({
          dataDir: entry.data_dir,
          nodeConfig,
          env: options.env,
        });
        const identity = await resolveNodeIdForRegistryAdd({
          nodeConfig,
          dataDir: entry.data_dir,
        });
        if (identity !== entry.node_id) {
          throw new LocalNodeStartError(
            'node_identity_mismatch',
            `node "${entry.name}": registry node_id ${entry.node_id} does not match the node identity (${identity})`,
          );
        }
      } catch (error) {
        if (error instanceof LocalNodeStartError) throw error;
        if (error instanceof NodeRegistryError) {
          throw new LocalNodeStartError(error.code, `node "${entry.name}": ${error.message}`);
        }
        throw error;
      }
      token = resolveGatewayToken(nodeConfig, options.env);
      listen = nodeListenFromConfig(nodeConfig);

      // 仅显式 registry 节点受平台 token 冲突约束。
      const conflict = checkPlatformTokenConflict({
        platformToken: options.platformToken,
        nodeToken: token,
      });
      if (conflict !== null) {
        throw new LocalNodeStartError(
          'platform_token_conflict',
          `node "${entry.name}" uses the same effective token as the platform gateway`,
        );
      }
    }

    const nodePort = listen.port;
    if (!Number.isInteger(nodePort) || nodePort <= 0) {
      throw new LocalNodeStartError(
        'node_port_conflict',
        `node "${entry.name}": serve.port must be a fixed non-zero port`,
      );
    }
    if (options.platformPort !== 0 && nodePort === options.platformPort) {
      throw new LocalNodeStartError(
        'node_port_conflict',
        `node "${entry.name}": port ${nodePort} conflicts with the platform gateway port`,
      );
    }
    if (nodePort === HUB_DEFAULT_PORT) {
      throw new LocalNodeStartError(
        'node_port_conflict',
        `node "${entry.name}": port ${nodePort} conflicts with the Hub default port`,
      );
    }
    const otherName = seenPorts.get(nodePort);
    if (otherName !== undefined) {
      throw new LocalNodeStartError(
        'node_port_conflict',
        `node "${entry.name}": port ${nodePort} conflicts with node "${otherName}"`,
      );
    }
    seenPorts.set(nodePort, entry.name);

    resolved.push({
      entry,
      config: nodeConfig,
      listen,
      ...(token !== undefined ? { token } : {}),
      apiUrl: nodeOriginOf(listen.host, nodePort, nodeConfig.serve?.tls !== undefined),
    });
  }

  return resolved;
}

function waitForTerminationSignal(): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export interface PlatformGatewayForegroundOptions {
  command: Extract<GatewayCommand, { kind: 'start' | 'restart' }>;
  /** 已构建的 WebUI 目录（必须含 `index.html`）。 */
  staticDir: string;
  env?: Record<string, string | undefined>;
  /** `--data-dir` 显式覆盖（高于 env/config）。 */
  dataDirOverride?: string;
  platform?: NodeJS.Platform;
  version?: string;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  spawn?: typeof Bun.spawn;
  sleep?: (ms: number) => Promise<void>;
  runCommand?: CommandRunner;
  readinessTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** 测试 seam：等待退出；缺省等待 SIGINT/SIGTERM。 */
  waitForStop?: () => Promise<void>;
}

/**
 * 平台专用前台入口：`vessel gateway start/restart`（非 legacy）。
 *
 * 不进入 bootstrap / serve 管线，因此不会加载 node runtime、tenant 锁、
 * plugin host 或 node 监听。启动顺序：平台 bind → spawn auto_start 节点 →
 * 等待每个节点的 `gateway.pid` + `/health` → 写 `platform.pid`。
 * 任一节点失败 → 停已 spawn 子进程并停平台，不写平台 PID。
 */
export async function runPlatformGatewayForeground(
  options: PlatformGatewayForegroundOptions,
): Promise<number> {
  const startupStartedAt = performance.now();
  const env = options.env ?? process.env;
  const print = options.print ?? console.log;
  const printErr = options.printErr ?? console.error;
  const platform = options.platform ?? process.platform;
  const version = options.version ?? readPackageVersion();

  let config: VesselConfig;
  try {
    const loaded = await loadConfig({
      env,
      ...(options.dataDirOverride !== undefined
        ? { cliOverrides: { dataDir: options.dataDirOverride } }
        : {}),
    });
    if (loaded.validation.errors.length > 0) {
      printErr(formatConfigErrors(loaded.validation.errors));
      return 2;
    }
    config = loaded.config;
  } catch (error) {
    printErr(ui.err(`config_load_failed: ${errorMessage(error)}`));
    return 1;
  }
  const dataDir = resolveDataDir(config, env);

  const command = options.command;
  let targetInstance = command.instance;
  let targetPort = command.kind === 'start' ? command.port : undefined;
  let targetHost = command.kind === 'start' ? command.host : undefined;

  if (command.kind === 'restart') {
    const entries = (await collectGatewayState(dataDir, { kind: 'platform' })).entries;
    const targets = await resolveGatewayTargets(dataDir, command, { entries });
    if (!targets.ok) {
      printErr(ui.err(targets.error));
      return 1;
    }
    const previous = targets.entries[0];
    if (previous !== undefined) {
      targetInstance = previous.instance;
      if (previous.record !== undefined) {
        targetPort = previous.record.port;
        targetHost = previous.record.host;
      }
    }
    const stopCode = await stopGateway({
      config,
      dataDir,
      env,
      platform,
      version,
      selector: command,
      entries,
      stateKind: 'platform',
      print,
      printErr,
      timeoutMs: 10_000,
    });
    if (stopCode !== 0) return stopCode;
  }

  const portError = printSplitModePortError(
    config,
    'gateway',
    (line) => printErr(ui.err(line)),
    command.kind === 'start' ? command.port : undefined,
  );
  if (portError !== null) return portError;

  const instance = deriveGatewayInstance(targetInstance, targetPort);

  // CONTRACT §4.6（FROZEN r4）已知限制：隐式节点与平台共用 dataDir 的
  // `gateway.pid` / `gateway-default.lock`。同 dataDir 已有另一个存活平台实例时
  // fail-fast（`implicit_node_conflict`），只读检查，不碰对方的 PID/锁。
  // 显式 registry 共享同一 dataDir 的多平台实例属于未支持形态（不新增固定 PID
  // workaround；见 §4.6）。
  let implicitNode = false;
  try {
    implicitNode = (await loadNodeRegistry(dataDir)).kind === 'missing';
  } catch (error) {
    if (error instanceof NodeRegistryError) {
      printErr(ui.err(`${error.code}: ${error.message}`));
      return 1;
    }
    throw error;
  }
  if (implicitNode) {
    const probeToken = resolvePlatformToken(config, env);
    const snapshot = await collectGatewayState(dataDir, {
      kind: 'platform',
      ...(probeToken !== undefined ? { token: probeToken } : {}),
    });
    const other = snapshot.entries.find(
      (entry) => entry.instance !== instance && entryOccupied(entry),
    );
    if (other !== undefined) {
      printErr(
        ui.err(
          `implicit_node_conflict: platform instance "${other.instance}" is already running in ${dataDir}; ` +
            'implicit nodes share gateway.pid/gateway-default.lock. Stop it or register explicit nodes.',
        ),
      );
      return 1;
    }
  }

  const prepared = await preparePlatformStart({ config, dataDir, env, instance });
  if (!prepared.ok) {
    printErr(ui.err(prepared.error));
    return 1;
  }
  const lock = prepared.lock;

  let platformGateway: ReturnType<typeof startPlatformGateway> | undefined;
  let supervisor: NodeSupervisor | undefined;
  try {
    const platformHostname = (
      targetHost ??
      config.gateway?.hostname ??
      DEFAULT_GATEWAY_OPTIONS.hostname
    ).trim();
    const platformPort = targetPort ?? config.gateway?.port ?? DEFAULT_GATEWAY_OPTIONS.port;
    const platformToken = resolvePlatformToken(config, env);
    // 0.50：本地 Hub 默认随 gateway 自动拉起（`hub.auto_start: false` 关闭）。
    // `direction: 'node'` 的 gateway 是出站加入远端 Hub，不再起一个空本地 Hub。
    const hubConfig = config.hub;
    const hubAutoStart = hubConfig?.autoStart !== false && hubConfig?.direction !== 'node';
    const hubHostname = (hubConfig?.listen?.hostname ?? HUB_DEFAULT_HOSTNAME).trim();
    const hubPort = hubConfig?.listen?.port ?? HUB_DEFAULT_PORT;

    if (!existsSync(path.join(options.staticDir, 'index.html'))) {
      printErr(ui.err(t('gateway.webDistMissing', { path: options.staticDir })));
      return 1;
    }

    let nodes: ResolvedLocalNode[];
    try {
      nodes = await resolveLocalNodes({
        config,
        env,
        gatewayDataDir: dataDir,
        platformPort,
        ...(platformToken !== undefined ? { platformToken } : {}),
      });
    } catch (error) {
      if (error instanceof LocalNodeStartError || error instanceof NodeRegistryError) {
        printErr(ui.err(`${error.code}: ${error.message}`));
        return 1;
      }
      printErr(ui.err(`node_start_failed: ${errorMessage(error)}`));
      return 1;
    }

    const credentials = new Map<string, string | undefined>(
      nodes.map((node) => [node.entry.node_id, node.token]),
    );
    const singleNodeId = nodes.length === 1 ? nodes[0]?.entry.node_id : undefined;

    try {
      platformGateway = startPlatformGateway({
        port: platformPort,
        hostname: platformHostname,
        ...(platformToken !== undefined ? { platformToken } : {}),
        ...(config.gateway?.allowedOrigins !== undefined
          ? { allowedOrigins: config.gateway.allowedOrigins }
          : {}),
        nodeOrigins: [...new Set(nodes.map((node) => node.apiUrl))],
        // 0.50：Hub 页浏览器直连 Hub，CSP `connect-src` 必须放行 Hub origin。
        ...(Number.isInteger(hubPort) && hubPort > 0
          ? { hubOrigins: platformBrowserOrigins(hubHostname, hubPort) }
          : {}),
        staticDir: options.staticDir,
        nodes: nodes.map((node) => ({
          nodeId: node.entry.node_id,
          name: node.entry.name,
          apiUrl: node.apiUrl,
        })),
        resolveNodeCredential: (nodeId?: string) => {
          const id = nodeId ?? singleNodeId;
          if (id === undefined || !credentials.has(id)) return { found: false };
          const token = credentials.get(id);
          return token !== undefined ? { found: true, token } : { found: true };
        },
        version,
      });
    } catch (error) {
      printErr(ui.err(`Platform gateway failed to start: ${errorMessage(error)}`));
      return 1;
    }

    supervisor = new NodeSupervisor({
      gatewayDataDir: dataDir,
      instance,
      env,
      platform,
      // 0.50：平台始终 http 监听；把页面 Origin 注入本地子 Node 的 CORS 白名单。
      platformOrigins: platformBrowserOrigins(platformHostname, platformGateway.port),
      ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
      ...(options.readinessTimeoutMs !== undefined
        ? { readinessTimeoutMs: options.readinessTimeoutMs }
        : {}),
      ...(options.stopTimeoutMs !== undefined ? { stopTimeoutMs: options.stopTimeoutMs } : {}),
    });
    const specs: LocalNodeSpec[] = nodes.map((node) => ({
      nodeId: node.entry.node_id,
      name: node.entry.name,
      dataDir: node.entry.data_dir,
      apiUrl: node.apiUrl,
      host: node.listen.host,
      port: node.listen.port,
      ...(node.entry.config_path !== undefined ? { configPath: node.entry.config_path } : {}),
      ...(node.token !== undefined ? { token: node.token } : {}),
      autoStart: node.entry.auto_start,
    }));
    const started = await supervisor.start(specs);
    if (!started.ok) {
      printErr(ui.err(`${started.code}: ${started.message}`));
      await platformGateway?.stop().catch(() => undefined);
      platformGateway = undefined;
      return 1;
    }

    // 0.50：本地 Hub 是独立进程；启动失败只 warning，不阻断 gateway。
    // 手工/外部启动的 Hub 走 adopt，不记 manifest（`gateway stop` 不会杀它）。
    let hubStarted: { url: string; adopted: boolean } | undefined;
    if (hubAutoStart) {
      const hubDataDir =
        hubConfig?.dataDir !== undefined
          ? path.resolve(expandHome(hubConfig.dataDir))
          : path.join(dataDir, 'hub');
      const hub = await supervisor.startHub({ dataDir: hubDataDir });
      if (hub.ok) {
        hubStarted = { url: hub.url, adopted: hub.adopted };
      } else {
        printErr(ui.warn(`${hub.code}: ${hub.message}`));
      }
    }

    try {
      await writeForegroundGatewayPid({
        dataDir,
        host: platformHostname,
        port: platformGateway.port,
        version,
        instance,
        kind: 'platform',
        startedAt: lock.startedAt,
      });
    } catch (error) {
      printErr(
        ui.err(
          `failed to write ${gatewayPidPath(dataDir, instance, 'platform')}: ` +
            errorMessage(error),
        ),
      );
      await supervisor.stop().catch(() => undefined);
      await platformGateway?.stop().catch(() => undefined);
      platformGateway = undefined;
      return 1;
    }

    const platformUrl = nodeOriginOf(platformHostname, platformGateway.port, false);
    // 0.50：前台 TTY 输出 Vite 风格摘要；daemon 子进程 stdout 重定向到日志
    // （非 TTY），保持既有逐行日志不变。显式注入 `print` 的嵌入方按交互处理。
    const interactive = options.print !== undefined || process.stdout.isTTY === true;
    if (interactive) {
      const hub: PlatformStartupHub =
        hubStarted !== undefined
          ? {
              state: hubStarted.adopted ? 'adopted' : 'auto-started',
              url: hubStarted.url !== '' ? hubStarted.url : 'running',
            }
          : hubAutoStart
            ? { state: 'unavailable' }
            : { state: 'disabled' };
      print(
        renderPlatformStartup({
          version,
          platformUrl,
          nodes: nodes.map((node) => ({
            name: node.entry.name,
            url: node.apiUrl,
            autoStart: node.entry.auto_start,
          })),
          hub,
          readyMs: Math.max(0, Math.round(performance.now() - startupStartedAt)),
          stopHint: t('cli.gatewayRunning'),
        }),
      );
    } else {
      print(ui.ok(t('gateway.started', { pid: process.pid, url: platformUrl })));
      for (const node of nodes) {
        print(
          ui.dim(
            `node ${node.entry.name}  ${node.apiUrl}` +
              (node.entry.auto_start ? '' : '  (auto_start: false)'),
          ),
        );
      }
      if (hubStarted !== undefined) {
        const detail = hubStarted.url !== '' ? hubStarted.url : 'running';
        print(ui.dim(`hub ${detail}${hubStarted.adopted ? '  (adopted)' : ''}`));
      }
    }

    await (options.waitForStop ?? waitForTerminationSignal)();
    await supervisor.stop().catch(() => undefined);
    await platformGateway?.stop().catch(() => undefined);
    platformGateway = undefined;
    return 0;
  } finally {
    // 失败路径也必须释放平台实例锁；PID 只在全部就绪后写入。
    await supervisor?.stop().catch(() => undefined);
    await platformGateway?.stop().catch(() => undefined);
    await lock.release().catch(() => undefined);
  }
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
export function isForegroundGatewayCommand(
  command: GatewayCommand,
): command is Extract<GatewayCommand, { kind: 'start' | 'restart' }> {
  return (command.kind === 'start' || command.kind === 'restart') && command.daemon === false;
}
