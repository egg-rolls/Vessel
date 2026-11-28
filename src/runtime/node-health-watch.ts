/**
 * node 健康订阅 watcher（q-health-subscription：doc-subscription 订阅源泛化的宿主侧）。
 *
 * 分工（与插件侧 health.ts 读端配对）：
 * - **插件**（doc-subscription）拥有订阅语义：subscribe 工具 add/remove/list/inspect、
 *   per-session 游标（notified_rev）、BeforeLlm 变化通知（vessel:notice，scope health）。
 * - **本 watcher** 拥有宿主知识：node 在哪里（nodes.json 注册表 / node 配置端口 /
 *   活进程 gateway.pid 记录）、远程联邦凭据（federation.peers 的 token_env / token_secret）。
 *   周期探测**被订阅的** node，把快照原子写到 `<stateDir>/health/<target>.json`；
 *   插件在 run 边界读快照、比签名、发通知（与文件订阅同一投递路径）。
 *
 * 为什么不是事件驱动：gateway.proxy.node_unreachable 是**日志事件**（代理转发失败时
 * 才打，不是周期探活），不进 agent 事件流；平台 registry 的 probeHealth 是按需探测
 * （list/get 调用时），没有周期节拍可订阅。联邦侧同理没有现成 health 事件面。
 * 因此驱动 = **需求驱动的周期探测**：每 tick 先扫订阅状态文件，没有 health 订阅 ⇒
 * 零探测开销（unused 时不产生任何网络请求）；有订阅 ⇒ 只探被订阅的目标。
 *
 * 探测阶梯（本机 node）：
 * 1. GET /v1/health（匿名，短超时）→ node_id / name / pid / started_at（重启检测主键）；
 * 2. 失败且目标 node 配置有 token ⇒ Bearer 重试 /v1/health；
 * 3. 仍失败 ⇒ GET /health（始终开放）→ 只判可达性（role=platform 不算 node）。
 * 联邦地址（<principal>@<node_id>:<team_id>）：peer 凭据可得 ⇒ 尝试 health.get RPC（+
 * capabilities.list 取 version）；否则匿名 /health 只判可达性。网络失败 ⇒ reachable=false。
 * 诚实声明：配对共享 secret 只在 federation 入站路径有效（独立 peer bearer），不是
 * node RPC token —— 此时 RPC 401 落回匿名可达性探测，远程订阅只有 reachable 翻转信号；
 * version / started_at（重启）需要 peer 凭据本身是 node 级 token（token_env 配 node token）。
 *
 * 快照 checked_at 每 tick 刷新，但**不进插件的变化签名**（签名 = reachable/version/
 * started_at/node_id），不会造成每 run 误报。
 *
 * @module vessel/node-health-watch
 */

import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  DATA_DIR_CLI_MARKER_ENV,
  loadConfig,
  type VesselConfig,
} from '../../packages/config/src/index';
import { atomicWrite, type Logger, withDeadline } from '../../packages/core/src/index';
import { parseDocSubscriptionConfig } from '../../plugins/context/doc-subscription/src/index';
import { resolveFederationOptions } from '../federation/federation-config';
import { nodeListenFromConfig, preferLiveNodeListen } from '../gateway/node-listen';
import {
  loadNodeRegistry,
  type NodeRegistryEntry,
  synthesizeImplicitNode,
} from '../gateway/node-registry';
import { declarativePluginEntries, pluginConfigFor } from '../plugin/plugin-config';
import { createHttpRpcClient } from '../rpc/http-client';

/** 缺省探测节拍：只在有 health 订阅时才产生探测（需求驱动）。 */
export const DEFAULT_HEALTH_WATCH_INTERVAL_MS = 20_000;
/** 单次探测上限（与平台 registry 的 ≤1s 探活同族；略宽给 RPC 两跳）。 */
export const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 1_500;
/** 单 tick 最多探测的目标数（防异常状态文件刷爆探测）。 */
const MAX_TARGETS_PER_TICK = 64;

/** 一次探测的事实（快照去掉 v/target/checked_at 的部分） */
export interface HealthProbeFacts {
  reachable: boolean;
  node_id?: string;
  name?: string;
  version?: string;
  started_at?: number;
  pid?: number;
  via?: 'local' | 'federation';
  error?: string;
}

