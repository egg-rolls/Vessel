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
import { withDeadline } from '@vessel-agent/core';
import {
  type ConfigValidationError,
  checkPlatformTokenConflict,
  DEFAULT_GATEWAY_OPTIONS,
  DEFAULT_SERVE_OPTIONS,
  getUserConfigDir,
  loadConfig,
  resolveAuthSettings,
  resolveGatewayNodePorts,
  resolvePlatformProxySecret,
  type VesselConfig,
} from '../../../../packages/config/src/index';
import {
  formatEventLine,
  platformListenGuard,
  startPlatformGateway,
} from '../../../../packages/serve/src/index';
import { formatConfigErrors } from '../../../config/config-error-format';
import { expandHome, resolveDataDir } from '../../../data/data-paths';
import { gatewayLogPath, startGatewayDaemon } from '../../../gateway/daemon';
import {
  isHumanTerminal,
  type PlatformStartupHub,
  renderPlatformStartup,
} from '../../../gateway/gateway-banner';
import {
  clearHandoffMarker,
  consumeHandoffMarker,
  writeHandoffMarker,
} from '../../../gateway/handoff';
import {
  acquireGatewayInstanceLock,
  type GatewayInstanceLock,
  GatewayInstanceLockedError,
} from '../../../gateway/instance-lock';
import {
  assertNodeDataDirMatches,
  loadNodeRegistry,
  type NodeRegistryEntry,
  NodeRegistryError,
  resolveNodeIdForRegistryAdd,
  synthesizeImplicitNode,
} from '../../../gateway/node-registry';
import {
  type HubSupervisorBeginResult,
  type LocalNodeSpec,
  NodeSupervisor,
  type StoppedChildDetail,
  type SupervisedNodeInfo,
  stopSpawnedChildren,
} from '../../../gateway/node-supervisor';
import {
  type CommandRunner,
  cleanupGatewayStateEntry,
  collectGatewayState,
  createCommandRunner,
  DEFAULT_GATEWAY_INSTANCE,
  deleteRecordIfOwnedSync,
  GATEWAY_DAEMON_ENV,
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
  readGatewayPidRecord,
  writeGatewayPid,
} from '../../../gateway/pid';
import { createPoolSupervisor, type PoolSupervisor } from '../../../gateway/pool-supervisor';
import {
  gatewayBaseUrl,
  reloadGateway,
  type ShutdownGatewayResult,
  shutdownGateway,
} from '../../../gateway/reload';
import {
  installService,
  resolveServiceTarget,
  type ServiceStatus,
  serviceStatus,
  uninstallService,
} from '../../../gateway/service';
import { resolveGatewayToken } from '../../../gateway/transport-factory';
import {
  readWatchdogSnapshot,
  resolveStallWatchdogConfig,
  type StallWatchdogConfig,
  type WatchdogEvent,
} from '../../../gateway/watchdog';
import {
  inspectWebDist,
  interruptBuildOfStoppedHost,
  interruptWebBuild,
  readLatestWebBuildRecord,
  recheckWebDist,
  webDistBuildState,
  webDistProbe,
  webDistStaleLine,
  webDistWarning,
} from '../../../gateway/web-dist';
import { readHubDerivedOrigins } from '../../../hub/derive-origins';
import { readHubLockFile } from '../../../hub/runtime';
import { HUB_DEFAULT_HOSTNAME, HUB_DEFAULT_PORT } from '../../../hub/server';
import { t } from '../../../i18n';
// 0.56：派生 token（显式配置永远优先；未配置时自动派生，绝不再「未配置就挂」）。
import { effectiveNodeToken, effectivePlatformToken } from '../../../node/token-derive';
import { createHttpRpcClient } from '../../../rpc/http-client';
import { readPackageVersion } from '../../../shared/version';
import type { GatewayCommand, GatewayInstallTarget, GatewaySelector } from '../../args';
import { type ControlPlaneTarget, resolveControlPlaneTarget } from '../../control-plane-target';
import { ui } from '../../output';

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
  let config: VesselConfig;
  if (deps.config !== undefined) {
    config = deps.config;
  } else {
    const loaded = await loadConfig();
    config = loaded.config;
    // 0.56：配置层警告（`serve:` 已改名 `node:`、`node:`/`serve:` 同时出现等）
    // 必须在 gateway 上也可见 —— 否则只有 REPL / `config show` 会提示，运维看不到。
    for (const warning of loaded.validation.warnings) {
      (deps.printErr ?? console.error)(ui.warn(`⚠ ${warning.message}`));
    }
  }
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

/**
 * 节点状态行的尾注（0.55）：原因 + 耗时/时刻 + pid。
 *
 * 「节点没起来必须看得见」——失败不能静默跳过：一行里同时给出**状态**、**稳定
 * 错误码/原因**、**什么时候**发生的。不含 token（`LocalNodeSpec.token` 不在这里）。
 */
function describeNodeState(info: SupervisedNodeInfo): string {
  const parts: string[] = [];
  if (info.reason !== undefined) parts.push(info.reason);
  if (info.state === 'ready' || info.state === 'failed') {
    parts.push(`after ${info.elapsedMs} ms`);
  }
  if (info.state === 'failed') parts.push(`at ${info.since}`);
  if (info.pid !== undefined) parts.push(`pid ${info.pid}`);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
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
          { path: 'node.port', value: config.node?.port },
        ]
      : [{ path: 'node.port', value: config.node?.port }];
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

/**
 * 0.55 P0：平台监听的 fail-closed 预检（在 spawn / bind / 停旧实例之前）。
 *
 * 非回环 + 没配 `gateway.token` ⇒ 返回可直接照做的多行说明；`null` = 放行。
 * 与 node / hub 的非回环守卫同口径；回环监听一律放行（本仓自己的启动路径不受影响）。
 */
function platformListenError(
  config: VesselConfig,
  env: Record<string, string | undefined>,
  hostname: string | undefined,
  port: number | undefined,
  dataDir: string,
): string | null {
  // 0.56：先解析**生效**平台 token（显式 > 派生）。派生值让「非回环必须有 token」
  // 这条前置自动成立；根密钥不可用（权限过宽等）时直接给出可操作原因。
  const resolved = effectivePlatformToken({ config, dataDir, env });
  if (!resolved.ok) return `${resolved.code}: ${resolved.message}`;
  return platformListenGuard({
    hostname: hostname ?? config.gateway?.hostname ?? DEFAULT_GATEWAY_OPTIONS.hostname,
    port: port ?? config.gateway?.port ?? DEFAULT_GATEWAY_OPTIONS.port,
    platformToken: resolved.value.token,
  });
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
  const host = (config.node?.hostname ?? DEFAULT_SERVE_OPTIONS.hostname).trim();
  const { nodePort } = resolveGatewayNodePorts(config, 'gateway');
  const url = gatewayBaseUrl(
    {
      pid: 0,
      started_at: new Date(0).toISOString(),
      host,
      port: nodePort,
      version: '0',
    },
    config.node?.tls !== undefined,
  );
  return { host, port: nodePort, url };
}

/**
 * 「活进程自己写的地址」优先于「配置推出来的地址」。
 *
 * 依据：`<nodeDataDir>/gateway.pid` 是那个**正在跑的进程自己**落的监听地址。
 * adopt 探活、`gateway status` 的节点投影、平台代理的 `api_url` 都必须打「实际在跑的
 * 那一个」，否则配置与记录不一致时（换过 `node.port`、换过 cwd/project 配置重启、
 * 端口被系统分配过）会出现两个后果：
 * - 探活打到**别人的进程**上，健康回包里的 `node_id` 不是本节点 ⇒ supervisor 把活着
 *   的节点标 `node_identity_mismatch` / `failed`，平台在却没有任何可用节点（用户看到
 *   的就是「进程还在，但什么都不动」）；
 * - 状态页把别人的 node 显示成「自己的 node up」。
 *
 * 只在记录**活着**且 `node_id` 不冲突时采用；其余一律回落到配置（不猜、不改记录）。
 */
