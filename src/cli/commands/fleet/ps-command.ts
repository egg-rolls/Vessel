/**
 * `vessel ps` / `vessel gateway ps` / `vessel node ps` / `vessel hub ps`
 * — docker ps 式进程管理（用户裁定 #4）。
 *
 * 表格列：NAME / TYPE / PID / PORT / STATUS / UPTIME。
 * - `vessel ps`：本舰队全部运行中战舰（gateway/node/hub）；
 * - `vessel gateway ps` / `node ps` / `hub ps`：只列对应类型；
 * - `--all`：含已停止（docker ps -a 式）；`--json`：机器可读。
 *
 * 数据源全部是既有运行时文件（单一真相源，不新增状态实体）：
 * - gateway：`collectGatewayState`（platform 锁/pid 记录族，与 gateway status 同读入口）；
 * - node：`nodes.json` registry（缺失 = 隐式单节点，只读 node.json 身份）+ 各 node
 *   自己的 `gateway.pid` 记录（活进程自己写的地址优先）；
 * - hub：`hub.lock`（collectGatewayState 顺带采集，尊重 config.hub.dataDir）。
 *
 * 只读：不 bootstrap、不写锁、不 spawn/停止任何进程、不做网络探活
 * （STATUS = 进程存活判定，与 docker ps 同口径；健康面归 fleet status / gateway status）。
 * 舰队边界：严格限本 dataDir（cli-topology-design §3），抬头打印生效 dataDir。
 *
 * @module vessel/commands/fleet/ps-command
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { loadConfig, type VesselConfig } from '../../../../packages/config/src/index';
import { formatConfigErrors } from '../../../config/config-error-format';
import { expandHome, resolveDataDir } from '../../../data/data-paths';
import { loadNodeRegistry, type NodeRegistryEntry } from '../../../gateway/node-registry';
import {
  collectGatewayState,
  type GatewayStateEntry,
  type GatewayStateSnapshot,
  isProcessAlive,
  readGatewayPidRecord,
} from '../../../gateway/pid';
import { resolveGatewayToken } from '../../../gateway/transport-factory';
import { t } from '../../../i18n';
import { nodeJsonPath } from '../../../node/node-identity';
import { ui } from '../../output';
import { nodeListenFromConfig } from '../gateway/gateway-command';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type PsProcessType = 'gateway' | 'node' | 'hub';

export interface PsCommandOptions {
  /** 类型过滤：缺省 = 全部（gateway/node/hub）。 */
  type?: PsProcessType;
  json?: boolean;
  /** docker ps -a 式：含已停止 / stale / unknown。 */
  all?: boolean;
  dataDir?: string;
  config?: VesselConfig;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** 内部计数探针注入；缺省 collectGatewayState。 */
  collectState?: typeof collectGatewayState;
}

/** 一行进程视图（表格与 --json 共用同一份数据）。 */
interface PsProcess {
  name: string;
  type: PsProcessType;
  pid: number | null;
  port: number | null;
  status: string;
  uptime_seconds: number | null;
  started_at: string | null;
  url?: string;
  /** gateway 实例名（state/reason 来自 collectGatewayState 判定）。 */
  instance?: string;
  state?: GatewayStateEntry['state'];
  reason?: string;
  node_id?: string;
  data_dir?: string;
  /** 默认（无 --all）是否列出：docker ps 只列运行中。 */
  running: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 只读 node.json 身份（与 fleet status 同口径；不创建不改写）。 */
async function readIdentity(
  dataDir: string,
  config: VesselConfig,
): Promise<{ node_id: string | null; name: string | null }> {
  let file: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(nodeJsonPath(dataDir), 'utf8'));
    if (isRecord(parsed)) file = parsed;
  } catch {
    // 缺失 / 损坏：只读视图不修复、不重建。
  }
  const host = isRecord(config.host) ? config.host : {};
  return {
    node_id: pickString(host, 'nodeId') ?? pickString(file, 'node_id') ?? null,
    name: pickString(host, 'nodeName') ?? pickString(file, 'name') ?? null,
  };
}

function uptimeSeconds(startedAt: string | number | undefined, now: number): number | null {
  if (startedAt === undefined) return null;
  const epoch = typeof startedAt === 'number' ? startedAt : Date.parse(startedAt);
  if (!Number.isFinite(epoch)) return null;
  return Math.max(0, Math.floor((now - epoch) / 1000));
}