export interface NodeHealthWatchOptions {
  /** live 配置（热应用后 federation.peers / plugins 配置变化下一 tick 生效）。 */
  getConfig: () => VesselConfig;
  /** 应用数据目录（nodes.json 注册表所在；与 gateway 命令同口径）。 */
  dataDir: string;
  /** 本机 node_id（federation 归一化用）。 */
  nodeId: string;
  /** 环境变量（token_env 解析）；缺省 process.env。 */
  env?: Record<string, string | undefined>;
  /** 预加载的联邦 peer SecretStore token（key `<nodeId>:<teamId>`）。 */
  secrets?: Record<string, string | undefined>;
  logger?: Logger;
  intervalMs?: number;
  probeTimeoutMs?: number;
  /** 验证注入：节拍器。 */
  timers?: {
    set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clear: (handle: ReturnType<typeof setTimeout>) => void;
  };
  /** 验证注入：替代真实探测（返回事实）。 */
  probeTarget?: (target: string) => Promise<HealthProbeFacts>;
}

export interface NodeHealthWatch {
  start(): void;
  stop(): void;
  /** 立即跑一轮（验证 / 诊断用；与节拍 tick 共用防重入闸）。 */
  tick(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * doc-subscription 的 stateDir（与插件 install 同一份解析，不复制第二套）：
 * 显式 plugins[doc-subscription].config.state_dir/stateDir > 插件默认。
 */
function resolveStateDir(config: VesselConfig): string {
  const pluginConfig = pluginConfigFor(
    'doc-subscription',
    config.plugins,
    declarativePluginEntries(config),
  );
  return parseDocSubscriptionConfig(pluginConfig).stateDir;
}

/**
 * 扫订阅状态文件，收集 health 目标（只读；损坏文件跳过）。
 * 状态形状契约 = doc-subscription store.ts（subscriptions.*.source/path）。
 */
async function scanHealthTargets(stateDir: string): Promise<string[]> {
  const sessionsDir = path.join(stateDir, 'sessions');
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return [];
  }
  const targets = new Set<string>();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(sessionsDir, name), 'utf-8'));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.subscriptions)) continue;
    for (const value of Object.values(parsed.subscriptions)) {
      if (!isRecord(value) || value.source !== 'health') continue;
      const target = optionalString(value, 'path');
      if (target !== undefined) targets.add(target);
      if (targets.size >= MAX_TARGETS_PER_TICK) return [...targets];
    }
  }
  return [...targets];
}

/** 快照文件路径（与插件 health.ts healthSnapshotPath 逐字同口径）。 */
function snapshotPath(stateDir: string, target: string): string {
  return path.join(stateDir, 'health', `${encodeURIComponent(target)}.json`);
}