export async function preferLiveNodeListen(
  nodeDataDir: string,
  fallback: NodeListenInfo,
  options: { nodeId?: string; tls?: boolean } = {},
): Promise<{ listen: NodeListenInfo; source: 'record' | 'config'; pid?: number }> {
  const record = await readGatewayPidRecord(nodeDataDir).catch(() => null);
  if (record === null || !isProcessAlive(record.pid)) {
    return { listen: fallback, source: 'config' };
  }
  if (
    options.nodeId !== undefined &&
    record.node_id !== undefined &&
    record.node_id !== options.nodeId
  ) {
    // 记录属于另一个 node（身份冲突）：不采用，留给既有 node_identity_mismatch 判据。
    return { listen: fallback, source: 'config' };
  }
  if (!Number.isInteger(record.port) || record.port <= 0) {
    return { listen: fallback, source: 'config' };
  }
  const host = record.host.trim() === '' ? fallback.host : record.host;
  return {
    listen: {
      host,
      port: record.port,
      url: gatewayBaseUrl(
        { pid: record.pid, started_at: record.started_at, host, port: record.port, version: '0' },
        options.tls === true,
      ),
    },
    source: 'record',
    pid: record.pid,
  };
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
    // 0.64：探活/停服的 CLI 路径没有别的定时器陪着，`AbortSignal.timeout` 在 bun 1.3.9
    // 上可能不触发 ⇒ 换会真正触发的截止时间。
    const response = await withDeadline(timeoutMs, async (signal) =>
      fetch(`${gatewayBaseUrl(record, tls)}/health`, { signal }),
    );
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
// 0.52 handoff：`gateway status --json` 属契约面，**不**加 adopted 字段；「这个 node 是
// 新平台 adopt 来的（不是它 spawn 的）」只在启动输出/日志里以 `(adopted)` 表达，
// 数据源就是 supervisor 既有的 `spawned` / `state === 'external'`。

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
        const live = await preferLiveNodeListen(entry.data_dir, nodeListenFromConfig(config), {
          ...(entry.node_id !== undefined ? { nodeId: entry.node_id } : {}),
          tls: config.node?.tls !== undefined,
        });
        const listen = live.listen;
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
        const live = await preferLiveNodeListen(
          entry.data_dir,
          nodeListenFromConfig(loaded.config),
          {
            ...(entry.node_id !== undefined ? { nodeId: entry.node_id } : {}),
            tls: loaded.config.node?.tls !== undefined,
          },
        );
        const listen = live.listen;
        const health = await probeHttpHealth(
          {
            pid: 0,
            started_at: new Date(0).toISOString(),
            host: listen.host,
            port: listen.port,
            version: '0',
          },
          800,
          loaded.config.node?.tls !== undefined,
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
 * 平台层不在监听时，「还有谁在跑」的唯一可信来源：各 node 自己的 `gateway.pid`。
 *
 * 为什么需要：`gateway restart`（缺省 handoff）会先停平台层、node/hub 原样留着等新平台
 * adopt。这段时间里 `collectGatewayState` 只有 **0 个条目**（旧平台已释放、新平台还没建
 * 锁），于是 `gateway status` 会说「未运行」—— 事实是「平台层在换手，会话还在 node 上跑」。
 * 一句话说反了，用户就会以为整个 gateway 没了/卡死了（0.59 事故口径）。
 *
 * 只读既有运行时文件（`gateway.pid` / `hub.lock` / `nodes.json`），不新增状态实体。
 */
export interface LiveNodeSurvivor {
  name: string;
  pid: number;
  url: string;
  auto_start: boolean;
}

async function liveNodeSurvivors(options: {
  config: VesselConfig;
  gatewayDataDir: string;
}): Promise<LiveNodeSurvivor[]> {
  let entries: NodeRegistryEntry[];
  try {
    const load = await loadNodeRegistry(options.gatewayDataDir);
    entries =
      load.kind === 'ready'
        ? load.registry.nodes
        : [
            await synthesizeImplicitNode({
              config: options.config,
              dataDir: options.gatewayDataDir,
            }),
          ];
  } catch {
    return [];
  }
  const survivors: LiveNodeSurvivor[] = [];
  for (const entry of entries) {
    const record = await readGatewayPidRecord(entry.data_dir).catch(() => null);
    if (record === null || !isProcessAlive(record.pid)) continue;
    if (
      entry.node_id !== undefined &&
      record.node_id !== undefined &&
      record.node_id !== entry.node_id
    ) {
      continue;
    }
    survivors.push({
      name: entry.name,
      pid: record.pid,
      url: gatewayBaseUrl(record, false),
      auto_start: entry.auto_start,
    });
  }
  return survivors;
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

/**
 * restart 保持运行模式：未显式 `--daemon` 时，读目标实例 pid record 的 `daemon`
 * 标记决定本次 restart 走前台还是后台。**必须在 cli.ts 分发之前调用**（前台 /
 * daemon 两条路由按 `daemon === false` 分流）。
 *
 * 缺省回落前台（false）：无匹配实例 / lock-only 无 record / 旧记录无标记 /
 * 配置或状态读取失败 —— 与历史行为一致，旧 gateway restart 不炸。
 * 这里不打印配置警告（随后真正执行的命令会打印），也不做 health 探测
 * （模式只取决于 record 字段，与实例是否 running 无关）。
 */
export async function resolveRestartDaemonMode(
  command: Extract<GatewayCommand, { kind: 'restart' }>,
  deps: GatewayCommandDeps = {},
): Promise<boolean> {
  try {
    const env = deps.env ?? process.env;
    const config = deps.config ?? (await loadConfig()).config;
    const dataDir = deps.dataDir ?? resolveDataDir(config, env);
    const collect = deps.collectState ?? collectGatewayState;
    const entries = (await collect(dataDir, { kind: gatewayStateKind(deps, env) })).entries;
    const targets = await resolveGatewayTargets(dataDir, command, { entries });
    if (!targets.ok) return false;
    return targets.entries[0]?.record?.daemon === true;
  } catch {
    return false;
  }
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
          url: gatewayBaseUrl(entry.record, config.node?.tls !== undefined),
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
  /** 运行模式：本进程是否 `start --daemon` 分离出的后台子进程（restart 保持模式用）。 */
  daemon?: boolean;
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
    ...(options.daemon !== undefined ? { daemon: options.daemon } : {}),
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
    /**
     * 0.55.2：「停平台层时要不要连 node/hub 一起停」。
     *
     * - 缺省（undefined / true）= **只停平台层**：node/hub 继续跑（它们身上可能跑着会话，
     *   杀掉不可恢复），留给下一次 `gateway start` 按既有 adopt 判据接管。
     * - `false`（`--stop-nodes`）= 连本机 spawn/接管、且归属可复核的 node/hub 一起停。
     *
     * `stop` 与 `restart` 同口径：破坏性动作要显式。`--no-keep-nodes`（0.55 写法）与
     * `--keep-nodes`（0.52 写法）都保留为别名。见 `src/gateway/handoff.ts`。
     */
    keepNodes?: boolean;
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
  const stateKind = gatewayStateKind(options, context.env);
  // 0.55：缺省 = 只停平台层（node/hub 继续跑）；`--no-keep-nodes` 才是整体关闭。
  const keepForHandoff = options.keepNodes !== false && stateKind === 'platform';
  let keptNodes = 0;
  let keptHubs = 0;
  const stoppedChildren: StoppedChildDetail[] = [];
  const failedChildren: StoppedChildDetail[] = [];

  // 0.49 G3b（CONTRACT §4.3）：只终止本 Gateway spawn 的子进程。
  // 子进程先停，再停平台；adopt/external 不在 manifest 中，天然不受影响。
  // 0.52/0.55：`keepForHandoff`（缺省）= **一个都不终止**，只清点并保留，
  // 交给下一次 `gateway start` adopt。见 `src/gateway/handoff.ts`。
  if (stateKind === 'platform') {
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
        ...(keepForHandoff ? { keep: true } : {}),
        ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
        ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        // P0-run-stops P4：node 没 drain 成被强杀时，停止方代打一行结构化日志。
        onDrainSkipped: (info) =>
          printErr(
            ui.warn(
              formatEventLine('node.drain.skipped', {
                name: info.name,
                pid: info.pid,
                reason: info.reason,
              }),
            ),
          ),
      });
      if (result.failed > 0) failed = true;
      keptNodes += result.kept?.nodes ?? 0;
      keptHubs += result.kept?.hubs ?? 0;
      stoppedChildren.push(...(result.stoppedChildren ?? []));
      failedChildren.push(...(result.failedChildren ?? []));
    }
  }

  if (keepForHandoff) {
    // 一行可见性日志：node 之后是「孤儿在跑、等新平台接管」，不是被漏掉。
    print(ui.info(t('gateway.stopKeptNodes', { count: keptNodes })));
    if (keptHubs > 0) print(ui.info(t('gateway.stopKeptHub')));
  }

  if (targets.entries.length === 0) {
    print(ui.info(t('gateway.notRunning')));
    // 0.55：即使没有 platform 在跑，也要把「谁还在跑」交代清楚，别让用户猜。
    await reportChildLifecycle({
      context,
      keepForHandoff,
      stoppedChildren,
      failedChildren,
      print,
      printErr,
    });
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
      // handoff 交接：**先**写 marker 再发终止信号，旧平台在 shutdown 分支消费它
      // （`supervisor.stop({ keep: true })`）。非 handoff 停止先清掉残留 marker，
      // 避免一次陈旧 marker 把「真停」变成假停。
      if (stateKind === 'platform') {
        if (keepForHandoff) {
          await writeHandoffMarker(context.dataDir, entry.instance, pid).catch(() => undefined);
        } else {
          await clearHandoffMarker(context.dataDir, entry.instance).catch(() => undefined);
        }
      }
      // P0-run-stops P1：legacy 单进程（stateKind='node'）本身就是 Node API ——
      // 强杀前先请它进程内 drain（写 resume 标记 + interrupt('shutdown')），等它自死；
      // 超时/失败回退既有强杀。node 子进程由 stopSpawnedChildren 各自优雅关闭。
      // Q4-C：platform entry 同样 graceful-first —— 经 /platform/rpc 的 gateway.shutdown
      // 让平台进程内跑退出序列（跑到 owned 池 stop，关闭 Windows owned engine 孤儿缺口）。
      // marker 写/清已在上面发生（keep 语义单一权威，先于任何终止触发）；老平台没有
      // 该方法 → not_found → 立即强杀回退，不假成功。
      let drained = false;
      if (stateKind === 'node' && entry.record !== undefined) {
        const graceful = await shutdownGateway({
          record: entry.record,
          token: token ?? '',
          tls: context.config.node?.tls !== undefined,
          requestTimeoutMs: 3_000,
        });
        if (graceful.ok) {
          const graceDeadline = Date.now() + 10_000;
          while (Date.now() < graceDeadline) {
            if (!isProcessAlive(pid)) {
              drained = true;
              break;
            }
            await sleep(100);
          }
        }
        if (!drained) {
          // P4：强杀回退代打一行（宿主来不及自己说）——这次停止没有 drain。
          printErr(
            ui.warn(
              formatEventLine('node.drain.skipped', {
                pid,
                reason: graceful.ok ? 'timeout' : (graceful.code ?? 'error'),
              }),
            ),
          );
        }
      } else if (stateKind === 'platform' && entry.record !== undefined) {
        // R1.1：平台 bearer 走**平台链**（gateway.token/token_env 显式 > 根密钥派生），
        // 不是 node 链的 resolveGatewayToken（两 token 同配时必不同）；解析失败 →
        // 跳优雅直接强杀，reason 记解析 code（下方 drain 行统一出口）。
        const platformTokenResolution = effectivePlatformToken({
          config: context.config,
          dataDir: context.dataDir,
          env: context.env,
        });
        const graceful: ShutdownGatewayResult = platformTokenResolution.ok
          ? await shutdownGateway({
              record: entry.record,
              token: platformTokenResolution.value.token ?? '',
              // 平台无原生 TLS（TLS 在反代终结）；本机停止直连回环 http。
              tls: false,
              rpcPath: '/platform/rpc',
              requestTimeoutMs: 3_000,
            })
          : {
              ok: false,
              error: platformTokenResolution.message,
              code: platformTokenResolution.code,
            };
        if (graceful.ok) {
          // 等死预算 = 停止方 timeoutMs（K5：等待预算在停止方，RPC 不带 timeout params）。
          const graceDeadline = Date.now() + timeoutMs;
          while (Date.now() < graceDeadline) {
            if (!isProcessAlive(pid)) {
              drained = true;
              break;
            }
            await sleep(100);
          }
        }
        if (!drained) {
          // 强杀回退代打一行（镜像 node.drain.skipped）：这次停止没走成优雅路径。
          printErr(
            ui.warn(
              formatEventLine('platform.drain.skipped', {
                pid,
                reason: graceful.ok ? 'timeout' : (graceful.code ?? 'error'),
              }),
            ),
          );
        }
      }
      if (!drained) terminateProcess(pid, context.platform);
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
    // 0.60：这个平台上如果正在重建 Web 产物，它现在也没了宿主（Windows 上宿主连
    // 一句话都来不及说）—— 由**停止方**代打一行 `web.build.interrupted`，并顺手把
    // 构建树杀掉，不留孤儿。宿主自己说过的（记录已是终态）这里一句都不说。
    const interruptedBuild = await interruptBuildOfStoppedHost(pid, 'stop').catch(() => undefined);
    if (interruptedBuild !== undefined) {
      printErr(
        ui.warn(
          formatEventLine('web.build.interrupted', {
            signal: interruptedBuild.signal,
            elapsed: interruptedBuild.elapsedMs,
            log: interruptedBuild.log,
          }),
        ),
      );
    }
  }

  // 0.55 停机可核：`gateway stop` 说清「node/hub 仍在跑」，整体关闭说清「停了谁、
  // 谁没停下来及原因」——不许让用户猜。
  await reportChildLifecycle({
    context,
    keepForHandoff,
    stoppedChildren,
    failedChildren,
    print,
    printErr,
  });

  return failed ? 1 : 0;
}

