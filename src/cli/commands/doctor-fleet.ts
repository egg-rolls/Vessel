/**
 * `vessel doctor` 的舰队专项检查（q-ax-config②：AX 自服务·诊断组）。
 * @module vessel/doctor-fleet
 *
 * 在既有 doctor 检查（config/provider/data_dir/tokens/exposure/serve_port/web…）
 * 之外 additive 补五项舰队体检，全部严格限本舰队 dataDir（resolveContext 解析值）：
 *
 * - env_hygiene：VESSEL_DATA_DIR / VESSEL_TOOL_OUTPUT_DIR / VESSEL_PLUGIN_CONFIG
 *   与本舰队 dataDir 的一致性（T2b 继承异根是金丝雀真实踩过的坑）；
 *   `--user-config` 显式切换时 env 层仍然压过 user 层 data_dir —— 此态显式报告。
 * - locks：pid 记录 / 锁 vs 进程存活（复用 collectGatewayState 单一读入口）。
 * - fleet_ports：配置端口 vs 实际监听归属（本舰队活进程占用 = 正常；外来进程 = 警告）。
 * - peers：federation peer token 在位（只报环境变量名，绝不回显 token 值）。
 * - node_health：本地 node 记录 + /health 只读探活（不发送 token）。
 *
 * 只读语义：不写任何文件、不改 env、不 spawn 进程；HTTP 探针均为 GET /health
 * 或 health.get（与 gateway status 同一套既有判据）。
 */

import * as path from 'node:path';
import {
  type ConfigLayers,
  DEFAULT_GATEWAY_OPTIONS,
  expandHomePath,
  type VesselConfig,
} from '../../../packages/config/src/index';
import { expandHome } from '../../data/data-paths';
import {
  collectGatewayState,
  type GatewayStateKind,
  isProcessAlive,
  readGatewayPidRecord,
} from '../../gateway/pid';
import { resolveGatewayToken } from '../../gateway/transport-factory';
import { deriveToolOutputDir, isWithinDir } from '../../runtime/tool-output-env';
import {
  nodeListenFromConfig,
  preferLiveNodeListen,
  probeHttpHealth,
} from './gateway/gateway-command';

/** 与 doctor-command 的 Check 同形（结构类型兼容，直接 push 进 checks）。 */
export interface FleetCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  message: string;
}

