/**
 * `vessel fleet status [--json]` — AX 自服务 · 舰队总览（发现组）。
 *
 * 一屏显示**本舰队**（严格本 dataDir）的身份与运行面：
 * - identity：node_id / name / dataDir（只读 `<dataDir>/node.json`，不创建不改写；
 *   配置 host.nodeId / host.nodeName 优先，与 resolveNodeIdentity 同语义但零写入）；
 * - gateway：平台实例 port / pid / uptime（collectGatewayState，与 gateway status 同读入口）；
 * - nodes：nodes.json 注册表 + /health 探活；managed = 平台 spawn/adopt（platform-children
 *   manifest 在案），external = 在案之外（手工/外部启动）；registry 缺失 = 隐式单节点；
 * - peers：config federation.peers + SecretStore/env token **在位**判定（绝不输出 token 值）
 *   + 对端 `/health` 只读探活（有 url 才探；不操作对端）。
 *
 * 只读：不 bootstrap、不获取 tenant 写锁、不 spawn/停止任何进程。
 * `--data-dir` / `--user-config` 经全局 env 生效（cli.ts 入口统一落 env）。
 * 人类可读走 ui + i18n（数据行英文）；`--json` 纯数据无 ANSI。
 *
 * @module vessel/commands/fleet/fleet-status-command
 */

import { readFile } from 'node:fs/promises';
import { loadConfig, type VesselConfig } from '../../../../packages/config/src/index';
import { formatConfigErrors } from '../../../config/config-error-format';
import { resolveDataDir } from '../../../data/data-paths';
import { loadFederationPeerSecrets } from '../../../federation/federation-secrets';
import { loadNodeRegistry, type NodeRegistryEntry } from '../../../gateway/node-registry';
import { readSpawnedChildren } from '../../../gateway/node-supervisor';
import { collectGatewayState, type GatewayStateEntry } from '../../../gateway/pid';
import { gatewayBaseUrl } from '../../../gateway/reload';
import { resolveGatewayToken } from '../../../gateway/transport-factory';
import { t } from '../../../i18n';
import { nodeJsonPath } from '../../../node/node-identity';
import { readPackageVersion } from '../../../shared/version';
import { ui } from '../../output';
import { nodeListenFromConfig, probeHttpHealth } from '../gateway/gateway-command';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FleetStatusOptions {
  json?: boolean;
  dataDir?: string;
  config?: VesselConfig;
  env?: Record<string, string | undefined>;
  now?: () => number;
  version?: string;
  /** 内部计数探针注入；缺省 collectGatewayState。 */
  collectState?: typeof collectGatewayState;
}

type Health = 'up' | 'down' | 'n/a';
type NodeOrigin = 'managed' | 'external';

interface IdentityView {
  node_id: string | null;
  name: string | null;
  /** node.json 是否已在案（未初始化时身份来自配置或空缺）。 */
  initialized: boolean;
}

interface GatewayInstanceView {
  instance: string;
  state: GatewayStateEntry['state'];
  running: boolean;
  pid?: number;
  host?: string;
  port?: number;
  url?: string;
  started_at?: string;
  uptime_seconds?: number;
  version?: string;
  node_id?: string;
  reason?: string;
}

interface NodeView {
  node_id: string;
  name: string;
  origin: NodeOrigin;
  status: 'up' | 'down' | 'unknown';
  api_url?: string;
  data_dir: string;
  auto_start: boolean;
}

