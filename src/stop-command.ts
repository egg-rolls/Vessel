/**
 * `vessel stop` 舰队级停（CONTRACT-stop-semantics S1–S7）。
 *
 * 本地 = 薄编排：只读清点（S2）→ 确认（S3）→ `stopGateway({ keepNodes:false })`
 * 共享接缝（S4，内部顺序与优雅步骤归 gateway-command）→ 池残留提示（S5.4）→ 汇总。
 * 远程 = 只认显式 `--connect`（绝不读 `VESSEL_CONNECT` env）：registry 级清点 →
 * 确认 → `gateway.shutdown` 经 `/platform/rpc`（S5.3 客户端）→ 轮询 health 至不可达（S7）。
 *
 * 不写 handoff marker / routing.json、不获取实例锁、不 terminate engine；
 * 远程不强杀（生命周期强杀恒本机）。人类输出走 `ui` + `t()`；数据值保持英文。
 *
 * @module vessel/stop-command
 */

import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { getUserConfigDir, loadConfig, type VesselConfig } from '../packages/config/src/index';
import { DEFAULT_STOP_TIMEOUT_MS, type GatewaySelector } from './cli-args';
import { expandHome, resolveDataDir } from './data/data-paths';
import { isHumanTerminal } from './gateway/gateway-banner';
import { loadNodeRegistry } from './gateway/node-registry';
import { readSpawnedChildren, type SpawnedChildRecord } from './gateway/node-supervisor';
import {
  collectGatewayState,
  DEFAULT_GATEWAY_INSTANCE,
  type GatewayPidRecord,
} from './gateway/pid';
import { gatewayBaseUrl, shutdownGateway } from './gateway/reload';
import { resolveConnectToken, resolveGatewayToken } from './gateway/transport-factory';
import { type GatewayCommandDeps, resolveGatewayTargets, stopGateway } from './gateway-command';
import { t } from './i18n';
import { createHttpRpcClient, type HttpRpcClient, normalizeConnectUrl } from './rpc/http-client';
import { ui } from './ui-style';

/** 冻结签名（CONTRACT-stop-semantics S1）；接线方 = src/commands/registry.ts。 */
export interface StopFleetOptions extends GatewayCommandDeps {
  yes?: boolean; // 跳过确认
  selector?: GatewaySelector; // 本地缺省 { all: true }；与 connectUrl 互斥
  timeoutMs?: number; // 缺省 DEFAULT_STOP_TIMEOUT_MS
  connectUrl?: string | null; // 非空 = 远程分支（S7）
  connectToken?: string | null;
  caFile?: string | null;
}

/**
 * `vessel stop`：返回退出码。
 * 0 = 全部停成 / 本无运行 / 用户主动取消；1 = 任一失败、非交互无 --yes 拒绝、超时未确认。
 */
export async function stopFleetCommand(options: StopFleetOptions = {}): Promise<number> {
  const {
    yes,
    selector: selectorOption,
    timeoutMs: timeoutOption,
    connectUrl,
    connectToken,
    caFile,
    ...deps
  } = options;
  const env = deps.env ?? process.env;
  const print = deps.print ?? console.log;
  const printErr = deps.printErr ?? console.error;
  let config: VesselConfig;
  if (deps.config !== undefined) {
    config = deps.config;
  } else {
    const loaded = await loadConfig({ env });
    config = loaded.config;
    for (const warning of loaded.validation.warnings) {
      printErr(ui.warn(`⚠ ${warning.message}`));
    }
  }
  const timeoutMs = timeoutOption ?? DEFAULT_STOP_TIMEOUT_MS;
  // S1 安全决策：远程只认显式 --connect flag，不认 VESSEL_CONNECT env。
  const remoteUrl = nonEmpty(connectUrl);
  if (remoteUrl !== undefined) {
    return stopRemoteFleet({
      url: remoteUrl,
      config,
      env,
      connectToken,
      caFile,
      yes,
      timeoutMs,
      print,
      printErr,
      sleep: deps.sleep,
      now: deps.now,
    });
  }
  return stopLocalFleet({
    deps,
    config,
    env,
    yes,
    selector: selectorOption,
    timeoutMs,
    print,
    printErr,
  });
}

// ── 本地分支（S2 清点 → S3 确认 → S4 共享接缝 → S5.4 残留 → 汇总）──