export interface FleetChecksInput {
  config: VesselConfig;
  env: Record<string, string | undefined>;
  /** 本舰队数据根（resolveDataDir 的解析值）——所有检查的唯一边界。 */
  dataDir: string;
  /** loadConfig({captureLayers:true}) 的层快照（env_hygiene 用；缺省跳过该对比）。 */
  layers?: ConfigLayers;
  /** 端口绑定探针（doctor-command 注入，避免重复实现）。 */
  checkPort: (host: string, port: number) => Promise<'available' | 'in_use' | 'error'>;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** 路径相等（win32 大小写不敏感；与 pid.ts sameHostName 同一口径）。 */
function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** env 卫生：三个沿启动链继承的 env 是否仍指向本舰队。 */
function envHygieneCheck(input: FleetChecksInput): FleetCheck {
  const { config, env, dataDir, layers } = input;
  const root = path.resolve(dataDir);
  const issues: string[] = [];

  // --user-config 只替换用户层；env 层照旧压过它。两层 data_dir 不一致时
  // 「我明明切了舰队配置，数据怎么还落在老地方」就是这里要说清的事。
  const userDataDir = nonEmpty(layers?.user?.dataDir);
  const envDataDir = nonEmpty(env.VESSEL_DATA_DIR);
  if (
    userDataDir !== undefined &&
    envDataDir !== undefined &&
    !samePath(expandHomePath(userDataDir), expandHomePath(envDataDir))
  ) {
    issues.push(
      `user config data_dir=${userDataDir} is overridden by VESSEL_DATA_DIR=${envDataDir} ` +
        '(env wins over the user layer even with --user-config; unset VESSEL_DATA_DIR to let the user config win)',
    );
  }

  const toolOutputDir = nonEmpty(env.VESSEL_TOOL_OUTPUT_DIR);
  if (toolOutputDir !== undefined && !isWithinDir(root, toolOutputDir)) {
    issues.push(
      `VESSEL_TOOL_OUTPUT_DIR=${toolOutputDir} is outside this fleet's dataDir ` +
        `(inherited from another fleet? spawn paths sanitize it, but this shell's value is foreign; ` +
        `unset it or set ${deriveToolOutputDir(root)})`,
    );
  }

  const pluginConfigRaw = nonEmpty(env.VESSEL_PLUGIN_CONFIG);
  if (pluginConfigRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(pluginConfigRaw);
    } catch {
      parsed = undefined;
      issues.push('VESSEL_PLUGIN_CONFIG is not valid JSON (spawn paths will drop it)');
    }
    if (parsed !== undefined) {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        issues.push('VESSEL_PLUGIN_CONFIG is not a JSON object (spawn paths will drop it)');
      } else {
        const record = parsed as Record<string, unknown>;
        for (const field of ['dataDir', 'toolOutputDir'] as const) {
          const value = nonEmpty(record[field]);
          if (value !== undefined && !isWithinDir(root, value)) {
            issues.push(
              `VESSEL_PLUGIN_CONFIG.${field}=${value} is outside this fleet's dataDir ` +
                '(inherited from another fleet? spawn paths rewrite it)',
            );
          }
        }
      }
    }
  }

  // config 里显式写的 dataDir 与生效根不一致（env/CLI 压住）也值得看一眼。
  const configuredDataDir = nonEmpty(config.dataDir);
  if (
    configuredDataDir !== undefined &&
    !samePath(expandHome(configuredDataDir), root) &&
    envDataDir === undefined
  ) {
    issues.push(
      `config data_dir=${configuredDataDir} but effective dataDir=${root} (CLI --data-dir wins)`,
    );
  }

  return {
    name: 'env_hygiene',
    status: issues.length > 0 ? 'warn' : 'ok',
    message:
      issues.length > 0
        ? issues.join('; ')
        : `VESSEL_DATA_DIR / TOOL_OUTPUT_DIR / PLUGIN_CONFIG consistent with ${root}`,
  };
}

/** stale lock / pid 记录：复用 gateway status 的单一状态读入口（两族都看）。 */
async function locksCheck(input: FleetChecksInput): Promise<FleetCheck> {
  const { config, env, dataDir } = input;
  const token = resolveGatewayToken(config, env);
  const hubDataDir = nonEmpty(config.hub?.dataDir);
  const stale: string[] = [];
  const live: string[] = [];
  let sawRecord = false;

  for (const kind of ['platform', 'node'] as GatewayStateKind[]) {
    const snapshot = await collectGatewayState(dataDir, {
      kind,
      ...(token !== undefined ? { token } : {}),
      ...(hubDataDir !== undefined ? { hubDataDir: path.resolve(expandHome(hubDataDir)) } : {}),
    });
    for (const entry of snapshot.entries) {
      if (entry.state === 'absent') continue;
      sawRecord = true;
      const pid = entry.record?.pid ?? entry.lock?.pid;
      const label = `${kind}:${entry.instance}`;
      if (entry.state === 'stale') {
        stale.push(
          `${label} stale (${entry.reason ?? 'dead'}${pid !== undefined ? `, pid ${pid}` : ''}) — ` +
            `reclaimed on next start, or: vessel gateway stop ${entry.instance}`,
        );
      } else {
        live.push(`${label}=${entry.state}${pid !== undefined ? ` (pid ${pid})` : ''}`);
      }
    }
    if (snapshot.hub !== undefined && snapshot.hub.state === 'stale') {
      stale.push(`hub stale (${snapshot.hub.reason ?? 'dead'}) — reclaimed on next hub start`);
    }
  }

  if (!sawRecord) {
    return { name: 'locks', status: 'info', message: 'no gateway pid/lock records in this fleet' };
  }
  if (stale.length > 0) {
    return { name: 'locks', status: 'warn', message: stale.join('; ') };
  }
  return { name: 'locks', status: 'ok', message: live.join(' · ') };
}

