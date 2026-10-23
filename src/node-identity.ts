/**
 * 节点身份文件 `<dataDir>/node.json`。
 *
 * - 形状固定 `{ node_id, created_at }`；读取时忽略额外字段。
 * - 配置值优先：直接返回，不创建、不改写文件。
 * - 文件损坏抛 `node_identity_corrupt`，不得静默重新生成。
 *
 * @module vessel/node-identity
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@vessel-agent/core';
import { atomicWrite } from '@vessel-agent/core';

/** node_id 合法形状：1-64 位字母、数字、`_`、`-` */
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface ResolveNodeIdOptions {
  configNodeId?: string;
  dataDir: string;
  logger?: Logger;
}

interface NodeJson {
  node_id: string;
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

  return { node_id: nodeId, created_at: createdAt };
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
async function readExistingNodeId(path: string): Promise<string | undefined> {
  let existing: NodeJson | 'missing';
  try {
    existing = await readNodeJson(path);
  } catch (error) {
    if (isCorruptError(error)) return undefined;
    throw error;
  }
  return existing === 'missing' ? undefined : existing.node_id;
}

/**
 * 解析当前节点 id。
 *
 * 配置值非空时直接返回；否则读取 `node.json`，缺失时生成并原子写回。
 * 写后重读以处理并发首启：若磁盘值与本次候选不同，以磁盘值为准。
 */
export async function resolveNodeId(options: ResolveNodeIdOptions): Promise<string> {
  const { configNodeId, dataDir, logger } = options;
  const path = nodeJsonPath(dataDir);

  if (typeof configNodeId === 'string' && configNodeId !== '') {
    const fileNodeId = await readExistingNodeId(path);
    if (fileNodeId !== undefined && fileNodeId !== configNodeId) {
      logger?.warn('node.identity.config_override', {
        path,
        configured: configNodeId,
        file: fileNodeId,
      });
    }
    return configNodeId;
  }

  const existing = await readNodeJson(path);
  if (existing !== 'missing') return existing.node_id;

  const candidate = randomUUID();
  const body = `${JSON.stringify({ node_id: candidate, created_at: Date.now() }, null, 2)}\n`;
  await atomicWrite(path, body, { mode: 0o600, ensureDir: true });

  try {
    const written = await readNodeJson(path);
    if (written !== 'missing' && written.node_id !== candidate) return written.node_id;
  } catch (error) {
    // 并发写者留下的临时损坏或删除不覆盖本次已成功的写入结果
    if (!isCorruptError(error) && errnoCode(error) !== 'ENOENT') throw error;
  }
  return candidate;
}