async function stopLocalFleet(input: {
  deps: GatewayCommandDeps;
  config: VesselConfig;
  env: Record<string, string | undefined>;
  yes?: boolean;
  selector?: GatewaySelector;
  timeoutMs: number;
  print: (line: string) => void;
  printErr: (line: string) => void;
}): Promise<number> {
  const { deps, config, env, print, printErr } = input;
  const dataDir = deps.dataDir ?? resolveDataDir(config, env);
  // S1：本地缺省 = resolved data root 内所有实例的舰队。
  const raw = input.selector ?? {};
  const selector: GatewaySelector =
    raw.instance === undefined && raw.port === undefined ? { all: true } : raw;

  // S2 只读清点：全实例平台 + manifest node/hub + registry 报告层 + hub 快照 + 池残留。
  const kind = deps.stateKind ?? (env.VESSEL_LEGACY_SERVE === '1' ? 'node' : 'platform');
  const token = resolveGatewayToken(config, env);
  const hubDataDir = configuredHubDataDir(config);
  const collect = deps.collectState ?? collectGatewayState;
  const snapshot = await collect(dataDir, {
    ...(token !== undefined ? { token } : {}),
    ...(hubDataDir !== undefined ? { hubDataDir } : {}),
    kind,
  });
  const targets = await resolveGatewayTargets(dataDir, selector, { entries: snapshot.entries });
  if (!targets.ok) {
    printErr(ui.err(targets.error));
    return 1;
  }

  // manifest 枚举与 stopSpawnedChildren 同口径（全实例 readdir / 收窄按目标实例）。
  const instances: Array<string | undefined> = [];
  if (targets.all) {
    const names = await readdir(dataDir).catch(() => [] as string[]);
    for (const name of names) {
      if (name === 'platform-children.json') instances.push(undefined);
      else if (name.startsWith('platform-children-') && name.endsWith('.json')) {
        instances.push(name.slice('platform-children-'.length, -'.json'.length));
      }
    }
  } else {
    for (const instance of new Set(targets.entries.map((entry) => entry.instance))) {
      instances.push(instance);
    }
  }
  const children: Array<{ instance: string; child: SpawnedChildRecord }> = [];
  for (const instance of instances) {
    const records = await readSpawnedChildren(dataDir, instance);
    for (const child of records) {
      children.push({ instance: instance ?? DEFAULT_GATEWAY_INSTANCE, child });
    }
  }
  const registry = await loadNodeRegistry(dataDir).catch(() => undefined);
  const poolDir = poolDirFor(config);
  const poolFiles = await listPoolEngineFiles(poolDir);

  print(ui.info(t('stop.inventory.title', { dataDir })));
  for (const entry of targets.entries) {
    const pid = entry.record?.pid ?? entry.lock?.pid ?? '-';
    const url = entry.record !== undefined ? gatewayBaseUrl(entry.record, false) : '';
    print(
      t('stop.inventory.platform', {
        instance: entry.instance,
        state: entry.state,
        pid,
        url,
      }).trimEnd(),
    );
  }
  for (const { instance, child } of children) {
    print(
      t('stop.inventory.child', {
        kind: child.kind ?? 'node',
        name: child.name,
        pid: child.pid,
        instance,
      }),
    );
  }
  // registry 是报告层：不在 spawn manifest 的节点 = adopt/external，天然不动。
  if (registry?.kind === 'ready') {
    const manifestIds = new Set(children.map(({ child }) => child.node_id));
    for (const node of registry.registry.nodes) {
      if (manifestIds.has(node.node_id)) {
        print(t('stop.inventory.registryNode', { name: node.name, nodeId: node.node_id }));
      } else {
        print(t('stop.inventory.externalNode', { name: node.name, nodeId: node.node_id }));
      }
    }
  } else if (registry?.kind === 'missing') {
    print(t('stop.inventory.implicitNode'));
  }
  // 不动名单：standalone hub（hub stop 不在本轮）+ 池残留计数。
  if (snapshot.hub?.state === 'running' && snapshot.hub.record !== undefined) {
    print(t('stop.inventory.hub', { pid: snapshot.hub.record.pid }));
  }
  if (poolFiles.length > 0) {
    print(t('stop.inventory.pool', { count: poolFiles.length, dir: poolDir }));
  }

  if (targets.entries.length === 0 && children.length === 0) {
    print(ui.info(t('stop.nothingRunning')));
    return 0;
  }
  print(ui.warn(t('stop.warning.activeSessions')));

  // S3 确认：--yes 跳过；非交互无 --yes 拒绝；N/EOF 零进程被杀。
  const decision = await confirmStop(input.yes, print, printErr);
  if (decision === 'refused') return 1;
  if (decision === 'cancelled') return 0;

  // S4 薄编排：终止顺序 / marker / 优雅步骤全部在共享接缝内，这里不另造路径。
  const code = await stopGateway({
    ...deps,
    keepNodes: false,
    selector,
    timeoutMs: input.timeoutMs,
  });

  // S5.4 池残留提示（最终兜底）：停止方不 terminate engine，只如实报告。
  const remaining = await listPoolEngineFiles(poolDir);
  for (const file of remaining) {
    const id = file.slice(0, -'.json'.length);
    const pid = await readEnginePid(path.join(poolDir, 'engines', file));
    if (pid !== undefined) printErr(ui.warn(t('stop.poolResidue.line', { id, pid })));
    else printErr(ui.warn(t('stop.poolResidue.unreadable', { id })));
  }
  if (remaining.length > 0) {
    printErr(
      ui.warn(
        t('stop.poolResidue.count', {
          count: remaining.length,
          dir: path.join(poolDir, 'engines'),
        }),
      ),
    );
  }
  if (code === 0) print(ui.ok(t('stop.done')));
  else printErr(ui.err(t('stop.failed')));
  return code;
}