interface PeerView {
  node_id: string;
  team_id: string;
  direction: 'in' | 'out' | 'both';
  /** token 来源：env 变量名或 secret-store；绝不输出 token 值。 */
  token_source: string;
  token_set: boolean;
  url?: string;
  health: Health;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// ── identity（只读 node.json；配置优先；零写入）─────────────────────

async function readIdentity(dataDir: string, config: VesselConfig): Promise<IdentityView> {
  let file: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(nodeJsonPath(dataDir), 'utf8'));
    if (isRecord(parsed)) file = parsed;
  } catch {
    // 缺失 / 损坏：只读视图不修复、不重建（创建归 resolveNodeIdentity 的启动路径）。
  }
  const fileId = pickString(file, 'node_id');
  const fileName = pickString(file, 'name');
  const host = isRecord(config.host) ? config.host : {};
  return {
    node_id: pickString(host, 'nodeId') ?? fileId ?? null,
    name: pickString(host, 'nodeName') ?? fileName ?? null,
    initialized: fileId !== undefined,
  };
}

// ── gateway（平台实例；与 gateway status 同读入口）──────────────────

function gatewayInstanceView(
  entry: GatewayStateEntry,
  config: VesselConfig,
  now: () => number,
): GatewayInstanceView {
  const record = entry.record;
  if (record === undefined) {
    return {
      instance: entry.instance,
      state: entry.state,
      running: false,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    };
  }
  return {
    instance: entry.instance,
    state: entry.state,
    running: entry.state === 'running' || entry.state === 'degraded',
    pid: record.pid,
    host: record.host,
    port: record.port,
    url: gatewayBaseUrl(record, config.node?.tls !== undefined),
    started_at: record.started_at,
    uptime_seconds: Math.max(0, Math.floor((now() - Date.parse(record.started_at)) / 1000)),
    version: record.version,
    ...(record.node_id !== undefined ? { node_id: record.node_id } : {}),
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
  };
}

/** 平台监督在案的 node_id（spawn 或 adopt；hub 子进程不算 node）。 */
async function managedNodeIds(dataDir: string, entries: GatewayStateEntry[]): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.state !== 'running' && entry.state !== 'degraded' && entry.state !== 'starting') {
      continue;
    }
    for (const child of await readSpawnedChildren(dataDir, entry.instance)) {
      if (child.kind !== 'hub') ids.add(child.node_id);
    }
  }
  return ids;
}

// ── nodes（registry + 探活；managed/external 分类）──────────────────

async function nodeListen(
  entry: NodeRegistryEntry,
  config: VesselConfig,
  env: Record<string, string | undefined>,
): Promise<{ host: string; port: number; url: string; tls: boolean } | undefined> {
  if (entry.config_path === undefined) {
    const listen = nodeListenFromConfig(config);
    return { ...listen, tls: config.node?.tls !== undefined };
  }
  try {
    const { config: nodeConfig } = await loadConfig({ configPath: entry.config_path, env });
    const listen = nodeListenFromConfig(nodeConfig);
    return { ...listen, tls: nodeConfig.node?.tls !== undefined };
  } catch {
    return undefined;
  }
}

async function nodeView(
  entry: NodeRegistryEntry,
  config: VesselConfig,
  env: Record<string, string | undefined>,
  managed: ReadonlySet<string>,
): Promise<NodeView> {
  const origin: NodeOrigin = managed.has(entry.node_id) ? 'managed' : 'external';
  const base = {
    node_id: entry.node_id,
    name: entry.name,
    origin,
    data_dir: entry.data_dir,
    auto_start: entry.auto_start,
  };
  const listen = await nodeListen(entry, config, env);
  if (listen === undefined) return { ...base, status: 'unknown' };
  const health = await probeHttpHealth(
    {
      pid: 0,
      started_at: new Date(0).toISOString(),
      host: listen.host,
      port: listen.port,
      version: '0',
    },
    800,
    listen.tls,
  );
  // 平台监听也可能占该端口：/health 带 role:"platform" 时不算 node up（与 gateway nodes list 同口径）。
  const status = health !== undefined && health.role !== 'platform' ? 'up' : 'down';
  return { ...base, status, api_url: listen.url };
}

// ── peers（token 在位 + 对端 /health 只读探活）──────────────────────

