/**
 * 本地 Node registry（0.49 G3a / CONTRACT-0.49-node-g3 §2、§3、§6）。
 *
 * - `<gatewayDataDir>/nodes.json`：本地 node 的唯一真源；0600、原子写；
 * - 缺失 → 由调用方合成 G1 隐式单节点，**不创建文件**；
 * - 损坏 / 无效 → 抛 `registry_corrupt` / `registry_invalid`，调用方 fail closed，
 *   不删除原文件、不静默回退；
 * - registry 不存 token、端口；只存“节点在哪里”。
 *
 * 只实现本切片需要的读写 / 校验，不引入通用 store 抽象。
 *
 * @module vessel/gateway/node-registry
 */

import { readFile, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, type Logger } from '@vessel-agent/core';
import type { VesselConfig } from '../../packages/config/src/index';
import { expandHome, resolveDataDir } from '../data-paths';
import { nodeJsonPath, resolveNodeIdentity } from '../node-identity';

export const NODE_REGISTRY_VERSION = 1;
export const NODE_REGISTRY_FILE = 'nodes.json';

/** G3 只接受 `local`；G4 再扩 `remote`。 */
export type NodeRegistryKind = 'local';

export interface NodeRegistryEntry {
  node_id: string;
  name: string;
  kind: NodeRegistryKind;
  data_dir: string;
  config_path?: string;
  auto_start: boolean;
}

export interface NodeRegistry {
  v: typeof NODE_REGISTRY_VERSION;
  nodes: NodeRegistryEntry[];
}

/** registry / add 早期校验失败码（CONTRACT §6 / §9）。 */
export type NodeRegistryErrorCode =
  | 'registry_corrupt'
  | 'registry_invalid'
  | 'node_identity_unavailable'
  | 'node_identity_mismatch'
  | 'node_data_dir_mismatch'
  | 'node_port_conflict';

export class NodeRegistryError extends Error {
  readonly code: NodeRegistryErrorCode;

  constructor(code: NodeRegistryErrorCode, message: string) {
    super(message);
    this.name = 'NodeRegistryError';
    this.code = code;
  }
}

export type NodeRegistryLoad = { kind: 'missing' } | { kind: 'ready'; registry: NodeRegistry };

const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NODE_NAME_MAX_LENGTH = 64;
const CONTROL_CHARS_RE = /\p{Cc}/gu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function nodeRegistryPath(gatewayDataDir: string): string {
  return path.join(gatewayDataDir, NODE_REGISTRY_FILE);
}

/** 归一化展示名：trim、去控制字符、≤64；非法返回 null（不静默改写）。 */
export function normalizeRegistryNodeName(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(CONTROL_CHARS_RE, '').trim();
  if (name === '' || name.length > NODE_NAME_MAX_LENGTH) return null;
  return name;
}

/** 展开 `~` 并解析为绝对路径；仅用于命令行输入 / 比较。 */
export function normalizeRegistryPath(raw: string): string {
  return path.resolve(expandHome(raw));
}

/** 路径等价（Windows 大小写不敏感；跨盘符不相等）。 */
function samePath(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === '';
}

function requireAbsolutePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new NodeRegistryError('registry_invalid', `${field} must be a non-empty string`);
  }
  const expanded = expandHome(value.trim());
  if (!path.isAbsolute(expanded)) {
    throw new NodeRegistryError('registry_invalid', `${field} must be an absolute path`);
  }
  return path.resolve(expanded);
}

function parseEntry(value: unknown, index: number): NodeRegistryEntry {
  const where = `nodes[${index}]`;
  if (!isRecord(value)) {
    throw new NodeRegistryError('registry_invalid', `${where} must be an object`);
  }

  const nodeId = value.node_id;
  if (typeof nodeId !== 'string' || !NODE_ID_RE.test(nodeId)) {
    throw new NodeRegistryError('registry_invalid', `${where}.node_id is invalid`);
  }

  if (typeof value.name !== 'string') {
    throw new NodeRegistryError('registry_invalid', `${where}.name is required`);
  }
  const name = normalizeRegistryNodeName(value.name);
  if (name === null) {
    throw new NodeRegistryError(
      'registry_invalid',
      `${where}.name must be non-empty and at most ${NODE_NAME_MAX_LENGTH} characters`,
    );
  }

  if (value.kind !== 'local') {
    throw new NodeRegistryError('registry_invalid', `${where}.kind must be "local"`);
  }

  const dataDir = requireAbsolutePath(value.data_dir, `${where}.data_dir`);
  const configPath = requireAbsolutePath(value.config_path, `${where}.config_path`);

  if (value.auto_start !== undefined && typeof value.auto_start !== 'boolean') {
    throw new NodeRegistryError('registry_invalid', `${where}.auto_start must be a boolean`);
  }

  return {
    node_id: nodeId,
    name,
    kind: 'local',
    data_dir: dataDir,
    config_path: configPath,
    auto_start: value.auto_start ?? true,
  };
}