// ── 远程分支（S7 全 8 步；单连接目标，无远程 --all，不做本地文件清理）──

async function stopRemoteFleet(input: {
  url: string;
  config: VesselConfig;
  env: Record<string, string | undefined>;
  connectToken?: string | null;
  caFile?: string | null;
  yes?: boolean;
  timeoutMs: number;
  print: (line: string) => void;
  printErr: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<number> {
  const { config, env, print, printErr } = input;
  // S7.1/2：assertConnectUrl 硬闸在 createHttpRpcClient 内部自动生效；
  // token = --connect-token > connect.token(_env)（resolveConnectToken 既有优先级）。
  const baseUrl = normalizeConnectUrl(input.url);
  const token = resolveConnectToken(config, { connectToken: input.connectToken, env }) ?? '';
  const ca = await readCa(nonEmpty(input.caFile) ?? nonEmpty(config.connect?.caFile));
  let client: HttpRpcClient;
  try {
    client = createHttpRpcClient({
      baseUrl,
      token,
      subscribe: false,
      requestTimeoutMs: 3_000,
      rpcPath: '/platform/rpc',
      ...(ca !== undefined ? { ca } : {}),
    });
  } catch (error) {
    printErr(ui.err(t('stop.remote.inventoryFailed', { detail: errorMessage(error) })));
    return 1;
  }
  try {
    // S7.3 远程清点（registry 级；诚实局限警示）。
    let health: unknown;
    let nodesRaw: unknown;
    try {
      health = await client.request('platform.health.get', {});
      nodesRaw = await client.request('platform.nodes.list', {});
    } catch (error) {
      printErr(ui.err(t('stop.remote.inventoryFailed', { detail: errorMessage(error) })));
      return 1;
    }
    if (!isRecord(health)) {
      printErr(
        ui.err(
          t('stop.remote.inventoryFailed', {
            detail: 'unexpected platform.health.get result shape',
          }),
        ),
      );
      return 1;
    }
    if (!isRecord(nodesRaw) || !Array.isArray(nodesRaw.nodes)) {
      printErr(
        ui.err(
          t('stop.remote.inventoryFailed', {
            detail: 'unexpected platform.nodes.list result shape',
          }),
        ),
      );
      return 1;
    }
    print(ui.info(t('stop.remote.title', { url: baseUrl })));
    print(
      t('stop.remote.health', {
        status: String(health.status ?? 'unknown'),
        version: String(health.version ?? 'unknown'),
        count: typeof health.node_count === 'number' ? health.node_count : 0,
      }),
    );
    for (const node of nodesRaw.nodes) {
      if (!isRecord(node)) continue;
      print(
        t('stop.remote.node', {
          name: String(node.name ?? ''),
          nodeId: String(node.node_id ?? ''),
          status: String(node.status ?? 'unknown'),
          apiUrl: String(node.api_url ?? ''),
        }),
      );
    }
    print(ui.warn(t('stop.remote.limitation')));
    print(ui.warn(t('stop.warning.activeSessions')));

    // S7.3 确认（S3 同规则）。
    const decision = await confirmStop(input.yes, print, printErr);
    if (decision === 'refused') return 1;
    if (decision === 'cancelled') return 0;

    // S7.4：gateway.shutdown {} 经 /platform/rpc。record 等价形状承载 --connect origin
    // （nodeListenFromConfig 先例）；tls 由 url 协议决定（https 由反代终结）。
    const url = new URL(baseUrl);
    const record: GatewayPidRecord = {
      pid: 0,
      started_at: new Date(0).toISOString(),
      host: url.hostname,
      port: url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
      version: '0',
    };
    const result = await shutdownGateway({
      record,
      token,
      tls: url.protocol === 'https:',
      rpcPath: '/platform/rpc',
      requestTimeoutMs: 3_000,
      // ca 透传走既有 createClient 注入缝（ShutdownGatewayOptions 无 ca 字段）。
      ...(ca !== undefined
        ? {
            createClient: (o: { baseUrl: string; token: string; timeoutMs: number }) =>
              createHttpRpcClient({
                baseUrl: o.baseUrl,
                token: o.token,
                subscribe: false,
                requestTimeoutMs: o.timeoutMs,
                ca,
                rpcPath: '/platform/rpc',
              }),
          }
        : {}),
    });
    if (!result.ok) {
      // S7.7：未开 opt-in → SSH 兜底提示；其余 401 附 platform token 指引。
      if (result.code === 'unauthorized' && result.error.includes('remote_shutdown_disabled')) {
        printErr(ui.err(t('stop.remote.disabled')));
      } else {
        printErr(ui.err(t('stop.remote.failed', { detail: result.error })));
        if (result.code === 'unauthorized') printErr(ui.err(t('stop.remote.tokenHint')));
      }
      return 1;
    }
    print(ui.info(t('stop.remote.accepted')));

    // S7.5/6：轮询 health 至请求失败（不再可达）≤ timeoutMs；远程不强杀，
    // 超时如实 exit 1。措辞不声称「进程已死」（反代自身故障不可区分）。
    const sleep = input.sleep ?? sleepDefault;
    const now = input.now ?? Date.now;
    const deadline = now() + input.timeoutMs;
    while (now() < deadline) {
      try {
        await client.request('platform.health.get', {});
      } catch {
        print(ui.ok(t('stop.remote.unreachable')));
        return 0;
      }
      if (now() >= deadline) break;
      await sleep(500);
    }
    printErr(ui.err(t('stop.remote.timeout', { timeout: input.timeoutMs })));
    return 1;
  } finally {
    await client.close().catch(() => undefined);
  }
}

// ── 共享小工具（全部镜像既有先例，不新增状态实体）──

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** CA PEM 读取（control-plane-target readCa 先例：读不到 = 未提供）。 */
async function readCa(file: string | undefined): Promise<string | undefined> {
  if (file === undefined) return undefined;
  try {
    const text = await Bun.file(file).text();
    return text.trim() === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

/** `config.hub.dataDir` 分流时的 hub 目录（gateway-command configuredHubDataDir 先例）。 */
function configuredHubDataDir(config: VesselConfig): string | undefined {
  const configured = config.hub?.dataDir;
  return configured === undefined ? undefined : path.resolve(expandHome(configured));
}

/** poolDir 与平台启动侧同源（gateway-command.ts:2943-2950 先例；homedir 固定）。 */
function poolDirFor(config: VesselConfig): string {
  const poolInstance = config.gateway?.enginePool?.instance;
  return path.join(
    getUserConfigDir(),
    poolInstance !== undefined && poolInstance !== ''
      ? `engine-pool-${poolInstance}`
      : 'engine-pool',
  );
}

/** 池 engine 状态文件清单（只读；缺失目录 = 空）。 */
async function listPoolEngineFiles(poolDir: string): Promise<string[]> {
  const names = await readdir(path.join(poolDir, 'engines')).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith('.json')).sort();
}

/** 残留文件里的 pid（形状不过 / 读不到 = undefined，如实报「pid 不可读」）。 */
async function readEnginePid(file: string): Promise<number | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (isRecord(raw) && typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0) {
      return raw.pid;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * S3 确认（本地/远程同规则）：--yes 跳过；非交互且无 --yes → 拒绝 exit 1；
 * 交互 y/N，N/EOF → 取消 exit 0（零进程被杀）。y/yes 判定照 cli-update promptConfirm 先例。
 */
async function confirmStop(
  yes: boolean | undefined,
  print: (line: string) => void,
  printErr: (line: string) => void,
): Promise<'proceed' | 'cancelled' | 'refused'> {
  if (yes === true) return 'proceed';
  if (!isHumanTerminal()) {
    printErr(ui.err(t('stop.nonInteractive')));
    return 'refused';
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let confirmed = false;
  try {
    const answer = await rl.question(t('stop.confirm.prompt'));
    confirmed = /^(y|yes)$/i.test(answer.trim());
  } catch {
    confirmed = false;
  } finally {
    rl.close();
  }
  if (confirmed) return 'proceed';
  print(ui.info(t('stop.cancelled')));
  return 'cancelled';
}
