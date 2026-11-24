/**
 * 节点身份文件 `<dataDir>/node.json`。
 *
 * - 形状 `{ node_id, name, created_at }`；`name` 是展示名（0.25 additive），
 *   寻址 / 去重仍只用 `node_id`。
 * - 旧文件缺 `name` 时读取时按 hostname 派生，**不回写**；只有创建或显式更新
 *   才写入 `name`。
 * - 配置值优先：直接返回，不创建、不改写文件。
 * - 文件损坏（JSON / `node_id` / `created_at`）抛 `node_identity_corrupt`，
 *   不得静默重新生成；`name` 缺失 / 非法只回退 hostname，不影响身份。
 *
 * @module vessel/node-identity
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@vessel-agent/core';
import { atomicWrite } from '@vessel-agent/core';

/** node_id 合法形状：1-64 位字母、数字、`_`、`-` */
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 展示名上限（字符）。 */
const NODE_NAME_MAX_LENGTH = 64;
/** Unicode 控制字符（C0 / C1）。 */
const CONTROL_CHARS_RE = /\p{Cc}/gu;

export interface ResolveNodeIdentityOptions {
  configNodeId?: string;
  /** 配置里的展示名（`host.node_name` → `host.nodeName`）。 */
  configNodeName?: string;
  dataDir: string;
  logger?: Logger;
  /** hostname provider；测试注入，缺省 `os.hostname`。 */
  hostname?: () => string;
}

/** 兼容旧入口：只需要 `node_id` 时沿用。 */
export type ResolveNodeIdOptions = ResolveNodeIdentityOptions;

export interface NodeIdentity {
  /** 唯一身份 / 寻址键。 */
  nodeId: string;
  /** 人类可读展示名。 */
  name: string;
}

interface NodeJson {
  node_id: string;
  name?: string;
  created_at: number;
}

/** 节点身份文件路径 */
export function nodeJsonPath(dataDir: string): string {
  return join(dataDir, 'node.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errnoCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function isCorruptError(error: unknown): boolean {
  return errnoCode(error) === 'node_identity_corrupt';
}

function corrupt(path: string, reason: string): Error {
  return Object.assign(new Error(`node_identity_corrupt: ${path}: ${reason}`), {
    code: 'node_identity_corrupt' as const,
  });
}

/**
 * 归一化展示名：trim、去控制字符、折叠空白、上限 64 字符。
 * 空值 / 非字符串返回 `undefined`（由调用方决定回退）。
 */
function cleanNodeName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(CONTROL_CHARS_RE, '').replace(/\s+/g, ' ').trim();
  if (cleaned === '') return undefined;
  return cleaned.slice(0, NODE_NAME_MAX_LENGTH).trim() || undefined;
}

/** 展示名归一化；空值回退 `node`。 */
export function sanitizeNodeName(raw: string): string {
  return cleanNodeName(raw) ?? 'node';
}

/** 缺省展示名：sanitized `os.hostname()`；读取失败回退 `node`。 */
export function defaultNodeName(): string {
  try {
    return sanitizeNodeName(osHostname());
  } catch {
    return 'node';
  }
}

function deriveNodeName(hostname: () => string): string {
  try {
    return sanitizeNodeName(hostname());
  } catch {
    return 'node';
  }
}

function parseNodeJson(raw: string, path: string): NodeJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corrupt(path, 'invalid JSON');
  }
  if (!isRecord(parsed)) throw corrupt(path, 'not a JSON object');

  const nodeId = parsed.node_id;
  if (typeof nodeId !== 'string' || !NODE_ID_RE.test(nodeId)) {
    throw corrupt(path, 'invalid node_id');
  }

  const createdAt = parsed.created_at;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    throw corrupt(path, 'invalid created_at');
  }

  const name = cleanNodeName(parsed.name);
  return {
    node_id: nodeId,
    ...(name !== undefined ? { name } : {}),
    created_at: createdAt,
  };
}

/** 读取并校验；缺失返回 `'missing'`，其余 I/O 错误原样抛出 */
async function readNodeJson(path: string): Promise<NodeJson | 'missing'> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
  return parseNodeJson(raw, path);
}

/** 配置优先分支：只做比较，损坏或不可解析视为无文件值 */
async function readExistingNode(path: string): Promise<NodeJson | undefined> {
  let existing: NodeJson | 'missing';
  try {
    existing = await readNodeJson(path);
  } catch (error) {
    if (isCorruptError(error)) return undefined;
    throw error;
  }
  return existing === 'missing' ? undefined : existing;
}

function warnNameOverride(
  logger: Logger | undefined,
  path: string,
  configured: string,
  file: string,
): void {
  if (configured === file) return;
  logger?.warn('node.identity.name_config_override', { path, configured, file });
}

/**
 * 解析当前节点身份（`node_id` + 展示名）。
 *
 * `node_id`：配置值非空时直接返回；否则读取 `node.json`，缺失时生成并原子写回。
 * 展示名：`config.host.nodeName` > 文件 `name` > hostname 派生；配置值只比较并
 * 告警，不改写文件。旧文件缺 `name` 时同样不回写。
 */
export async function resolveNodeIdentity(
  options: ResolveNodeIdentityOptions,
): Promise<NodeIdentity> {
  const { configNodeId, configNodeName, dataDir, logger } = options;
  const path = nodeJsonPath(dataDir);
  const hostname = options.hostname ?? osHostname;
  const configuredName = cleanNodeName(configNodeName);

  if (typeof configNodeId === 'string' && configNodeId !== '') {
    const existing = await readExistingNode(path);
    if (existing !== undefined && existing.node_id !== configNodeId) {
      logger?.warn('node.identity.config_override', {
        path,
        configured: configNodeId,
        file: existing.node_id,
      });
    }
    if (configuredName !== undefined && existing?.name !== undefined) {
      warnNameOverride(logger, path, configuredName, existing.name);
    }
    return {
      nodeId: configNodeId,
      name: configuredName ?? existing?.name ?? deriveNodeName(hostname),
    };
  }

  const existing = await readNodeJson(path);
  if (existing !== 'missing') {
    if (configuredName !== undefined && existing.name !== undefined) {
      warnNameOverride(logger, path, configuredName, existing.name);
    }
    return {
      nodeId: existing.node_id,
      name: configuredName ?? existing.name ?? deriveNodeName(hostname),
    };
  }

  const candidate = randomUUID();
  const name = configuredName ?? deriveNodeName(hostname);
  const body = `${JSON.stringify({ node_id: candidate, name, created_at: Date.now() }, null, 2)}\n`;
  await atomicWrite(path, body, { mode: 0o600, ensureDir: true });

  try {
    const written = await readNodeJson(path);
    if (written !== 'missing') {
      return { nodeId: written.node_id, name: written.name ?? name };
    }
  } catch (error) {
    // 并发写者留下的临时损坏或删除不覆盖本次已成功的写入结果
    if (!isCorruptError(error) && errnoCode(error) !== 'ENOENT') throw error;
  }
  return { nodeId: candidate, name };
}

/**
 * 解析当前节点 id（兼容入口）。
 *
 * 行为与 `resolveNodeIdentity().nodeId` 一致；首次创建同样写入展示名。
 */
export async function resolveNodeId(options: ResolveNodeIdOptions): Promise<string> {
  return (await resolveNodeIdentity(options)).nodeId;
}