/** 端口占用归属：本舰队/vessel 监听 = 正常；外来进程 = 警告。 */
async function portOwnership(
  input: FleetChecksInput,
  host: string,
  port: number,
  tls: boolean,
  label: string,
): Promise<{ status: 'ok' | 'warn' | 'info'; message: string }> {
  const status = await input.checkPort(host, port);
  if (status === 'available') return { status: 'ok', message: `${label} ${host}:${port} free` };
  if (status === 'error') {
    return { status: 'warn', message: `${label} ${host}:${port} check failed` };
  }
  const health = await probeHttpHealth(
    { pid: 0, started_at: new Date(0).toISOString(), host, port, version: '0' },
    800,
    tls,
  );
  if (health?.role === 'platform') {
    return {
      status: 'info',
      message: `${label} ${host}:${port} held by a vessel platform listener`,
    };
  }
  if (typeof health?.node_id === 'string') {
    return {
      status: 'info',
      message: `${label} ${host}:${port} held by vessel node ${health.node_id}`,
    };
  }
  return {
    status: 'warn',
    message:
      `${label} ${host}:${port} in use by a non-vessel (or unresponsive) process — ` +
      'stop the occupant or change the configured port',
  };
}

/** 配置端口 vs 实际监听：活进程自己写的地址优先（preferLiveNodeListen 同一判据）。 */
async function fleetPortsCheck(input: FleetChecksInput): Promise<FleetCheck> {
  const { config, dataDir } = input;
  const tls = config.node?.tls !== undefined;
  const configured = nodeListenFromConfig(config);
  const live = await preferLiveNodeListen(dataDir, configured, { tls });
  const parts: Array<{ status: 'ok' | 'warn' | 'info'; message: string }> = [];

  if (live.source === 'record' && live.listen.port !== configured.port) {
    parts.push({
      status: 'warn',
      message:
        `config node.port=${configured.port} but the live node (pid ${live.pid ?? '?'}) ` +
        `listens on ${live.listen.port} — port changes need a restart to apply`,
    });
  }
  parts.push(await portOwnership(input, configured.host, configured.port, tls, 'node'));

  // 平台端口只在显式配置时查（缺省 8642 不强制；避免与本机无关服务误报）。
  if (config.gateway?.port !== undefined) {
    const host = config.gateway.hostname ?? DEFAULT_GATEWAY_OPTIONS.hostname;
    parts.push(await portOwnership(input, host, config.gateway.port, false, 'platform'));
  }

  const worst = parts.some((part) => part.status === 'warn')
    ? 'warn'
    : parts.some((part) => part.status === 'info')
      ? 'info'
      : 'ok';
  return {
    name: 'fleet_ports',
    status: worst,
    message: parts.map((part) => part.message).join('; '),
  };
}

