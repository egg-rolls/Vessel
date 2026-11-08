/**
 * `vessel gateway nodes list|add|remove`（0.49 G3a / CONTRACT-0.49-node-g3 §6）。
 *
 * - 读写 `<gatewayDataDir>/nodes.json`（经 `gateway/node-registry`）；
 * - `add` 在写 registry 前完成 config / 身份 / data_dir / 端口 / 唯一性早期校验，
 *   失败不写 registry、不创建 node 数据目录；
 * - `remove` 只改 registry；节点运行中时拒绝；
 * - 输出永不含 token。
 *
 * @module vessel/gateway-nodes-command
 */

import { existsSync } from 'node:fs';
import * as net from 'node:net';
import {
  DEFAULT_GATEWAY_OPTIONS,
  DEFAULT_SERVE_OPTIONS,
  loadConfig,
  loadConfigFromFile,
  resolveGatewayNodePorts,
  type VesselConfig,
} from '../packages/config/src/index';
import type { GatewayNodesCommand } from './cli-args';
import { resolveDataDir } from './data-paths';
import {
  assertNodeDataDirMatches,
  assertRegistryEntryUnique,
  deleteNodeRegistry,
  loadNodeRegistry,
  NODE_REGISTRY_VERSION,
  type NodeRegistry,
  type NodeRegistryEntry,
  NodeRegistryError,
  nodeRegistryPath,
  normalizeRegistryNodeName,
  normalizeRegistryPath,
  resolveNodeIdForRegistryAdd,
  synthesizeImplicitNode,
  writeNodeRegistry,
} from './gateway/node-registry';
import { isProcessAlive, readGatewayPidRecord } from './gateway/pid';
import { nodeListenFromConfig, probeHttpHealth } from './gateway-command';
import { HUB_DEFAULT_PORT } from './hub/server';
import { ui } from './ui-style';

export interface GatewayNodesCommandDeps {
  /** gateway data dir（缺省 `resolveDataDir(config, env)`）。 */
  dataDir?: string;
  /** 平台配置（缺省 `loadConfig()`）。 */
  config?: VesselConfig;
  env?: Record<string, string | undefined>;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  /** 端口占用探测；缺省绑定一次后释放。 */
  isPortAvailable?: (host: string, port: number) => Promise<boolean>;
}

interface ResolvedContext {
  config: VesselConfig;
  env: Record<string, string | undefined>;
  gatewayDataDir: string;
}

type NodeStatus = 'up' | 'down' | 'unknown';

interface NodeListView extends NodeRegistryEntry {
  api_url?: string;
  status: NodeStatus;
}

async function resolveContext(deps: GatewayNodesCommandDeps): Promise<ResolvedContext> {
  const env = deps.env ?? process.env;
  const config = deps.config ?? (await loadConfig({ env })).config;
  return {
    config,
    env,
    gatewayDataDir: deps.dataDir ?? resolveDataDir(config, env),
  };
}

function reportFailure(error: unknown, printErr: (line: string) => void): number {
  if (error instanceof NodeRegistryError) {
    printErr(ui.err(`${error.code}: ${error.message}`));
    return 1;
  }
  const detail = error instanceof Error ? error.message : String(error);
  printErr(ui.err(`registry_error: ${detail}`));
  return 1;
}

/** 端口是否可用（绑定一次后立即释放；与 doctor 的探测口径一致）。 */
function checkPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        // 已关闭 / 未监听
      }
      resolve(available);
    };
    server.once('error', () => finish(false));
    server.listen({ host, port, exclusive: true }, () => finish(true));
    const timer = setTimeout(() => finish(false), 1000);
    (timer as { unref?: () => void }).unref?.();
  });
}

async function listenForEntry(
  entry: NodeRegistryEntry,
  platformConfig: VesselConfig,
  env: Record<string, string | undefined>,
): Promise<{ ok: true; host: string; port: number; url: string; tls: boolean } | { ok: false }> {
  if (entry.config_path === undefined) {
    // 隐式单节点：端口 / TLS 来自全局配置。
    const listen = nodeListenFromConfig(platformConfig);
    return {
      ok: true,
      host: listen.host,
      port: listen.port,
      url: listen.url,
      tls: platformConfig.serve?.tls !== undefined,
    };
  }
  try {
    const { config } = await loadConfig({ configPath: entry.config_path, env });
    const listen = nodeListenFromConfig(config);
    return {
      ok: true,
      host: listen.host,
      port: listen.port,
      url: listen.url,
      tls: config.serve?.tls !== undefined,
    };
  } catch {
    return { ok: false };
  }
}