/** 对端 health：只读 GET /health；无 url（纯入站 peer）不探，绝不操作对端。 */
async function peerHealth(url: string | undefined): Promise<Health> {
  if (url === undefined || url === '') return 'n/a';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'down';
  }
  const tls = parsed.protocol === 'https:';
  const port = parsed.port !== '' ? Number(parsed.port) : tls ? 443 : 80;
  const health = await probeHttpHealth(
    { pid: 0, started_at: new Date(0).toISOString(), host: parsed.hostname, port, version: '0' },
    800,
    tls,
  );
  return health !== undefined ? 'up' : 'down';
}

async function peerViews(
  config: VesselConfig,
  dataDir: string,
  env: Record<string, string | undefined>,
): Promise<PeerView[]> {
  const configured = Array.isArray(config.federation?.peers) ? config.federation.peers : [];
  const secrets = await loadFederationPeerSecrets({
    dataDir,
    ...(config.federation !== undefined ? { federation: config.federation } : {}),
  });
  const views: PeerView[] = [];
  for (const peer of configured) {
    if (!isRecord(peer)) continue;
    const nodeId = pickString(peer, 'nodeId');
    const teamId = pickString(peer, 'teamId');
    if (nodeId === undefined || teamId === undefined) continue;
    const tokenSecret = peer.tokenSecret === true;
    const tokenEnv = pickString(peer, 'tokenEnv');
    if (!tokenSecret && tokenEnv === undefined) continue;
    const direction = peer.direction === 'in' || peer.direction === 'out' ? peer.direction : 'both';
    const token = tokenSecret ? secrets[`${nodeId}:${teamId}`] : env[tokenEnv as string];
    const url = pickString(peer, 'url');
    views.push({
      node_id: nodeId,
      team_id: teamId,
      direction,
      token_source: tokenSecret ? 'secret-store' : (tokenEnv as string),
      token_set: typeof token === 'string' && token !== '',
      ...(url !== undefined ? { url } : {}),
      health: await peerHealth(url),
    });
  }
  return views;
}

// ── 渲染 ────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${seconds % 60}s`;
}

function healthText(health: Health | NodeView['status']): string {
  if (health === 'up') return ui.ok(health);
  if (health === 'down') return ui.err(health);
  return ui.dim(health);
}

interface FleetPayload {
  as_of: string;
  version: string;
  data_dir: string;
  identity: IdentityView;
  gateway: GatewayInstanceView[];
  nodes: NodeView[];
  federation: { enabled: boolean; peers: PeerView[] };
}

function renderHuman(payload: FleetPayload): string {
  const lines: string[] = [
    ui.title(t('fleet.title')),
    ui.rule(48),
    ui.kv('node_id', payload.identity.node_id ?? '-', 10),
    ui.kv('name', payload.identity.name ?? '-', 10),
    ui.kv('data_dir', payload.data_dir, 10),
  ];
  if (!payload.identity.initialized) lines.push(ui.dim(`  ${t('fleet.identityMissing')}`));

  lines.push('', ui.section(t('fleet.gateway')));
  const live = payload.gateway.filter((view) => view.running);
  if (live.length === 0) {
    lines.push(`  ${ui.dim(t('fleet.gatewayDown'))}`);
  } else {
    for (const view of live) {
      const uptime =
        view.uptime_seconds !== undefined ? `  up ${formatUptime(view.uptime_seconds)}` : '';
      lines.push(
        `  ${ui.brand(view.instance)}  ${healthText('up')}  pid ${view.pid ?? '-'}  port ${view.port ?? '-'}${uptime}  v${view.version ?? '?'}`,
      );
    }
  }

  lines.push('', ui.section(`${t('fleet.nodes')} (${payload.nodes.length})`));
  if (payload.nodes.length === 0) lines.push(`  ${ui.dim(t('fleet.noNodes'))}`);
  const nameWidth = Math.max(4, ...payload.nodes.map((node) => node.name.length));
  for (const node of payload.nodes) {
    lines.push(
      `  ${ui.brand(node.name.padEnd(nameWidth))}  ${node.origin.padEnd(8)} ${healthText(node.status).padEnd(12)} ${node.api_url ?? '-'}`,
    );
    lines.push(ui.dim(`    node_id: ${node.node_id}  data_dir: ${node.data_dir}`));
  }

  const fed = payload.federation;
  lines.push(
    '',
    ui.section(
      `${t('fleet.peers')} (${fed.peers.length})  ${fed.enabled ? t('fleet.fedEnabled') : t('fleet.fedDisabled')}`,
    ),
  );
  if (fed.peers.length === 0) lines.push(`  ${ui.dim(t('fleet.noPeers'))}`);
  for (const peer of fed.peers) {
    const token = peer.token_set
      ? ui.ok(`set (${peer.token_source})`)
      : ui.warn(`unset (${peer.token_source})`);
    lines.push(
      `  ${ui.brand(peer.node_id)}  team ${peer.team_id}  ${peer.direction}  token ${token}  health ${healthText(peer.health)}`,
    );
  }
  return lines.join('\n');
}