/** GET JSON（短超时；非 2xx / 非 JSON / 网络失败 ⇒ undefined）。 */
async function fetchJson(
  url: string,
  token: string | undefined,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await withDeadline(timeoutMs, async (signal) =>
      fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
        },
        signal,
      }),
    );
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return isRecord(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

/** /v1/health 回包 → 事实（node 段自报身份；role=platform 不算 node）。 */
function factsFromV1Health(body: Record<string, unknown>): HealthProbeFacts | undefined {
  if (body.role === 'platform') return undefined;
  const facts: HealthProbeFacts = { reachable: true, via: 'local' };
  const node = isRecord(body.node) ? body.node : undefined;
  if (node !== undefined) {
    const nodeId = optionalString(node, 'node_id');
    if (nodeId !== undefined) facts.node_id = nodeId;
    const name = optionalString(node, 'name');
    if (name !== undefined) facts.name = name;
    const pid = optionalNumber(node, 'pid');
    if (pid !== undefined) facts.pid = pid;
    const startedAt = optionalNumber(node, 'started_at');
    if (startedAt !== undefined) facts.started_at = startedAt;
  }
  if (facts.started_at === undefined) {
    const startedAt = optionalNumber(body, 'started_at');
    if (startedAt !== undefined) facts.started_at = startedAt;
  }
  const version = optionalString(body, 'version');
  if (version !== undefined) facts.version = version;
  return facts;
}

/** health.get RPC 回包 → 事实（与 /v1/health 同形；via 由调用方覆写）。 */
function factsFromHealthGet(result: unknown): HealthProbeFacts | undefined {
  if (!isRecord(result)) return undefined;
  return factsFromV1Health(result);
}

/** 目标 node 配置里的 token（旧单 token > tokenEnv > tokens 表首键；永不打印）。 */
function resolveNodeToken(
  config: VesselConfig,
  env: Record<string, string | undefined>,
): string | undefined {
  const node = config.node;
  if (node === undefined) return undefined;
  if (typeof node.token === 'string' && node.token !== '') return node.token;
  if (typeof node.tokenEnv === 'string' && node.tokenEnv !== '') {
    const value = env[node.tokenEnv];
    if (typeof value === 'string' && value !== '') return value;
  }
  if (isRecord(node.tokens)) {
    for (const key of Object.keys(node.tokens)) {
      if (key !== '') return key;
    }
  }
  return undefined;
}

/** 本机 node 目标探测（注册表 → 监听解析 → /v1/health → /health 阶梯）。 */
async function probeLocalNode(
  target: string,
  options: NodeHealthWatchOptions,
  timeoutMs: number,
): Promise<HealthProbeFacts> {
  const config = options.getConfig();
  const env = options.env ?? process.env;
  let entry: NodeRegistryEntry | undefined;
  const load = await loadNodeRegistry(options.dataDir).catch(() => null);
  if (load !== null && load.kind === 'ready') {
    entry = load.registry.nodes.find((node) => node.node_id === target);
  }
  if (entry === undefined) {
    // 隐式单节点（无 nodes.json）：身份与 G1 同口径。
    const implicit = await synthesizeImplicitNode({ config, dataDir: options.dataDir }).catch(
      () => undefined,
    );
    if (implicit !== undefined && implicit.node_id === target) entry = implicit;
  }
  if (entry === undefined) {
    return { reachable: false, via: 'local', error: 'node_not_found' };
  }

  // 目标 node 的配置（注册表 config_path 优先；读失败回落本机配置，不猜）。
  let nodeConfig = config;
  if (entry.config_path !== undefined) {
    try {
      const loaded = await loadConfig({
        configPath: entry.config_path,
        env: { ...env, VESSEL_DATA_DIR: entry.data_dir, [DATA_DIR_CLI_MARKER_ENV]: '1' },
      });
      nodeConfig = loaded.config;
    } catch {
      // 配置读失败：用本机配置推监听（保守回落，与 localNodeStatusViews 同族）。
    }
  }
  const live = await preferLiveNodeListen(entry.data_dir, nodeListenFromConfig(nodeConfig), {
    nodeId: target,
    tls: nodeConfig.node?.tls !== undefined,
  });
  const baseUrl = live.listen.url;

  // 1. 匿名 /v1/health（回环默认开放）。
  let body = await fetchJson(`${baseUrl}/v1/health`, undefined, timeoutMs);
  // 2. 失败且目标配置有 token ⇒ Bearer 重试（远程监听 / 显式 token 的 node）。
  if (body === undefined) {
    const token = resolveNodeToken(nodeConfig, env);
    if (token !== undefined) {
      body = await fetchJson(`${baseUrl}/v1/health`, token, timeoutMs);
    }
  }
  if (body !== undefined) {
    const facts = factsFromV1Health(body);
    if (facts !== undefined) return facts;
  }
  // 3. /health 始终开放：只判可达性（version/started_at 不可得，签名以 '-' 占位）。
  const basic = await fetchJson(`${baseUrl}/health`, undefined, timeoutMs);
  if (basic !== undefined && basic.role !== 'platform') {
    return { reachable: true, via: 'local' };
  }
  return { reachable: false, via: 'local' };
}

/** 联邦地址目标探测（peer 凭据 → health.get RPC；无凭据 → 匿名 /health 可达性）。 */
async function probeFederationTarget(
  target: string,
  options: NodeHealthWatchOptions,
  timeoutMs: number,
): Promise<HealthProbeFacts> {
  const config = options.getConfig();
  const env = options.env ?? process.env;
  const { options: federation } = resolveFederationOptions({
    ...(config.federation !== undefined ? { federation: config.federation } : {}),
    nodeId: options.nodeId,
    env,
    ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
  });
  const at = target.lastIndexOf('@');
  const nodeAndTeam = target.slice(at + 1);
  const colon = nodeAndTeam.indexOf(':');
  const nodeId = colon >= 0 ? nodeAndTeam.slice(0, colon) : nodeAndTeam;
  const teamId = colon >= 0 ? nodeAndTeam.slice(colon + 1) : undefined;
  const peer = federation.peers.find(
    (candidate) =>
      candidate.nodeId === nodeId && (teamId === undefined || candidate.teamId === teamId),
  );
  if (peer === undefined) {
    return { reachable: false, via: 'federation', error: 'peer_not_found' };
  }
  if (peer.url === undefined) {
    return { reachable: false, via: 'federation', error: 'peer_url_missing' };
  }

  // 凭据可得 ⇒ authenticated health.get（+ capabilities.list 取 version）。
  if (peer.token !== '') {
    let ca: string | undefined;
    if (peer.caFile !== undefined) {
      ca = await readFile(peer.caFile, 'utf-8').catch(() => undefined);
      if (ca !== undefined && ca.trim() === '') ca = undefined;
    }
    const client = createHttpRpcClient({
      baseUrl: peer.url,
      token: peer.token,
      subscribe: false,
      requestTimeoutMs: timeoutMs,
      ...(ca !== undefined ? { ca } : {}),
    });
    try {
      const health = await client.request<unknown>('health.get', {});
      const facts = factsFromHealthGet(health);
      if (facts !== undefined) {
        facts.via = 'federation';
        try {
          const caps = await client.request<unknown>('capabilities.list', {});
          if (isRecord(caps)) {
            const version = optionalString(caps, 'version');
            if (version !== undefined) facts.version = version;
          }
        } catch {
          // version 不可得不影响可达性 / 重启信号。
        }
        return facts;
      }
    } catch {
      // RPC 失败（含 401）：落到匿名可达性探测（node 可能活着但凭据不对）。
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  // 匿名 /health（始终开放）：只判可达性。
  const basic = await fetchJson(`${peer.url}/health`, undefined, timeoutMs);
  if (basic !== undefined && basic.role !== 'platform') {
    return {
      reachable: true,
      via: 'federation',
      ...(peer.token === '' ? { error: 'peer_token_unavailable' } : {}),
    };
  }
  return { reachable: false, via: 'federation' };
}

/**
 * 创建 watcher。start 后按节拍 tick；stop 取消定时器（进程收口调用）。
 * 所有失败 best-effort：单目标探测失败落 reachable=false 快照（或 error 事实），
 * 不打断其它目标；tick 整体失败只记日志。
 */
export function createNodeHealthWatch(options: NodeHealthWatchOptions): NodeHealthWatch {
  const logger = options.logger;
  const intervalMs = options.intervalMs ?? DEFAULT_HEALTH_WATCH_INTERVAL_MS;
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
  const setTimer =
    options.timers?.set ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      (handle as { unref?: () => void }).unref?.();
      return handle;
    });
  const clearTimer =
    options.timers?.clear ?? ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticking = false;
  let stopped = false;

  const probe = async (target: string): Promise<HealthProbeFacts> => {
    if (options.probeTarget !== undefined) return options.probeTarget(target);
    // 含 '@' ⇒ 联邦地址（三段语法在插件 add 时已校验；这里只按形状分路）。
    if (target.includes('@')) return probeFederationTarget(target, options, timeoutMs);
    return probeLocalNode(target, options, timeoutMs);
  };

  const tick = async (): Promise<void> => {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const stateDir = resolveStateDir(options.getConfig());
      const targets = await scanHealthTargets(stateDir);
      if (targets.length === 0) return;
      for (const target of targets) {
        if (stopped) return;
        let facts: HealthProbeFacts;
        try {
          facts = await probe(target);
        } catch (error) {
          facts = {
            reachable: false,
            error: 'probe_failed',
          };
          logger?.warn('node_health_watch.probe_failed', {
            target,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        const snapshot = { v: 1, target, ...facts, checked_at: Date.now() };
        try {
          await atomicWrite(snapshotPath(stateDir, target), `${JSON.stringify(snapshot)}\n`, {
            mode: 0o600,
            ensureDir: true,
          });
        } catch (error) {
          logger?.warn('node_health_watch.snapshot_write_failed', {
            target,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      logger?.warn('node_health_watch.tick_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      ticking = false;
    }
  };

  // 不变式：每 tick 完成后再排下一拍（链式 re-arm），探测耗时不叠 tick；stop 断链。
  // re-arm 所有权只在调度器回调链上——tick() 本身保持纯净（manual/诊断调用不 re-arm）。
  const schedule = (): void => {
    timer = setTimer(() => {
      void tick().finally(() => {
        if (!stopped) schedule();
      });
    }, intervalMs);
  };

  return {
    start() {
      if (timer !== undefined || stopped) return;
      schedule();
      // 启动即跑一轮：订阅者不必等第一个节拍才看到基线快照。
      void tick();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
    },
    tick,
  };
}