async function statusForEntry(
  entry: NodeRegistryEntry,
  platformConfig: VesselConfig,
  env: Record<string, string | undefined>,
): Promise<NodeListView> {
  const listen = await listenForEntry(entry, platformConfig, env);
  if (!listen.ok) return { ...entry, status: 'unknown' };

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
  // 平台监听也可能监听在该端口：/health 带 role:"platform" 时不算 node up。
  const status: NodeStatus = health !== undefined && health.role !== 'platform' ? 'up' : 'down';
  return { ...entry, api_url: listen.url, status };
}

async function listCommand(
  command: Extract<GatewayNodesCommand, { kind: 'list' }>,
  deps: GatewayNodesCommandDeps,
): Promise<number> {
  const context = await resolveContext(deps);
  const print = deps.print ?? console.log;
  const load = await loadNodeRegistry(context.gatewayDataDir);

  const nodes: NodeRegistryEntry[] =
    load.kind === 'ready'
      ? load.registry.nodes
      : [await synthesizeImplicitNode({ config: context.config, dataDir: context.gatewayDataDir })];

  const views = await Promise.all(
    nodes.map((entry) => statusForEntry(entry, context.config, context.env)),
  );

  if (command.json) {
    print(JSON.stringify({ nodes: views }, null, 2));
    return 0;
  }

  print(ui.section(`Nodes (${views.length}):`));
  const nameWidth = Math.max(4, ...views.map((node) => node.name.length));
  for (const node of views) {
    const status =
      node.status === 'up'
        ? ui.ok(node.status)
        : node.status === 'down'
          ? ui.err(node.status)
          : ui.dim(node.status);
    print(
      `  ${ui.brand(node.name.padEnd(nameWidth))}  ${status.padEnd(12)} ${node.api_url ?? '-'}`,
    );
    print(
      ui.dim(
        `    node_id: ${node.node_id}  data_dir: ${node.data_dir}` +
          (node.config_path !== undefined ? `  config: ${node.config_path}` : '') +
          (node.auto_start ? '' : '  auto_start: false'),
      ),
    );
  }
  if (load.kind === 'missing') {
    print(ui.dim(`  (no ${nodeRegistryPath(context.gatewayDataDir)}; implicit single node)`));
  }
  return 0;
}

/** 其它 registry 节点的端口；config 不可读时跳过（不阻断 add，启动时 fail-fast）。 */
async function portForEntry(
  entry: NodeRegistryEntry,
  env: Record<string, string | undefined>,
): Promise<number | undefined> {
  if (entry.config_path === undefined) return undefined;
  try {
    const { config } = await loadConfig({ configPath: entry.config_path, env });
    const { nodePort } = resolveGatewayNodePorts(config, 'gateway');
    return Number.isInteger(nodePort) ? nodePort : undefined;
  } catch {
    return undefined;
  }
}

function portConflict(nodePort: number, detail: string): NodeRegistryError {
  return new NodeRegistryError('node_port_conflict', `port ${nodePort} conflicts with ${detail}`);
}