function assertUnique(nodes: readonly NodeRegistryEntry[]): void {
  const seenId = new Set<string>();
  const seenName = new Set<string>();
  const seenDataDir = new Set<string>();
  const seenConfigPath = new Set<string>();
  for (const node of nodes) {
    if (seenId.has(node.node_id)) {
      throw new NodeRegistryError('registry_invalid', `duplicate node_id: ${node.node_id}`);
    }
    if (seenName.has(node.name)) {
      throw new NodeRegistryError('registry_invalid', `duplicate name: ${node.name}`);
    }
    if (seenDataDir.has(node.data_dir)) {
      throw new NodeRegistryError('registry_invalid', `duplicate data_dir: ${node.data_dir}`);
    }
    if (node.config_path !== undefined) {
      if (seenConfigPath.has(node.config_path)) {
        throw new NodeRegistryError(
          'registry_invalid',
          `duplicate config_path: ${node.config_path}`,
        );
      }
      seenConfigPath.add(node.config_path);
    }
    seenId.add(node.node_id);
    seenName.add(node.name);
    seenDataDir.add(node.data_dir);
  }
}

/** 解析并校验 registry JSON；结构错误 → `registry_corrupt`，字段/重复 → `registry_invalid`。 */
export function validateNodeRegistry(value: unknown): NodeRegistry {
  if (!isRecord(value)) {
    throw new NodeRegistryError('registry_corrupt', 'registry root must be a JSON object');
  }
  if (value.v !== NODE_REGISTRY_VERSION) {
    throw new NodeRegistryError(
      'registry_corrupt',
      `unsupported registry version: ${String(value.v)}`,
    );
  }
  if (!Array.isArray(value.nodes)) {
    throw new NodeRegistryError('registry_corrupt', 'registry.nodes must be an array');
  }
  const nodes = value.nodes.map((entry, index) => parseEntry(entry, index));
  assertUnique(nodes);
  return { v: NODE_REGISTRY_VERSION, nodes };
}

/**
 * 读取 registry。
 *
 * 缺失返回 `{ kind: 'missing' }`（调用方合成隐式单节点，不写文件）；
 * 读取 / 解析 / 校验失败抛错，**不删除、不修复**原文件。
 */
export async function loadNodeRegistry(gatewayDataDir: string): Promise<NodeRegistryLoad> {
  const file = nodeRegistryPath(gatewayDataDir);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw new NodeRegistryError(
      'registry_corrupt',
      `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NodeRegistryError('registry_corrupt', `${file} is not valid JSON`);
  }
  return { kind: 'ready', registry: validateNodeRegistry(parsed) };
}

/** 原子写入 registry（0600；目录按需创建）。 */
export async function writeNodeRegistry(
  gatewayDataDir: string,
  registry: NodeRegistry,
): Promise<void> {
  const body = `${JSON.stringify(registry, null, 2)}\n`;
  await atomicWrite(nodeRegistryPath(gatewayDataDir), body, {
    mode: 0o600,
    ensureDir: true,
  });
}

/** 删除 registry（最后一节点移除时回到隐式单节点）；ENOENT 视为成功。 */
export async function deleteNodeRegistry(gatewayDataDir: string): Promise<void> {
  try {
    await unlink(nodeRegistryPath(gatewayDataDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * 合成 G1 隐式单节点（无 `nodes.json` 时）。
 *
 * 身份与 G1 完全一致：`config.host.node_id` > `<data_dir>/node.json` > 首次生成；
 * 首次生成由该 node 进程（bootstrap）写入 `node.json`。
 */
export async function synthesizeImplicitNode(options: {
  config: VesselConfig;
  dataDir: string;
  logger?: Logger;
}): Promise<NodeRegistryEntry> {
  const identity = await resolveNodeIdentity({
    ...(options.config.host?.nodeId !== undefined
      ? { configNodeId: options.config.host.nodeId }
      : {}),
    ...(options.config.host?.nodeName !== undefined
      ? { configNodeName: options.config.host.nodeName }
      : {}),
    dataDir: options.dataDir,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  return {
    node_id: identity.nodeId,
    name: identity.name,
    kind: 'local',
    data_dir: options.dataDir,
    auto_start: true,
  };
}

type ExistingNodeId = { kind: 'id'; nodeId: string } | { kind: 'missing' } | { kind: 'corrupt' };

/** 只读 `<data_dir>/node.json`；不创建、不改写。 */
async function readExistingNodeId(dataDir: string): Promise<ExistingNodeId> {
  const file = nodeJsonPath(dataDir);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw new NodeRegistryError(
      'node_identity_mismatch',
      `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.node_id === 'string' && NODE_ID_RE.test(parsed.node_id)) {
      return { kind: 'id', nodeId: parsed.node_id };
    }
  } catch {
    // 落到 corrupt
  }
  return { kind: 'corrupt' };
}