/**
 * 停机后的子进程交代（0.55）。
 *
 * - `keep` 路径：从**既有** pid/lock 文件读出本机节点与 Hub 的真实状态，逐个写明
 *   「仍在运行（pid N）/ 不在运行」+ 停它们的命令；
 * - 整体关闭路径：逐条列出「已停止 / 未停下 + 原因」。
 *
 * 只读既有运行时文件（`gateway.pid` / `hub.lock` / `nodes.json`），不新增状态实体。
 */
async function reportChildLifecycle(options: {
  context: ResolvedContext;
  keepForHandoff: boolean;
  stoppedChildren: StoppedChildDetail[];
  failedChildren: StoppedChildDetail[];
  print: (line: string) => void;
  printErr: (line: string) => void;
}): Promise<void> {
  const { context, keepForHandoff, stoppedChildren, failedChildren, print, printErr } = options;

  if (!keepForHandoff) {
    for (const child of stoppedChildren) {
      print(ui.ok(`stopped ${child.kind} ${child.name} (pid ${child.pid})`));
    }
    for (const child of failedChildren) {
      printErr(
        ui.err(
          `failed to stop ${child.kind} ${child.name} (pid ${child.pid}): ${child.reason ?? 'unknown'}`,
        ),
      );
    }
    if (stoppedChildren.length === 0 && failedChildren.length === 0) {
      print(ui.dim('no node/hub spawned by this gateway was running'));
    }
    return;
  }

  // keep 路径也可能终止「还没就绪」的子进程：没有归属证据、也还没接管端口，
  // 留着只会变孤儿（原因同 `NodeSupervisor.stop`）。要让它看得见，不静默。
  for (const child of stoppedChildren) {
    print(
      ui.dim(
        `stopped ${child.kind} ${child.name} (pid ${child.pid}) — it had not become ready yet`,
      ),
    );
  }

  const registry = await loadNodeRegistry(context.dataDir).catch(() => undefined);
  // 隐式单节点（无 nodes.json）与平台共用 dataDir，但也可能被独立拉起 —— 同样要交代。
  const entries =
    registry?.kind === 'ready'
      ? registry.registry.nodes
      : [{ name: 'default', data_dir: context.dataDir, auto_start: true, config_path: undefined }];
  let running = 0;
  for (const entry of entries) {
    const record = await readGatewayPidRecord(entry.data_dir).catch(() => null);
    const alive = record !== null && isProcessAlive(record.pid);
    if (alive && record !== null) {
      running += 1;
      print(
        ui.info(
          `node ${entry.name}: still running (pid ${record.pid}) — ` +
            'left alone; stop it with `vessel gateway stop --stop-nodes`',
        ),
      );
      continue;
    }
    if (entry.auto_start !== true) {
      print(
        ui.dim(
          `node ${entry.name}: not running (auto_start: false) — start it with ` +
            (entry.config_path !== undefined
              ? `\`vessel node start --daemon --config ${entry.config_path}\``
              : '`vessel node start --daemon`'),
        ),
      );
    } else {
      print(ui.dim(`node ${entry.name}: not running`));
    }
  }

  const hubDataDir =
    context.config.hub?.dataDir !== undefined
      ? path.resolve(expandHome(context.config.hub.dataDir))
      : path.join(context.dataDir, 'hub');
  const hub = await readHubLockFile(hubDataDir).catch(() => null);
  const hubAlive = hub !== null && isProcessAlive(hub.pid);
  if (hubAlive && hub !== null) {
    running += 1;
    print(
      ui.info(
        `hub: still running (pid ${hub.pid}${hub.url !== undefined ? `, ${hub.url}` : ''}) — ` +
          'stop it with `vessel gateway stop --stop-nodes`',
      ),
    );
  }
  if (entries.length === 0 && !hubAlive) {
    print(ui.dim('no node/hub was running'));
  } else if (running > 0) {
    print(ui.dim(`gateway stopped; ${running} node/hub process(es) left running`));
    print(ui.dim('to stop them too: `vessel gateway stop --stop-nodes`'));
  }
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
  // 平台监听只有 http；node 监听才可能带 node.tls。
  const tls = !platform && config.node?.tls !== undefined;
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
  const tls = config.node?.tls !== undefined;
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

/**
 * 0.58：看门狗事件 → 一行结构日志。
 *
 * 0.60：排版走**同一个** `formatEventLine`（`supervisor.*` 的字段序写在
 * `log-event.ts` 的 `EVENT_FIELDS` 里），不再在这里手拼 `key=value` —— 手拼的
 * 那一份迟早和模块化那份字段名/单位打架，而僵死时间线是**只能靠这一行**重建的。
 * 输出通道仍然可注入（`print` / `printErr`），只有「怎么排」收口。
 */
function printWatchdogEvent(
  event: WatchdogEvent,
  print: (line: string) => void,
  printErr: (line: string) => void,
): void {
  const node = event.name;
  const pid = event.pid;
  switch (event.kind) {
    case 'supervisor.stall_restart':
      printErr(
        ui.warn(
          formatEventLine('supervisor.stall_restart', {
            node,
            pid,
            consecutive_failures: event.consecutiveFailures,
            last_ok_ms: event.lastOkMs,
            stalled_for_ms: event.stalledForMs,
            probe_timeout_ms: event.probeTimeoutMs,
            attempt_in_hour: `${event.attemptInHour}/${event.maxRestartsPerHour}`,
            backoff_ms: event.backoffMs,
            action: 'kill+respawn',
          }),
        ),
      );
      return;
    case 'supervisor.stall_restart_failed':
      printErr(
        ui.err(
          formatEventLine('supervisor.stall_restart_failed', {
            node,
            pid,
            consecutive_failures: event.consecutiveFailures,
            probe_timeout_ms: event.probeTimeoutMs,
            error: event.error,
          }),
        ),
      );
      return;
    case 'supervisor.stall_restart_gave_up':
      printErr(
        ui.err(
          formatEventLine('supervisor.stall_restart_gave_up', {
            node,
            pid,
            restarts_last_hour: event.restartsLastHour,
            max_restarts_per_hour: event.maxRestartsPerHour,
            last_ok_ms: event.lastOkMs,
            stalled_for_ms: event.stalledForMs,
            reason: event.reason,
          }),
        ),
      );
      return;
    case 'supervisor.stall_recovered':
      print(
        ui.dim(
          formatEventLine('supervisor.stall_recovered', {
            node,
            pid,
            consecutive_ok: event.consecutiveOk,
          }),
        ),
      );
      return;
  }
}

/**
 * 运行中自查间隔（`VESSEL_WEB_AUTOBUILD_CHECK_MS`）。
 *
 * 只在显式配置时才返回数字：缺省 60s 与 5s 下限留在平台侧一处，别在这里复制第二份。
 */
function webBuildCheckIntervalMs(): number | undefined {
  const raw = (process.env.VESSEL_WEB_AUTOBUILD_CHECK_MS ?? '').trim();
  if (raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * `gateway status` 的构建段（0.60）：**不另写文案**。
 *
 * 读构建自己落盘的那条记录（`web.build.*` 的同一份事实），用 `formatEventLine` 出
 * 同一套 key=value —— 否则「日志说在构建、status 说没构建」这种矛盾只能靠人猜。
 */
async function webBuildStatusLines(): Promise<string[]> {
  const record = await readLatestWebBuildRecord();
  if (record === undefined) return [];
  if (record.running) {
    return [
      formatEventLine('web.build.running', {
        elapsed: Date.now() - record.startedAt,
        pid: record.pid,
        log: record.log,
      }),
    ];
  }
  if (record.phase === 'idle' || record.phase === 'running') return [];
  return [
    formatEventLine('web.build.last', {
      phase: record.phase,
      ...(record.exitCode !== undefined ? { exit: record.exitCode } : {}),
      ...(record.signal !== undefined ? { signal: record.signal } : {}),
      ...(record.durMs !== undefined ? { dur: record.durMs } : {}),
      at: record.endedAt ?? record.startedAt,
      log: record.log,
    }),
  ];
}

/**
 * 0.58：存活看门狗的一行摘要（启动输出与 `gateway status` 共用同一句话）。
 *
 * 「关」必须明说原因（`gateway.supervise.enabled: false`），否则下一单看到
 * 「僵死了没人重启」会以为看门狗坏了。
 */
function superviseLine(config: StallWatchdogConfig): string {
  if (!config.enabled) return t('gateway.status.superviseOff');
  return t('gateway.status.superviseOn', {
    probe: config.probeIntervalMs,
    threshold: config.failureThreshold,
    max: config.maxRestartsPerHour,
    backoff: config.backoffStartMs,
    backoffMax: config.backoffMaxMs,
  });
}

/**
 * 0.58：`gateway status` 的看门狗段（读 `<dataDir>/platform-watchdog*.json`）。
 *
 * 为什么读文件：`gateway status` 是**另一个进程**，看不到运行中平台的监督器内存；
 * 这份快照就是「最近一次探活成功/失败时刻 + 重启计数」的对外可见面（0600、无 token）。
 * 文件缺失（老版本 / 还没起过）就不占行，不编造状态。
 */
async function printSuperviseState(
  dataDir: string,
  instance: string,
  print: (line: string) => void,
): Promise<void> {
  const snapshot = await readWatchdogSnapshot(dataDir, instance).catch(() => null);
  if (snapshot === null) return;
  print(ui.kv(t('gateway.status.supervise'), superviseLine(snapshot.config), 12));
  for (const node of snapshot.nodes) {
    print(
      `  ${ui.dim(
        t('gateway.status.superviseNode', {
          name: node.name,
          phase: node.phase,
          lastOk: node.last_ok_at ?? '-',
          lastFail: node.last_fail_at ?? '-',
          restarts: node.restarts_total,
          lastHour: node.restarts_last_hour,
          error:
            node.last_error === null
              ? ''
              : t('gateway.status.superviseError', { error: node.last_error }),
        }),
      )}`,
    );
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
  // 0.57：产物落后于源码要能「不开浏览器也发现」。自修复只在 gateway 启动时跑一次，
  // 之后源码再变就没人说了 —— 所以这一行必须存在（不落后时为 null，不占行）。
  // 判据与 `/build.json`、启动诊断共用 `inspectWebDist`（`VESSEL_STATIC_DIR` 指向的
  // 外部产物不比源码，避免误报）。
  const webDistStaticDir = (context.env.VESSEL_STATIC_DIR ?? '').trim();
  const webDistLine = webDistStaleLine(
    await inspectWebDist(webDistStaticDir !== '' ? { staticDir: webDistStaticDir } : {}),
  );
  // 0.60：构建段也在这里取一次（跨进程读构建落盘的记录；口径与 `web.build.*` 一致）。
  const webBuildLines = await webBuildStatusLines();
  // 0.49 G3b：多节点投影只读 registry + 各 node 健康；不含 token。
  const nodeViews =
    stateKind === 'platform'
      ? await localNodeStatusViews(context.config, context.env, context.dataDir)
      : [];
  // 0.59：平台层「不在」时不许只说「未运行」——还要交代仍在跑的 node（见
  // `liveNodeSurvivors`）。惰性求值：只有真的落到「0 个实例」分支才读一次。
  let survivorsPromise: Promise<LiveNodeSurvivor[]> | undefined;
  const printPlatformDownSurvivors = async (): Promise<void> => {
    if (stateKind !== 'platform') return;
    survivorsPromise ??= liveNodeSurvivors({
      config: context.config,
      gatewayDataDir: context.dataDir,
    });
    const survivors = await survivorsPromise;
    if (survivors.length === 0) return;
    print(
      ui.warn(
        t('gateway.status.nodesAliveWithoutPlatform', {
          count: survivors.length,
          pids: survivors.map((node) => `${node.name}=${node.pid}`).join('、'),
        }),
      ),
    );
    for (const survivor of survivors) {
      print(`  ${ui.dim(`node ${survivor.name}  ${survivor.url}  pid ${survivor.pid}`)}`);
    }
  };
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
      await printPlatformDownSurvivors();
      return 1;
    }
    for (const entry of selected) {
      print(ui.kv(entry.instance, formatEntryState(entry, context.config), 12));
      if (platforms.has(entry.instance)) printNodeViews();
      // 0.58：探活/重启的可观测面（读平台落盘的看门狗快照）。
      // 判据是「进程还在」（不是平台的 health 探测）：看门狗本身就是给「health
      // 可能测不通」的场景做的，状态展示不能反过来依赖 health。
      if (entryOccupied(entry)) {
        await printSuperviseState(context.dataDir, entry.instance, print);
      }
      const pidFile = entry.pidPath ?? entry.lockPath;
      if (pidFile !== undefined) print(`  ${ui.dim(pidFile)}`);
    }
    for (const line of webBuildLines) print(`  ${ui.dim(line)}`);
    if (webDistLine !== null) print(`  ${ui.warn(webDistLine)}`);
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
    await printPlatformDownSurvivors();
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
    // 0.58：看门狗段看「进程还在」+ 它自己落盘的快照（不依赖平台 health 探测）。
    if (entryOccupied(entry)) {
      await printSuperviseState(context.dataDir, entry.instance, print);
    }
    const pidFile = entry.pidPath ?? entry.lockPath;
    if (pidFile !== undefined) print(`  ${ui.dim(pidFile)}`);
  }
  if (entries.length >= 2) {
    print(ui.dim(t('gateway.status.selectHint', { count: entries.length })));
  }
  print(ui.kv(t('gateway.status.service'), serviceLine(service), 10));
  for (const line of webBuildLines) print(`  ${ui.dim(line)}`);
  if (webDistLine !== null) print(`  ${ui.warn(webDistLine)}`);
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
      url: gatewayBaseUrl(record, stateKind === 'node' && context.config.node?.tls !== undefined),
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
      tls: context.config.node?.tls !== undefined,
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
  // 0.55 P0：daemon 父进程也 fail-fast（子进程会再判一次），避免「只留一段日志」。
  // 只对平台生效：`node` 的 daemon 里 `gateway.hostname` 不是它的监听地址。
  if (stateKind === 'platform') {
    const listenError = platformListenError(
      context.config,
      context.env,
      options.host,
      options.port,
      context.dataDir,
    );
    if (listenError !== null) {
      printErr(ui.err(listenError));
      return 1;
    }
  }
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
    // 平台监听只有 http（platform server 不带 TLS）。url 只用于启动消息显示。
    const url = localhostDisplayUrl(
      gatewayBaseUrl(result.record, stateKind === 'node' && context.config.node?.tls !== undefined),
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
  const printOut = deps.print ?? console.log;
  // 停前快照：instance/port/host 原样保留（lock-only 也保留 instance）。
  const entries = (await collectStateFor(context, deps)).entries;
  const targets = await resolveGatewayTargets(context.dataDir, command, { entries });
  if (!targets.ok) {
    printErr(ui.err(targets.error));
    return 1;
  }

  // 0.55.2：restart 缺省只换平台层 —— node/hub 保活并被新平台 adopt 接管，
  // 在跑的 run 不受影响（代价：node 仍跑旧代码，命令结尾会打印提示）。
  // 要连 node 一起冷重启：`--stop-nodes`。
  const stopCode = await stopGateway({
    ...deps,
    selector: command,
    entries,
    keepNodes: command.keepNodes !== false,
  });
  if (stopCode !== 0) return stopCode;
  if (command.keepNodes !== false) {
    printOut(
      ui.dim(
        'node/hub were kept running (still on the old code); ' +
          'to restart them too: `vessel gateway restart --stop-nodes`',
      ),
    );
  }

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
 * 仅显示层：启动消息里的回环 host（127.0.0.1 / [::1]）显示为 localhost，方便浏览器
 * 直接打开；非回环绑定原样保留。不改 gatewayBaseUrl / nodeOriginOf 的连接语义。
 */
function localhostDisplayUrl(url: string): string {
  return url.replace(/^(https?:\/\/)(?:127\.0\.0\.1|\[::1\])(?=[:/?#]|$)/, '$1localhost');
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
      // 0.56：隐式节点的 data_dir 就是 gateway data_dir，「代算」与「node 自己现算」
      // 用的是同一份 root + 同一个 node_id ⇒ 值必然一致。
      const implicitToken = effectiveNodeToken({
        config: options.config,
        dataDir: entry.data_dir,
        nodeId: entry.node_id,
        env: options.env,
      });
      if (!implicitToken.ok) {
        throw new LocalNodeStartError(implicitToken.code, implicitToken.message);
      }
      token = implicitToken.value.token;
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
      // 0.56：显式 `node.token*` 优先；否则派生 `vessel:node:<id>`（root 在该 node 的
      // data_dir 里，所以独立启动的 node 现算也能得到同一个值）。
      const nodeTokenResolution = effectiveNodeToken({
        config: nodeConfig,
        dataDir: entry.data_dir,
        nodeId: entry.node_id,
        env: options.env,
      });
      if (!nodeTokenResolution.ok) {
        throw new LocalNodeStartError(nodeTokenResolution.code, nodeTokenResolution.message);
      }
      token = nodeTokenResolution.value.token;
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

    // 0.59：「已经在跑的那个进程」自己写的地址优先于配置端口（见 `preferLiveNodeListen`）。
    // adopt 探活与平台代理都用这一份，配置与记录不一致时不会打到别人的进程上。
    const live = await preferLiveNodeListen(entry.data_dir, listen, {
      ...(entry.node_id !== undefined ? { nodeId: entry.node_id } : {}),
      tls: nodeConfig.node?.tls !== undefined,
    });
    listen = live.listen;

    const nodePort = listen.port;
    if (!Number.isInteger(nodePort) || nodePort <= 0) {
      throw new LocalNodeStartError(
        'node_port_conflict',
        `node "${entry.name}": node.port must be a fixed non-zero port`,
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
      apiUrl: nodeOriginOf(listen.host, nodePort, nodeConfig.node?.tls !== undefined),
    });
  }

  return resolved;
}

/** 最近一次终止信号名：`web.build.interrupted signal=…` 要如实，读不到就别编。 */
let lastStopSignal: 'SIGINT' | 'SIGTERM' | undefined;

function waitForTerminationSignal(): Promise<void> {
  return new Promise((resolve) => {
    const onSigint = (): void => stop('SIGINT');
    const onSigterm = (): void => stop('SIGTERM');
    function stop(signal: 'SIGINT' | 'SIGTERM'): void {
      lastStopSignal = signal;
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      resolve();
    }
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
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
    // 0.55 P0：restart 也必须在**停旧实例之前**过守卫 —— 配置不安全就别重启（免得白停）。
    const restartListenError = platformListenError(config, env, targetHost, targetPort, dataDir);
    if (restartListenError !== null) {
      printErr(ui.err(restartListenError));
      return 1;
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
      // 0.55.2：前台 restart 同口径，缺省只换平台层，node/hub 保活待 adopt。
      keepNodes: command.keepNodes !== false,
    });
    if (stopCode !== 0) return stopCode;
    if (command.keepNodes !== false) {
      print(
        ui.dim(
          'node/hub were kept running (still on the old code); ' +
            'to restart them too: `vessel gateway restart --stop-nodes`',
        ),
      );
    }
  }

  const portError = printSplitModePortError(
    config,
    'gateway',
    (line) => printErr(ui.err(line)),
    command.kind === 'start' ? command.port : undefined,
  );
  if (portError !== null) return portError;

  // 0.55 P0：fail-closed。非回环监听 + 没配 platform token ⇒ 在 spawn 之前就拒绝。
  const listenError = platformListenError(config, env, targetHost, targetPort, dataDir);
  if (listenError !== null) {
    printErr(ui.err(listenError));
    return 1;
  }

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
    const probeResolution = effectivePlatformToken({ config, dataDir, env });
    const probeToken = probeResolution.ok ? probeResolution.value.token : undefined;
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

  // 0.56.1：Web 控制台产物是平台的**硬前置**（没有它就只剩一堆 404 的纯 API）。
  // 先判再打印任何启动信息：新克隆的仓库必然是空的，报错必须直接说出「跑什么」，
  // 而不是让用户对着 `cannot GET /` 猜是缺构建产物。
  if (!existsSync(path.join(options.staticDir, 'index.html'))) {
    printErr(ui.err(t('gateway.webDistMissing', { path: options.staticDir })));
    return 1;
  }

  let platformGateway: ReturnType<typeof startPlatformGateway> | undefined;
  let supervisor: NodeSupervisor | undefined;
  // 池 S20：engine 池监督（size>0 才建）；声明在 try 外供 finally 读（同 supervisor 口径）。
  let poolSupervisor: PoolSupervisor | undefined;
  // handoff（0.52）：命中「保留子进程」时，成功/失败/退出路径都不能把它们停掉。
  // 声明必须在 try 之外 —— 下面的 finally 也要读它（否则 keep 会被回滚）。
  let handoffKept = false;
  try {
    const platformHostname = (
      targetHost ??
      config.gateway?.hostname ??
      DEFAULT_GATEWAY_OPTIONS.hostname
    ).trim();
    const platformPort = targetPort ?? config.gateway?.port ?? DEFAULT_GATEWAY_OPTIONS.port;
    // 0.56：平台 token = 显式配置 ?? 派生（`vessel:platform`）。**永不为 undefined**，
    // 除非根密钥不可用 —— 那种情况必须 fail-fast（宁可不启动，也不用弱权限根密钥）。
    const platformTokenResolution = effectivePlatformToken({ config, dataDir, env });
    if (!platformTokenResolution.ok) {
      printErr(ui.err(`${platformTokenResolution.code}: ${platformTokenResolution.message}`));
      return 1;
    }
    const platformToken = platformTokenResolution.value.token;
    if (platformTokenResolution.value.source === 'derived') {
      print(
        ui.dim(
          'platform token: derived from the root secret (no gateway.token configured) — ' +
            'run "vessel token show --purpose platform" to read it',
        ),
      );
    }
    // 0.55 P0：反代共享密钥（opt-in）。未配置 = undefined = 旧行为。
    const platformProxySecret = resolvePlatformProxySecret(config, env);
    // 0.50：本地 Hub 默认随 gateway 自动拉起（`hub.auto_start: false` 关闭）。
    // `direction: 'node'` 的 gateway 是出站加入远端 Hub，不再起一个空本地 Hub。
    const hubConfig = config.hub;
    const hubAutoStart = hubConfig?.autoStart !== false && hubConfig?.direction !== 'node';
    const hubHostname = (hubConfig?.listen?.hostname ?? HUB_DEFAULT_HOSTNAME).trim();
    const hubPort = hubConfig?.listen?.port ?? HUB_DEFAULT_PORT;

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
    // 0.58：父进程侧存活看门狗（`gateway.supervise`；缺省开，环境变量可显式覆盖）。
    const supervise = resolveStallWatchdogConfig(config.gateway?.supervise, env);

    supervisor = new NodeSupervisor({
      gatewayDataDir: dataDir,
      instance,
      env,
      platform,
      supervise,
      // 0.50：平台始终 http 监听；把页面 Origin 注入本地子 Node 的 CORS 白名单。
      // 0.52：**必须先 spawn 子进程、再监听 8642**（见下面 startPlatformGateway 的注释）。
      // 这里用已知的 ，不再依赖 。
      platformOrigins: platformBrowserOrigins(platformHostname, platformPort),
      ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
      ...(options.readinessTimeoutMs !== undefined
        ? { readinessTimeoutMs: options.readinessTimeoutMs }
        : {}),
      ...(options.stopTimeoutMs !== undefined ? { stopTimeoutMs: options.stopTimeoutMs } : {}),
      // 0.55：节点状态变化 → 结构化日志行（daemon 下进 logs/gateway.log）。
      // 这是「节点没起来必须看得见」的既有通道：状态 + 原因 + 耗时，一行一条。
      onNodeState: (info) => {
        const line = `node ${info.name}: ${info.state}${describeNodeState(info)}`;
        if (info.state === 'failed') printErr(ui.warn(line));
        else print(ui.dim(line));
      },
      // 0.58：看门狗动作 → 结构日志行（`event=supervisor.stall_restart ...`）。
      // 这一行是僵死时间线的唯一外部证据：子进程僵死时自己的日志一条都不会落地。
      onWatchdogEvent: (event) => printWatchdogEvent(event, print, printErr),
      // P0-run-stops P4：node 优雅关闭失败回退强杀 → 代打 node.drain.skipped。
      onDrainSkipped: (info) =>
        printErr(
          ui.warn(
            formatEventLine('node.drain.skipped', {
              name: info.name,
              pid: info.pid,
              reason: info.reason,
            }),
          ),
        ),
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
    // 0.55 分段启动 phase A：只做 adopt 判定 + spawn（毫秒级，不等就绪）。
    // 单个节点在这里失败只标该节点 failed，**不再回滚整个 gateway**。
    await supervisor.begin(specs);
    // phase B 在监听/写 PID 之后启动（见下面的 `settlePromise`）：就绪等待离开
    // 启动关键路径，慢节点不拖住「我能接请求」。

    // 池 S20：gateway.engine_pool.size > 0 → createPoolSupervisor（detached engine 池，
    // routing.json 唯一写者）。size=1 fail-fast（S1 装配层裁决：开时 ≥2，Q1）。spawn 必须
    // 先于 8642 监听（node/hub 同款硬前置：detached 子进程继承监听 socket）；start() 含
    // adopt + spawn 就绪（上界 30s），是 opt-in 启动成本。start 失败不崩启动（child supervisor
    // 先例 bootstrap.ts:1216-1220）：池工具 fail-closed 可见，平台/node 照常服务。
    const enginePool = config.gateway?.enginePool;
    if (enginePool !== undefined && (enginePool.size ?? 0) > 0) {
      const poolSize = enginePool.size ?? 0;
      if (poolSize === 1) {
        printErr(
          ui.err('engine_pool_invalid_size: gateway.engine_pool.size must be >= 2 when enabled'),
        );
        return 1;
      }
      // poolDir 与 node 侧同源（bootstrap 解释 (d)）：用户全局配置目录 + engine-pool[-instance]。
      const poolInstance = enginePool.instance;
      const poolDir = path.join(
        getUserConfigDir(),
        poolInstance !== undefined && poolInstance !== ''
          ? `engine-pool-${poolInstance}`
          : 'engine-pool',
      );
      const poolSettings: Record<string, unknown> = {
        dataDir: path.join(dataDir, 'engine-pool'),
      };
      if (enginePool.maxInflight !== undefined) poolSettings.maxInflight = enginePool.maxInflight;
      if (enginePool.rssSoftLimitMb !== undefined) {
        poolSettings.rssSoftLimitMb = enginePool.rssSoftLimitMb;
      }
      const poolLogLine = (message: string, fields?: Record<string, unknown>): string =>
        fields === undefined
          ? `engine pool: ${message}`
          : `engine pool: ${message} ${JSON.stringify(fields)}`;
      poolSupervisor = createPoolSupervisor({
        poolDir,
        // entryPath/rootDir 与 bootstrap child descriptor 同源（bootstrap.ts:1190-1191 口径）。
        entryPath: path.join(import.meta.dir, '..', '..', '..', 'tools-engine', 'entry.ts'),
        rootDir: path.join(import.meta.dir, '..', '..', '..', '..'),
        size: poolSize,
        settings: poolSettings,
        // 前台无 Logger 实例：桥 print/printErr（NodeSupervisor onNodeState 同通道）；
        // 预算尽 escalate 必须可见，不接受 noopLogger 静默。
        logger: {
          debug: (message, fields) => print(ui.dim(poolLogLine(message, fields))),
          info: (message, fields) => print(ui.dim(poolLogLine(message, fields))),
          warn: (message, fields) => printErr(ui.warn(poolLogLine(message, fields))),
          error: (message, fields) => printErr(ui.err(poolLogLine(message, fields))),
        },
      });
      await poolSupervisor.start().catch((error: unknown) => {
        printErr(
          ui.err(`engine pool start failed; pool tools are fail-closed: ${errorMessage(error)}`),
        );
      });
    }

    // 0.52（handoff 的硬前置）：**监听必须晚于 spawn 子进程**。
    //
    // 事故： 改成 handoff（保留 node/hub）之后，旧 gateway 的 8642 监听 socket
    // 会被它 spawn 的 detached 子进程继承；父进程退出后 socket 仍以旧 pid 挂在 LISTEN 上，
    // 新 gateway 永远  —— 实测：pid 已死、netstat 仍显示旧 pid 在监听，
    // 且杀掉 hub 也不释放（说明句柄在 node 里），只能连 node 一起杀。
    // 根因是 Windows 的句柄继承：只要 listen 发生在 spawn 之前，子进程就会拿到那个 socket。
    // 所以这里把「起监听」挪到「spawn 完成」之后；顺带让子进程显式不继承 stdio。
    // 0.50：本地 Hub 是独立进程；启动失败只 warning，不阻断 gateway。
    // 手工/外部启动的 Hub 走 adopt，不记 manifest（`gateway stop` 不会杀它）。
    // 0.55：Hub 也分段——命中 adopt 立刻拿到 url；本进程 spawn 的只等 settle。
    let hubBegin: HubSupervisorBeginResult | undefined;
    if (hubAutoStart) {
      const hubDataDir =
        hubConfig?.dataDir !== undefined
          ? path.resolve(expandHome(hubConfig.dataDir))
          : path.join(dataDir, 'hub');
      hubBegin = await supervisor.beginHub({ dataDir: hubDataDir });
      if (!hubBegin.ok) {
        // 0.60：与收尾阶段同一条事件、同一套字段（`hub.start_failed`）。
        printErr(
          ui.warn(
            formatEventLine('hub.start_failed', {
              code: hubBegin.code,
              error: hubBegin.message,
            }),
          ),
        );
      }
    }

    // 0.61：注册表派生来源集 D（loopback ∪ 经本机网卡验证的私网）。
    //
    // 读的是 hub data dir 里的 `registry.json`，不打 HTTP：hub 是独立进程、且本进程
    // 刚 spawn 的 hub 可能还没起来；若改成问 hub，「白名单依赖 hub 先起好」这个耦合
    // 就回来了。文件缺失 / 损坏 / hub 在别的机器上 ⇒ 空集，行为与今天逐字一致。
    const hubDataDir =
      hubConfig?.dataDir !== undefined
        ? path.resolve(expandHome(hubConfig.dataDir))
        : path.join(dataDir, 'hub');
    const derivedOrigins = await readHubDerivedOrigins({ hubDataDir });
    if (derivedOrigins.origins.length > 0) {
      // 只在真的有派生来源时打，老配置的启动输出逐字不变。
      printErr(
        ui.dim(
          formatEventLine('hub.origins.derived', {
            count: derivedOrigins.origins.length,
            loopback: derivedOrigins.loopback,
            private: derivedOrigins.private,
          }),
        ),
      );
    }

    // 0.56：WebUI 登录（GitHub OAuth，单用户）。未配置 auth.backends 时
    // backends 为空 ⇒ 平台行为与 0.55 逐字一致（回环可用，不锁死）。
    // 配错（缺 publicOrigin / 缺白名单 / 缺 clientId）只降级为「登录未启用」+ 告警，
    // 不会拦住 gateway 启动 —— 这是「破坏性变更必须自带自愈」的那条。
    const resolvedAuth = resolveAuthSettings({ auth: config.auth, dataDir });
    for (const warning of resolvedAuth.warnings) printErr(ui.warn(`auth: ${warning}`));
    // 0.60：来源白名单可能有多条（线上域名 + 回环并列）。启动日志必须说清「几个来源在用」，
    // 否则登录跳错域名时没人能从日志判断这是配置还是判定问题。
    // 只在真的用了 `public_origins`（或合并后 >1）时打，单来源老配置的输出逐字不变。
    if (
      resolvedAuth.publicOrigins.length > 1 ||
      (config.auth?.publicOrigins !== undefined && resolvedAuth.publicOrigins.length > 0)
    ) {
      printErr(
        ui.info(
          'auth: 使用了 ' +
            String(resolvedAuth.publicOrigins.length) +
            ' 个公网来源（' +
            resolvedAuth.publicOrigins.join('、') +
            '）—— 登录走哪个由受信边缘决定',
        ),
      );
    }

    // Q4-C：退出序列**单实现** —— SIGTERM/SIGINT 分支与 `gateway.shutdown` RPC 注入共用
    // 这个闭包，不另造退出路径（node 先例 cli.ts：「走与 SIGTERM 完全相同的 activeCleanup」）。
    // 停止方（stopGateway 优雅步）经 RPC 触发它，让平台进程内跑到 owned 池 stop 再退，
    // 关闭 Windows owned engine 孤儿缺口；keep 语义零变化（handoff marker 单一权威）。
    const performPlatformShutdown = async (): Promise<void> => {
      // 构建中被叫停（`gateway stop` / Ctrl-C / 外部 SIGTERM）：**真的**杀掉构建子进程，
      // 并留一行 `web.build.interrupted` —— 用户要的是「知道这次构建被中断了」，
      // 而不是下次发现 dist 半新半旧却查不到痕迹。
      interruptWebBuild(lastStopSignal ?? 'SIGTERM');
      // handoff（0.52）：停止方在发终止信号**之前**写了 marker ⇒ 这次退出只交出平台层，
      // 自己 spawn 的 node/hub 原样留着，等新平台按 `gateway.pid` 三元组 / hub lock 接管；
      // 没有 marker（Ctrl-C、`gateway stop`、外部 SIGTERM）就照旧连子进程一起停。
      handoffKept = await consumeHandoffMarker(dataDir, instance, process.pid).catch(() => false);
      if (handoffKept) {
        const result = await supervisor?.stop({ keep: true }).catch(() => undefined);
        if (result !== undefined) {
          print(ui.info(t('gateway.stopKeptNodes', { count: result.kept?.nodes ?? 0 })));
          if ((result.kept?.hubs ?? 0) > 0) print(ui.info(t('gateway.stopKeptHub')));
        }
        // 池 S20：handoff 不杀 detached engine（新前台 adopt，S7）；只清点可见，不静默。
        if (poolSupervisor !== undefined) {
          const keptEngines = poolSupervisor.members().filter((member) => member.owned).length;
          print(ui.dim(`engine pool: kept ${keptEngines} owned engine(s) for adopt`));
        }
      } else {
        await supervisor?.stop().catch(() => undefined);
        // 池 S20：非 handoff 停止 terminate owned（adopt/external 永不杀，S7）；node 先停再停 engine。
        await poolSupervisor?.stop().catch(() => undefined);
      }
      await platformGateway?.stop().catch(() => undefined);
      platformGateway = undefined;
    };

    try {
      // 0.61：自查间隔只在显式配置时透传 —— 缺省值（60s）与下限（5s）留在平台一处。
      const webBuildCheckMs = webBuildCheckIntervalMs();
      platformGateway = startPlatformGateway({
        port: platformPort,
        hostname: platformHostname,
        ...(platformToken !== undefined ? { platformToken } : {}),
        // 0.56：派生值不算「配置」⇒ 回环匿名保持（不重演「升级即掉线」）。
        platformTokenConfigured: platformTokenResolution.value.source === 'explicit',
        ...(platformProxySecret !== undefined ? { proxySecret: platformProxySecret } : {}),
        ...(config.gateway?.allowedOrigins !== undefined
          ? { allowedOrigins: config.gateway.allowedOrigins }
          : {}),
        // 0.61：`http.allowed_origins`（访问控制）与 `auth.public_origins`（redirect_uri
        // 来源）是两件事，这里只传前者；缺省（undefined）由平台回落成
        // 「public_origins + 三条回环通配」。
        ...(config.http?.allowedOrigins !== undefined
          ? { httpAllowedOrigins: config.http.allowedOrigins }
          : {}),
        // 0.63：`auth.allow_loopback_anonymous`（缺省 false）。只影响「回环匿名要不要
        // 身份」，与上面两道 origin 白名单无关。
        ...(config.auth?.allowLoopbackAnonymous === true ? { allowLoopbackAnonymous: true } : {}),
        nodeOrigins: [...new Set(nodes.map((node) => node.apiUrl))],
        // 0.61：派生来源集 D 全量传入 —— 平台内部按三行规则分流：
        // CORS 只取回环子集（收窄在 `resolveHttpAllowedOrigins` 的单一实现里），
        // CSP `connect-src`/`frame-src` 取全量。
        ...(derivedOrigins.origins.length > 0 ? { derivedOrigins: derivedOrigins.origins } : {}),
        // 0.50：Hub 页浏览器直连 Hub，CSP `connect-src` 必须放行 Hub origin。
        ...(Number.isInteger(hubPort) && hubPort > 0
          ? { hubOrigins: platformBrowserOrigins(hubHostname, hubPort) }
          : {}),
        staticDir: options.staticDir,
        // 0.57：`/build.json` 的实时字段 —— 判据复用 `web-dist.ts`，平台不自己比 mtime。
        // 这是「产物过期但没人重建」时唯一能被浏览器看见的证据。
        webDist: webDistProbe(options.staticDir),
        // 0.60：构建状态（在不在建 / 上次成没成 / 日志在哪）的唯一注入点 —— 平台不再
        // 自己拿一个布尔去拼「正在构建」，`/build.json` 与日志共用这一份快照。
        webBuild: webDistBuildState,
        // 0.61：运行中自查（定时 60s + `/build.json` 探针）。判据/限频/互斥都在
        // `recheckWebDist` 里，和启动时那次构建是同一套；这里只把「何时叫」交出去。
        webBuildCheck: (trigger) => recheckWebDist(trigger),
        ...(webBuildCheckMs !== undefined ? { webBuildCheckMs } : {}),
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
        // 0.58：浏览器/CLI 只连平台，node 的 HTTP 与 WS 由平台代理（node token 不出网关）。
        // `gateway.proxy_nodes: false` 是保留的显式回退：平台不提供 `/nodes/*`，
        // 前端据 `platform.whoami.proxy.enabled` 自动回到「取 credentials 直连 node」。
        proxy: { enabled: config.gateway?.proxyNodes !== false },
        // Q4-C：gateway.shutdown 优雅退出注入 —— handle 跑与 SIGTERM 完全相同的退出序列
        // （performPlatformShutdown），再**显式**释放实例锁并退出：process.exit 不跑 finally，
        // 锁必须显式释放；pid 经既有 process.once('exit') 条件清理（writeForegroundGatewayPid）。
        shutdown: {
          handle: async () => {
            await performPlatformShutdown().catch(() => undefined);
            await lock.release().catch(() => undefined);
            process.exit(0);
          },
          remoteAllowed: config.gateway?.remoteShutdown === true,
        },
        version,
        auth: {
          publicOrigin: resolvedAuth.publicOrigin,
          publicOrigins: resolvedAuth.publicOrigins,
          allowedHosts: resolvedAuth.allowedHosts,
          ...(resolvedAuth.trustedProxies !== undefined
            ? { trustedProxies: resolvedAuth.trustedProxies }
            : {}),
          backends: resolvedAuth.backends,
          session: resolvedAuth.session,
          // 0.56 P2：口令 / TOTP / 恢复码都在这个文件里（0600）；锁定状态单独一份，
          // 重启不清锁（否则攻击者只要让进程重启就能洗白失败计数）。
          ...(resolvedAuth.credentialsFile !== undefined
            ? { credentialsFile: resolvedAuth.credentialsFile }
            : {}),
          ...(resolvedAuth.lockoutFile !== undefined
            ? { lockoutFile: resolvedAuth.lockoutFile }
            : {}),
          env,
        },
      });
    } catch (error) {
      printErr(ui.err(`Platform gateway failed to start: ${errorMessage(error)}`));
      return 1;
    }
    // 0.52（handoff 的硬前置）：**监听必须晚于 spawn 子进程（含 hub）**。
    // 事故：gateway restart 改成 handoff 之后，旧 gateway 的 8642 监听 socket 会被它 spawn 的
    // detached 子进程继承；父进程退出后 socket 仍以旧 pid 挂在 LISTEN 上，新 gateway 永远报
    // port in use —— 实测 pid 已死、netstat 仍显示旧 pid 在监听，杀 hub 也不释放（句柄在 node 里），
    // 只能连 node 一起杀。根因是 Windows 句柄继承：listen 早于 spawn，子进程就会拿到那个 socket。
    // 所以把「起监听」挪到「spawn 完成（node + hub）」之后。
    try {
      await writeForegroundGatewayPid({
        dataDir,
        host: platformHostname,
        port: platformGateway.port,
        version,
        instance,
        kind: 'platform',
        startedAt: lock.startedAt,
        daemon: env[GATEWAY_DAEMON_ENV] === '1',
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

    // 仅显示（TTY 摘要 + 非 TTY 启动消息）；实际连接仍走 nodeOriginOf / gatewayBaseUrl。
    const platformUrl = localhostDisplayUrl(
      nodeOriginOf(platformHostname, platformGateway.port, false),
    );
    // 0.55 分段启动 phase B：节点/Hub 就绪等待**离开关键路径**——平台已经在监听、
    // `platform.pid` 已写好，这里只是后台收尾：谁先好谁先报，失败只更新那个节点的
    // 状态（`onNodeState` 打日志），绝不回滚平台、也不阻塞「我能接请求」。
    void supervisor
      .settle()
      .then((report) => {
        const hub = report.hub;
        if (hub !== undefined) {
          if (hub.ok) {
            print(ui.dim(`hub ${hub.url !== '' ? hub.url : 'running'}  (auto-started)`));
          } else {
            // 0.60：`hub_start_failed:` 这种「裸码：整句」的第二种排版收口成一行事件 ——
            // 同一件事（hub 没起来）在日志里只有一种说法。
            printErr(
              ui.warn(formatEventLine('hub.start_failed', { code: hub.code, error: hub.message })),
            );
          }
        }
        // 一次性收口：几个节点就绪、几个失败（失败原因已逐条打过）。
        if (report.counts.failed > 0 && report.counts.ready + report.counts.adopted > 0) {
          print(
            ui.info(
              `nodes: ${report.counts.ready + report.counts.adopted} ready, ` +
                `${report.counts.failed} failed (gateway keeps serving)`,
            ),
          );
        }
      })
      .catch(() => undefined);
    // 0.52 handoff 可见性：`adopted` / `external` = 本平台没有 spawn 它，是 adopt 来的
    // （`gateway restart` 保活的 node 走 `adopted`；手工/外部启动的走 `external`）。
    // 不新增字段，复用 supervisor 既有状态机。
    const stateNow = new Map(supervisor.list().map((info) => [info.nodeId, info]));
    // 0.50：前台 TTY 输出 Vite 风格摘要；daemon 子进程 stdout 重定向到日志
    // （非 TTY），保持既有逐行日志不变。显式注入 `print` 的嵌入方按交互处理。
    // 0.51：TTY 判定与 box banner 同一入口（`isHumanTerminal`），summary 本身无框线。
    const interactive = options.print !== undefined || isHumanTerminal();
    if (interactive) {
      const hub: PlatformStartupHub =
        hubBegin !== undefined
          ? hubBegin.ok
            ? hubBegin.adopted
              ? { state: 'adopted', url: hubBegin.url !== '' ? hubBegin.url : 'running' }
              : { state: 'starting' }
            : { state: 'unavailable' }
          : hubAutoStart
            ? { state: 'unavailable' }
            : { state: 'disabled' };
      print(
        renderPlatformStartup({
          version,
          platformUrl,
          // 这一刻节点可能还在 `starting`：如实显示，就绪/失败随后由日志行补齐。
          nodes: nodes.map((node) => {
            const info = stateNow.get(node.entry.node_id);
            return {
              name: node.entry.name,
              url: node.apiUrl,
              autoStart: node.entry.auto_start,
              ...(info !== undefined ? { state: info.state } : {}),
              ...(info?.reason !== undefined ? { reason: info.reason } : {}),
            };
          }),
          hub,
          readyMs: Math.max(0, Math.round(performance.now() - startupStartedAt)),
          stopHint: t('cli.gatewayRunning'),
        }),
      );
    } else {
      print(ui.ok(t('gateway.started', { pid: process.pid, url: platformUrl })));
      for (const node of nodes) {
        const info = stateNow.get(node.entry.node_id);
        print(
          ui.dim(
            `node ${node.entry.name}  ${node.apiUrl}` +
              (node.entry.auto_start ? '' : '  (auto_start: false)') +
              (info !== undefined ? `  (${info.state})` : ''),
          ),
        );
      }
      if (hubBegin !== undefined) {
        if (hubBegin.ok && hubBegin.adopted) {
          print(ui.dim(`hub ${hubBegin.url !== '' ? hubBegin.url : 'running'}  (adopted)`));
        } else if (!hubBegin.ok) {
          print(ui.dim('hub unavailable'));
        }
      }
    }
    // 0.58：看门狗开/关必须一眼可见 —— 「僵死了为什么没人重启」的答案就在这里。
    print(ui.dim(`supervise: ${superviseLine(supervise)}`));

    await (options.waitForStop ?? waitForTerminationSignal)();
    // Q4-C：SIGTERM/SIGINT 与 gateway.shutdown RPC 走**同一**退出序列（单实现，
    // 见上方 performPlatformShutdown）；不另造退出路径。finally 兜底不变且幂等。
    await performPlatformShutdown();
    return 0;
  } finally {
    // 失败路径也必须释放平台实例锁；PID 只在全部就绪后写入。
    // handoff 命中后这里也绝不能回滚子进程（否则前面的 keep 白做）。
    await supervisor?.stop(handoffKept ? { keep: true } : undefined).catch(() => undefined);
    // 池 S20：失败路径同口径 terminate owned；handoff 命中绝不杀（stop 幂等，成功路径已停过）。
    if (!handoffKept) await poolSupervisor?.stop().catch(() => undefined);
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
      return stopGateway({
        ...deps,
        timeoutMs: command.timeoutMs,
        selector: command,
        // 0.55：缺省**只停平台层**（node/hub 继续跑，下次 start 走 adopt）；
        // `--no-keep-nodes` 才是整体关闭（连 node/hub 一起停）。
        keepNodes: command.keepNodes !== false,
      });
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