/** federation peer token 在位（只报变量名 / 来源类别，绝不回显值）。 */
function peersCheck(input: FleetChecksInput): FleetCheck | undefined {
  const { config, env } = input;
  const federation = config.federation;
  const peers = federation?.peers ?? [];
  if (federation === undefined && peers.length === 0) return undefined;
  if (peers.length === 0) {
    return { name: 'peers', status: 'info', message: 'federation configured but no peers' };
  }

  const problems: string[] = [];
  const rows: string[] = [];
  const envVarOwners = new Map<string, string[]>();
  for (const peer of peers) {
    const label = `${peer.nodeId ?? '?'}:${peer.teamId ?? '?'}`;
    if (peer.tokenSecret === true) {
      rows.push(`${label}=secret-store (resolved at runtime; not read here)`);
      continue;
    }
    const varName = nonEmpty(peer.tokenEnv);
    if (varName === undefined) {
      problems.push(`${label}: no token_env / token_secret — peer is dropped (fail-closed)`);
      continue;
    }
    const owners = envVarOwners.get(varName) ?? [];
    owners.push(label);
    envVarOwners.set(varName, owners);
    if (nonEmpty(env[varName]) !== undefined) {
      rows.push(`${label}=env ${varName} <set>`);
    } else {
      problems.push(
        `${label}: env ${varName} is unset — peer will be dropped (fail-closed); set it or re-pair`,
      );
    }
    if ((peer.direction ?? 'both') !== 'in' && nonEmpty(peer.url) === undefined) {
      problems.push(`${label}: direction includes out but url is missing`);
    }
  }
  for (const [varName, owners] of envVarOwners) {
    if (owners.length > 1) {
      problems.push(
        `peers ${owners.join(', ')} share token_env ${varName} — runtime drops ALL of them ` +
          '(duplicate_token); give each peer its own token',
      );
    }
  }
  if (federation?.enabled === false) {
    problems.push('federation.enabled=false — configured peers are inactive');
  }

  if (problems.length > 0) {
    return {
      name: 'peers',
      status: problems.some((problem) => problem.includes('unset') || problem.includes('no token'))
        ? 'fail'
        : 'warn',
      message: problems.join('; '),
    };
  }
  return { name: 'peers', status: 'ok', message: rows.join(' · ') };
}

/**
 * 本地 node 健康：pid 记录 + /health 只读探活（--deep 的 RPC 检查之外的轻量补位）。
 * 拆分模式下 node 族记录可能不在本 dataDir —— 回退看 platform 族记录（同一 dataDir），
 * 探活口径不变（GET /health，不发送 token）。
 */
async function nodeHealthCheck(input: FleetChecksInput): Promise<FleetCheck> {
  const { config, dataDir } = input;
  let record = await readGatewayPidRecord(dataDir).catch(() => null);
  let family = 'node';
  if (record === null) {
    record = await readGatewayPidRecord(dataDir, undefined, 'platform').catch(() => null);
    family = 'platform';
  }
  if (record === null) {
    return {
      name: 'node_health',
      status: 'info',
      message: 'no local node/platform pid record (start with: vessel gateway start)',
    };
  }
  if (!isProcessAlive(record.pid)) {
    return {
      name: 'node_health',
      status: 'warn',
      message: `${family} record pid ${record.pid} is dead (stale; see locks) — vessel gateway start`,
    };
  }
  const health = await probeHttpHealth(
    record,
    800,
    family === 'node' && config.node?.tls !== undefined,
  );
  if (health === undefined) {
    return {
      name: 'node_health',
      status: 'warn',
      message:
        `pid ${record.pid} alive but ${record.host}:${record.port}/health unresponsive — ` +
        'check gateway logs (vessel logs tail)',
    };
  }
  if (health.role === 'platform') {
    return {
      name: 'node_health',
      status: 'ok',
      message: `platform up (pid ${record.pid}, ${record.host}:${record.port})`,
    };
  }
  const nodeId = typeof health.node_id === 'string' ? health.node_id : (record.node_id ?? '?');
  return {
    name: 'node_health',
    status: 'ok',
    message: `node ${nodeId} up (pid ${record.pid}, ${record.host}:${record.port})`,
  };
}

/** 舰队五项检查（顺序固定：env_hygiene → locks → fleet_ports → peers → node_health）。 */
export async function collectFleetChecks(input: FleetChecksInput): Promise<FleetCheck[]> {
  const checks: FleetCheck[] = [];
  checks.push(envHygieneCheck(input));
  checks.push(await locksCheck(input));
  checks.push(await fleetPortsCheck(input));
  const peers = peersCheck(input);
  if (peers !== undefined) checks.push(peers);
  checks.push(await nodeHealthCheck(input));
  return checks;
}