async function addCommand(
  command: Extract<GatewayNodesCommand, { kind: 'add' }>,
  deps: GatewayNodesCommandDeps,
): Promise<number> {
  const context = await resolveContext(deps);
  const print = deps.print ?? console.log;
  const printErr = deps.printErr ?? console.error;
  const name = normalizeRegistryNodeName(command.name);
  if (name === null) {
    printErr(ui.err('invalid_params: node name must be non-empty and at most 64 characters'));
    return 2;
  }

  const dataDir = normalizeRegistryPath(command.dataDir);
  const configPath = normalizeRegistryPath(command.configPath);

  // 1. config_path 存在、可读、可解析。
  if (!existsSync(configPath)) {
    printErr(ui.err(`registry_invalid: config not found: ${configPath}`));
    return 1;
  }
  // CONTRACT §3/§6（FROZEN r2）：`config_path` 是 project 层；与
  // `node start --config` 共用 `loadConfig({ configPath, env })`（含校验）。
  // 子进程由 supervisor 以 `VESSEL_DATA_DIR=<data_dir>` 启动，因此这里也用
  // 同一 envNode，避免 add 与子进程在端口/token/data_dir 上分叉。
  const envNode = { ...context.env, VESSEL_DATA_DIR: dataDir };
  let nodeConfig: VesselConfig;
  let projectConfig: VesselConfig;
  try {
    const loaded = await loadConfig({ configPath, env: envNode });
    if (loaded.validation.errors.length > 0) {
      const first = loaded.validation.errors[0];
      const detail = first !== undefined ? `${first.path}: ${first.message}` : 'invalid config';
      printErr(ui.err(`registry_invalid: config validation failed: ${detail}`));
      return 1;
    }
    nodeConfig = loaded.config;
    // project 层单独读一次：env 层会覆盖 data_dir，只有 project 层能检出
    // “config 里写的 data_dir 与 --data-dir 不一致”（§6 早期校验 2）。
    projectConfig = await loadConfigFromFile(configPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    printErr(ui.err(`registry_invalid: config is not readable/parseable: ${detail}`));
    return 1;
  }

  // 2. node_id：config.host.node_id 或已有 node.json；不写 node.json / 数据目录。
  const nodeId = await resolveNodeIdForRegistryAdd({ nodeConfig, dataDir });

  // 3. registry data_dir 必须等于 resolveDataDir(project config, envNode)。
  assertNodeDataDirMatches({ dataDir, nodeConfig: projectConfig, env: context.env });

  // 4. 端口冲突：gateway.port / Hub 8643 / 其它节点 / 已占用端口；拒绝 0。
  const { nodePort } = resolveGatewayNodePorts(nodeConfig, 'gateway');
  if (!Number.isInteger(nodePort) || nodePort <= 0) {
    throw portConflict(nodePort, 'a fixed non-zero node port is required');
  }
  const platformPort = context.config.gateway?.port ?? DEFAULT_GATEWAY_OPTIONS.port;
  if (platformPort !== 0 && nodePort === platformPort) {
    throw portConflict(nodePort, `the platform gateway port (gateway.port)`);
  }
  if (nodePort === HUB_DEFAULT_PORT) {
    throw portConflict(nodePort, 'the Hub default port (8643)');
  }

  const load = await loadNodeRegistry(context.gatewayDataDir);
  const existing = load.kind === 'ready' ? load.registry.nodes : [];
  for (const other of existing) {
    const otherPort = await portForEntry(other, context.env);
    if (otherPort === nodePort) throw portConflict(nodePort, `node "${other.name}"`);
  }

  const host = (nodeConfig.serve?.hostname ?? DEFAULT_SERVE_OPTIONS.hostname).trim();
  const isPortAvailable = deps.isPortAvailable ?? checkPortAvailable;
  if (!(await isPortAvailable(host, nodePort))) {
    throw portConflict(nodePort, `an already bound address (${host})`);
  }

  // 5. node_id / name / data_dir / config_path 唯一。
  const entry: NodeRegistryEntry = {
    node_id: nodeId,
    name,
    kind: 'local',
    data_dir: dataDir,
    config_path: configPath,
    auto_start: command.autoStart,
  };
  assertRegistryEntryUnique(existing, entry);

  const registry: NodeRegistry =
    load.kind === 'ready'
      ? { ...load.registry, nodes: [...existing, entry] }
      : { v: NODE_REGISTRY_VERSION, nodes: [entry] };
  await writeNodeRegistry(context.gatewayDataDir, registry);

  print(ui.ok(`node "${name}" added to ${nodeRegistryPath(context.gatewayDataDir)}`));
  print(ui.dim('takes effect on the next `vessel gateway start`'));
  return 0;
}

async function removeCommand(
  command: Extract<GatewayNodesCommand, { kind: 'remove' }>,
  deps: GatewayNodesCommandDeps,
): Promise<number> {
  const context = await resolveContext(deps);
  const print = deps.print ?? console.log;
  const printErr = deps.printErr ?? console.error;
  const name = command.name.trim();

  const load = await loadNodeRegistry(context.gatewayDataDir);
  if (load.kind === 'missing') {
    printErr(ui.err(`node_not_found: no node registry; node "${name}" does not exist`));
    return 1;
  }

  const entry = load.registry.nodes.find((node) => node.name === name);
  if (entry === undefined) {
    printErr(ui.err(`node_not_found: node "${name}" is not registered`));
    return 1;
  }

  const record = await readGatewayPidRecord(entry.data_dir);
  if (record !== null && isProcessAlive(record.pid)) {
    printErr(ui.err(`node_running: node "${name}" is running (pid ${record.pid}); stop it first`));
    return 1;
  }

  const nodes = load.registry.nodes.filter((node) => node.name !== name);
  if (nodes.length === 0) {
    // 最后一节点：删除 registry，回到 G1 隐式单节点。
    await deleteNodeRegistry(context.gatewayDataDir);
    print(ui.ok(`node "${name}" removed`));
    print(ui.dim('registry is empty; deleted nodes.json (back to the implicit single node)'));
  } else {
    await writeNodeRegistry(context.gatewayDataDir, { ...load.registry, nodes });
    print(ui.ok(`node "${name}" removed`));
    print(ui.dim('takes effect on the next `vessel gateway start`'));
  }
  return 0;
}

/** 执行 `gateway nodes` 子命令，返回退出码。 */
export async function runGatewayNodesCommand(
  command: GatewayNodesCommand,
  deps: GatewayNodesCommandDeps = {},
): Promise<number> {
  const printErr = deps.printErr ?? console.error;
  try {
    switch (command.kind) {
      case 'list':
        return await listCommand(command, deps);
      case 'add':
        return await addCommand(command, deps);
      case 'remove':
        return await removeCommand(command, deps);
    }
  } catch (error) {
    return reportFailure(error, printErr);
  }
}