/** `vessel fleet status`：本舰队一屏总览；只读，退出码只反映采集是否成功。 */
export async function fleetStatusCommand(options: FleetStatusOptions = {}): Promise<CommandResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const json = options.json === true;

  let config: VesselConfig;
  let validationErrors: Array<{ path: string; message: string }> = [];
  let configPaths: { user: string; project: string } = { user: '', project: '' };
  if (options.config !== undefined) {
    config = options.config;
  } else {
    const loaded = await loadConfig({ env });
    config = loaded.config;
    validationErrors = loaded.validation.errors;
    configPaths = loaded.paths;
  }
  if (validationErrors.length > 0) {
    return {
      exitCode: 1,
      stdout: json
        ? JSON.stringify({
            errors: validationErrors.map(({ path, message }) => ({ path, message })),
          })
        : '',
      stderr: formatConfigErrors(validationErrors, { paths: configPaths }),
    };
  }

  const dataDir = options.dataDir ?? resolveDataDir(config, env);
  const identity = await readIdentity(dataDir, config);

  // gateway：平台状态族（legacy env 下退回 node 族，与 gateway status 同口径）。
  const collectState = options.collectState ?? collectGatewayState;
  const token = resolveGatewayToken(config, env);
  const snapshot = await collectState(dataDir, {
    ...(token !== undefined ? { token } : {}),
    kind: env.VESSEL_LEGACY_SERVE === '1' ? 'node' : 'platform',
  });
  const gateway = snapshot.entries.map((entry) => gatewayInstanceView(entry, config, now));

  // nodes：registry 在案 → 逐条探活；缺失 → 隐式单节点（只读身份，不创建 node.json）。
  const managed = await managedNodeIds(dataDir, snapshot.entries);
  const load = await loadNodeRegistry(dataDir);
  const entries: NodeRegistryEntry[] =
    load.kind === 'ready'
      ? load.registry.nodes
      : [
          {
            node_id: identity.node_id ?? '(uninitialized)',
            name: identity.name ?? 'node',
            kind: 'local',
            data_dir: dataDir,
            auto_start: true,
          },
        ];
  const nodes = await Promise.all(entries.map((entry) => nodeView(entry, config, env, managed)));

  const peers = await peerViews(config, dataDir, env);
  const payload: FleetPayload = {
    as_of: new Date(now()).toISOString(),
    version: options.version ?? readPackageVersion(),
    data_dir: dataDir,
    identity,
    gateway,
    nodes,
    federation: { enabled: config.federation?.enabled === true, peers },
  };

  if (json) return { exitCode: 0, stdout: JSON.stringify(payload, null, 2), stderr: '' };
  return { exitCode: 0, stdout: renderHuman(payload), stderr: '' };
}