/** gateway（平台实例）：状态族条目 → 一行。 */
function gatewayProcess(entry: GatewayStateEntry, now: number): PsProcess {
  const record = entry.record;
  const occupied =
    entry.state === 'running' || entry.state === 'degraded' || entry.state === 'starting';
  const startedAt =
    record?.started_at ??
    (entry.lock !== undefined ? new Date(entry.lock.started_at).toISOString() : undefined);
  return {
    name: entry.instance,
    type: 'gateway',
    pid: record?.pid ?? entry.lock?.pid ?? null,
    port: record?.port ?? null,
    status: entry.state === 'absent' ? 'stopped' : entry.state,
    uptime_seconds: occupied ? uptimeSeconds(startedAt, now) : null,
    started_at: startedAt ?? null,
    instance: entry.instance,
    state: entry.state,
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    running: occupied,
  };
}

/** 停止态 node 的端口回落：配置推导（活进程记录优先，见 nodeProcess）。 */
async function fallbackNodePort(
  entry: NodeRegistryEntry,
  config: VesselConfig,
  env: Record<string, string | undefined>,
): Promise<number | null> {
  if (entry.config_path === undefined) return nodeListenFromConfig(config).port;
  try {
    const loaded = await loadConfig({
      configPath: entry.config_path,
      env: { ...env, VESSEL_DATA_DIR: entry.data_dir },
    });
    return nodeListenFromConfig(loaded.config).port;
  } catch {
    return null;
  }
}

/** node：registry 条目 + 该 node 自己的 gateway.pid（活进程自己写的地址优先于配置）。 */
async function nodeProcess(
  entry: NodeRegistryEntry,
  config: VesselConfig,
  env: Record<string, string | undefined>,
  now: number,
): Promise<PsProcess> {
  const record = await readGatewayPidRecord(entry.data_dir).catch(() => null);
  const identityMismatch =
    record !== null &&
    entry.node_id !== undefined &&
    record.node_id !== undefined &&
    record.node_id !== entry.node_id;
  const live = record !== null && isProcessAlive(record.pid) && !identityMismatch ? record : null;
  const port = live !== null ? live.port : await fallbackNodePort(entry, config, env);
  return {
    name: entry.name,
    type: 'node',
    pid: live?.pid ?? record?.pid ?? null,
    port,
    status: live !== null ? 'running' : 'stopped',
    uptime_seconds: live !== null ? uptimeSeconds(live.started_at, now) : null,
    started_at: live?.started_at ?? null,
    node_id: entry.node_id,
    data_dir: entry.data_dir,
    ...(identityMismatch ? { reason: 'node_identity_mismatch' } : {}),
    running: live !== null,
  };
}

/** hub：hub.lock 记录 → 一行（url 里解析端口）。 */
function hubProcess(hub: NonNullable<GatewayStateSnapshot['hub']>, now: number): PsProcess {
  const record = hub.record;
  let port: number | null = null;
  if (record?.url !== undefined) {
    try {
      const parsed = new URL(record.url);
      const explicit = parsed.port !== '' ? Number(parsed.port) : NaN;
      port = Number.isInteger(explicit)
        ? explicit
        : parsed.protocol === 'https:'
          ? 443
          : parsed.protocol === 'http:'
            ? 80
            : null;
    } catch {
      port = null;
    }
  }
  const startedAt = record !== undefined ? new Date(record.started_at).toISOString() : undefined;
  return {
    name: 'hub',
    type: 'hub',
    pid: record?.pid ?? null,
    port,
    status: hub.state,
    uptime_seconds: hub.state === 'running' ? uptimeSeconds(record?.started_at, now) : null,
    started_at: startedAt ?? null,
    ...(record?.url !== undefined ? { url: record.url } : {}),
    ...(hub.reason !== undefined ? { reason: hub.reason } : {}),
    running: hub.state === 'running',
  };
}

/** `config.hub.dataDir` 分流时的 hub 目录；缺省交给 collect 用 `<dataDir>/hub`。 */
function configuredHubDataDir(config: VesselConfig): string | undefined {
  const configured = config.hub?.dataDir;
  return configured === undefined ? undefined : path.resolve(expandHome(configured));
}

