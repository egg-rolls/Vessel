/**
 * model-registry 插件：加密凭证库 `<dataDir>/credentials.json`。
 *
 * 契约：docs/dev/plans/model-registry.md §2.2 + CONTRACT-model-registry-internal.md §2。
 * - 信封 `{v:1, entries:{id:{iv,tag,data,createdAt,updatedAt}}}`；AES-256-GCM（node:crypto）。
 * - key = derivePurposeToken(root, {kind:'credentials'}) 去 `vsk_` 前缀后 base64url 解码（32B）；
 *   root 经 ensureRootSecret（缺省自动生成）。不在插件里私写第二套 HKDF。
 * - atomicWrite 0600 + 插件内串行写队列（read-modify-write 整段串行，不只写盘）。
 * - 轮换 = updatedAt bump（D10：root-secret 轮换 → 全部失效需重录，不做重加密迁移）。
 * - 与 `<dataDir>/auth/credentials.json`（gateway 登录库）互不消费。
 * - 明文纪律：value 只在 credential_set 写入瞬间存在；reveal 只供连通性测试（产品功能，
 *   用户触发），RPC 结果 / 日志永不回显。
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  DEFAULT_DATA_DIR,
  DERIVED_TOKEN_PREFIX,
  derivePurposeToken,
  ensureRootSecret,
  expandHomePath,
  ROOT_SECRET_BYTES,
  rootSecretPath,
  type VesselConfig,
} from '@vessel-agent/config';
import { atomicWrite } from '@vessel-agent/core';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * dataDir 解析口径（契约 §2 冻结；oracle = src/data-paths.ts resolveDataDir）：
 * config.dataDir → VESSEL_DATA_DIR → DEFAULT_DATA_DIR，expandHome + path.resolve。
 * 用 @vessel-agent/config 现成导出实现同口径，不移 resolveDataDir、不新增包导出。
 */
export function resolveDataDir(config: VesselConfig): string {
  const configured = nonEmpty(config.dataDir) ?? nonEmpty(process.env.VESSEL_DATA_DIR);
  return path.resolve(expandHomePath(configured ?? DEFAULT_DATA_DIR));
}

interface CredentialEnvelopeEntry {
  iv: string;
  tag: string;
  data: string;
  createdAt: string;
  updatedAt: string;
}

interface CredentialEnvelope {
  v: 1;
  entries: Record<string, CredentialEnvelopeEntry>;
}

/** credentials_list 条目：只有元数据，无值、无片段、无指纹。 */
export interface CredentialMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 串行写队列（按文件路径）：跨 RPC 调用串行化整段 read-modify-write。
 * 实例每次 RPC 新建，队列必须挂模块级；形状同 core atomicWrite 的 pendingWrites。
 */
const writeChains = new Map<string, Promise<unknown>>();

async function serialize<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(file) ?? Promise.resolve();
  const current = previous.then(task, task);
  const tail = current.then(
    () => {},
    () => {},
  );
  writeChains.set(file, tail);
  try {
    return await current;
  } finally {
    if (writeChains.get(file) === tail) writeChains.delete(file);
  }
}

export class CredentialStore {
  constructor(private readonly dataDir: string) {}

  private get file(): string {
    return path.join(this.dataDir, 'credentials.json');
  }

  /** AES-256-GCM key：root-secret 经冻结 HKDF 派生（vessel:credentials），去前缀解码 32B。 */
  private encryptionKey(): Buffer {
    const read = ensureRootSecret(rootSecretPath(this.dataDir));
    if (!read.ok) throw new Error(`root_secret_unavailable: ${read.error.message}`);
    const token = derivePurposeToken(read.value.secret, { kind: 'credentials' });
    const key = Buffer.from(token.slice(DERIVED_TOKEN_PREFIX.length), 'base64url');
    if (key.length !== ROOT_SECRET_BYTES) {
      throw new Error('credential_key_invalid: derived credentials key is not 32 bytes');
    }
    return key;
  }

  /** 读信封；不存在 = 空库；损坏 ≠ 不存在，抛错不静默覆盖。 */
  private async readEnvelope(): Promise<CredentialEnvelope> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, entries: {} };
      throw new Error(`credentials_read_failed: ${this.file}: ${messageOf(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`credentials_corrupt: ${this.file}: ${messageOf(error)}`);
    }
    if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.entries)) {
      throw new Error(`credentials_corrupt: ${this.file}: unexpected envelope shape`);
    }
    for (const [id, entry] of Object.entries(parsed.entries)) {
      if (
        !isRecord(entry) ||
        typeof entry.iv !== 'string' ||
        typeof entry.tag !== 'string' ||
        typeof entry.data !== 'string' ||
        typeof entry.createdAt !== 'string' ||
        typeof entry.updatedAt !== 'string'
      ) {
        throw new Error(`credentials_corrupt: ${this.file}: entry "${id}" has invalid shape`);
      }
    }
    return { v: 1, entries: parsed.entries as Record<string, CredentialEnvelopeEntry> };
  }

  private async persist(envelope: CredentialEnvelope): Promise<void> {
    await atomicWrite(this.file, `${JSON.stringify(envelope, null, 2)}\n`, {
      mode: 0o600,
      ensureDir: true,
    });
  }

  /** 元数据列表（无值）。usedBy 由调用方按 registry 引用计算。 */
  async list(): Promise<CredentialMeta[]> {
    const envelope = await this.readEnvelope();
    return Object.entries(envelope.entries).map(([id, entry]) => ({
      id,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }));
  }

  /** 增 / 轮换合一：新 iv 重加密；既有 createdAt 保留，updatedAt bump。 */
  async set(id: string, value: string): Promise<{ updatedAt: string }> {
    return serialize(this.file, async () => {
      const envelope = await this.readEnvelope();
      const key = this.encryptionKey();
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      const now = new Date().toISOString();
      const existing = envelope.entries[id];
      envelope.entries[id] = {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await this.persist(envelope);
      return { updatedAt: now };
    });
  }

  /** 删除；不存在即报错（引用检查在调用方，先于本方法）。 */
  async remove(id: string): Promise<void> {
    return serialize(this.file, async () => {
      const envelope = await this.readEnvelope();
      if (!Object.hasOwn(envelope.entries, id)) {
        throw new Error(`unknown_credential: "${id}"`);
      }
      delete envelope.entries[id];
      await this.persist(envelope);
    });
  }

  /**
   * 解密取明文：**只供连通性测试**（产品功能，用户触发）在进程内消费；
   * 绝不进 RPC 结果 / 日志。解密失败 = root-secret 可能已轮换（D10：需重录）。
   */
  async reveal(id: string): Promise<string> {
    const envelope = await this.readEnvelope();
    const entry = envelope.entries[id];
    if (entry === undefined) throw new Error(`unknown_credential: "${id}"`);
    const key = this.encryptionKey();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(entry.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error(
        `credential_decrypt_failed: "${id}" cannot be decrypted ` +
          '(the root secret may have been rotated; re-record the credential)',
      );
    }
  }
}