/**
 * `gateway nodes add` 的 node_id 解析（CONTRACT §6 早期校验 3）。
 *
 * **绝不写 `node.json` / 数据目录**：只读 `config.host.node_id` 与已有
 * `<data_dir>/node.json`。两者都不存在 → `node_identity_unavailable`；
 * 都存在但不一致 / 文件损坏 → `node_identity_mismatch`。
 */
export async function resolveNodeIdForRegistryAdd(options: {
  nodeConfig: VesselConfig;
  dataDir: string;
}): Promise<string> {
  const configured = nonEmpty(options.nodeConfig.host?.nodeId);
  if (configured !== undefined && !NODE_ID_RE.test(configured)) {
    throw new NodeRegistryError(
      'node_identity_mismatch',
      `config host.node_id (${configured}) is not a valid node id (1-64 letters, digits, "_" or "-")`,
    );
  }
  const file = await readExistingNodeId(options.dataDir);

  if (file.kind === 'corrupt') {
    throw new NodeRegistryError(
      'node_identity_mismatch',
      `${nodeJsonPath(options.dataDir)} is not a valid node.json`,
    );
  }

  if (configured !== undefined) {
    if (file.kind === 'id' && file.nodeId !== configured) {
      throw new NodeRegistryError(
        'node_identity_mismatch',
        `config host.node_id (${configured}) does not match ${nodeJsonPath(options.dataDir)} (${file.nodeId})`,
      );
    }
    return configured;
  }

  if (file.kind === 'missing') {
    throw new NodeRegistryError(
      'node_identity_unavailable',
      `${options.dataDir} has no host.node_id and no node.json; start this node once so it can generate its identity`,
    );
  }
  return file.nodeId;
}

/**
 * registry `data_dir` 必须等于 `resolveDataDir(nodeConfig, envNode)`，
 * `envNode = { ...env, VESSEL_DATA_DIR: dataDir }`（CONTRACT §3）。
 */
export function assertNodeDataDirMatches(options: {
  dataDir: string;
  nodeConfig: VesselConfig;
  env?: Record<string, string | undefined>;
}): void {
  const dataDir = normalizeRegistryPath(options.dataDir);
  const envNode = { ...(options.env ?? process.env), VESSEL_DATA_DIR: dataDir };
  const resolved = resolveDataDir(options.nodeConfig, envNode);
  if (!samePath(resolved, dataDir)) {
    throw new NodeRegistryError(
      'node_data_dir_mismatch',
      `--data-dir (${dataDir}) does not match the data dir resolved from the node config (${resolved})`,
    );
  }
}

/** `node_id` / `name` / `data_dir` / `config_path` 唯一（CONTRACT §6 早期校验 5）。 */
export function assertRegistryEntryUnique(
  nodes: readonly NodeRegistryEntry[],
  entry: NodeRegistryEntry,
): void {
  const dataDir = normalizeRegistryPath(entry.data_dir);
  const configPath =
    entry.config_path !== undefined ? normalizeRegistryPath(entry.config_path) : undefined;
  for (const existing of nodes) {
    if (existing.node_id === entry.node_id) {
      throw new NodeRegistryError('registry_invalid', `duplicate node_id: ${entry.node_id}`);
    }
    if (existing.name === entry.name) {
      throw new NodeRegistryError('registry_invalid', `duplicate name: ${entry.name}`);
    }
    if (samePath(existing.data_dir, dataDir)) {
      throw new NodeRegistryError('registry_invalid', `duplicate data_dir: ${entry.data_dir}`);
    }
    if (
      configPath !== undefined &&
      existing.config_path !== undefined &&
      samePath(existing.config_path, configPath)
    ) {
      throw new NodeRegistryError(
        'registry_invalid',
        `duplicate config_path: ${entry.config_path}`,
      );
    }
  }
}