async function collectProcesses(
  options: PsCommandOptions,
  config: VesselConfig,
  dataDir: string,
  env: Record<string, string | undefined>,
  now: number,
): Promise<PsProcess[]> {
  const collect = options.collectState ?? collectGatewayState;
  const token = resolveGatewayToken(config, env);
  const hubDataDir = configuredHubDataDir(config);
  const snapshot = await collect(dataDir, {
    ...(token !== undefined ? { token } : {}),
    ...(hubDataDir !== undefined ? { hubDataDir } : {}),
    kind: env.VESSEL_LEGACY_SERVE === '1' ? 'node' : 'platform',
  });

  const rows: PsProcess[] = [];
  const want = (type: PsProcessType): boolean =>
    options.type === undefined || options.type === type;

  if (want('gateway')) {
    for (const entry of snapshot.entries) rows.push(gatewayProcess(entry, now));
  }
  if (want('node')) {
    const load = await loadNodeRegistry(dataDir).catch(() => null);
    let entries: NodeRegistryEntry[];
    if (load !== null && load.kind === 'ready') {
      entries = load.registry.nodes;
    } else {
      // registry 缺失 = 隐式单节点（只读身份，不创建 node.json）。
      const identity = await readIdentity(dataDir, config);
      entries = [
        {
          node_id: identity.node_id ?? '(uninitialized)',
          name: identity.name ?? 'node',
          kind: 'local',
          data_dir: dataDir,
          auto_start: true,
        },
      ];
    }
    for (const entry of entries) rows.push(await nodeProcess(entry, config, env, now));
  }
  if (want('hub') && snapshot.hub !== undefined) {
    rows.push(hubProcess(snapshot.hub, now));
  }
  return rows;
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

function statusText(status: string): string {
  if (status === 'running') return ui.ok(status);
  if (status === 'starting' || status === 'degraded') return ui.warn(status);
  if (status === 'stopped') return ui.dim(status);
  return ui.err(status);
}

const PS_COLUMNS = ['NAME', 'TYPE', 'PID', 'PORT', 'STATUS', 'UPTIME'] as const;

function renderTable(rows: PsProcess[]): string {
  const cells = rows.map((row) => [
    row.name,
    row.type,
    row.pid === null ? '-' : String(row.pid),
    row.port === null ? '-' : String(row.port),
    row.status,
    row.uptime_seconds === null ? '-' : formatUptime(row.uptime_seconds),
  ]);
  const widths = PS_COLUMNS.map((header, index) =>
    Math.max(header.length, ...cells.map((cell) => (cell[index] ?? '').length)),
  );
  const pad = (cell: string, index: number): string => cell.padEnd(widths[index] ?? 0);
  const lines = [ui.dim(PS_COLUMNS.map((header, index) => pad(header, index)).join('  '))];
  for (const cell of cells) {
    const padded = cell.map((value, index) => pad(value, index));
    // STATUS 列先 pad 再着色（ANSI 不计入列宽）。
    padded[4] = statusText(padded[4] ?? '');
    lines.push(padded.join('  '));
  }
  return lines.join('\n');
}

interface PsPayload {
  as_of: string;
  data_dir: string;
  type?: PsProcessType;
  all: boolean;
  processes: Array<Omit<PsProcess, 'running'>>;
}

/**
 * `vessel ps [--all] [--json]`（及 gateway/node/hub ps 类型过滤）。
 * 只读清点；退出码只反映采集是否成功（空列表也是 0，与 docker ps 一致）。
 */
export async function psCommand(options: PsCommandOptions = {}): Promise<CommandResult> {
  const env = options.env ?? process.env;
  const now = (options.now ?? Date.now)();
  const json = options.json === true;
  const all = options.all === true;

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
  const collected = await collectProcesses(options, config, dataDir, env, now);
  const rows = all ? collected : collected.filter((row) => row.running);

  if (json) {
    const payload: PsPayload = {
      as_of: new Date(now).toISOString(),
      data_dir: dataDir,
      ...(options.type !== undefined ? { type: options.type } : {}),
      all,
      processes: rows.map(({ running: _running, ...rest }) => rest),
    };
    return { exitCode: 0, stdout: JSON.stringify(payload, null, 2), stderr: '' };
  }

  const lines = [ui.title(t('ps.title')), ui.dim(`data_dir ${dataDir}`), ui.rule(48)];
  if (rows.length === 0) {
    lines.push(ui.dim(all ? t('ps.emptyAll') : t('ps.empty')));
  } else {
    lines.push(renderTable(rows));
  }
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}
