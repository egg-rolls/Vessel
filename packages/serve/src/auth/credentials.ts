/**
 * 0.56 P2：口令后端的凭据库（`<dataDir>/auth/credentials.json`，0600）。
 *
 * 落盘内容（不含任何可登录的明文）：
 * - `password`：argon2id PHC 串；
 * - `totp.secret`：**base32 明文**（校验必须拿到密钥本身，无法只存 hash）。文件 0600
 *   且与 root-secret 同目录，等同「本机私钥」的保护级别，注释与文档都写清这一点；
 * - `totp.lastStep`：已经用掉的步数（重放闸，见 totp.ts）；
 * - `recovery[]`：恢复码的 sha256（**只存 hash**，明文只在生成那一刻返回一次）。
 *
 * 写入一律 `atomicWrite`（0600 + rename），并且串行化 —— 中途崩掉不会留下半个文件。
 *
 * @module @vessel-agent/serve/auth/credentials
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { atomicWrite } from '@vessel-agent/core';
import { hashPassword, type StoredPassword } from './password.js';

/** 一条恢复码：只存 sha256，用掉后写 usedAt。 */
export interface RecoveryCodeRecord {
  hash: string;
  usedAt: number | null;
}

/** TOTP 配置：密钥 + 重放闸。 */
export interface TotpRecord {
  /** base32 密钥（明文，见文件头说明）。 */
  secret: string;
  createdAt: number;
  /** 已经消费掉的最大 step；0 = 还没用过。 */
  lastStep: number;
}

/** 落盘形状。 */
export interface StoredCredentials {
  version: 1;
  /** 单用户登录名：只用于展示与按账户限流，不参与身份判定。 */
  username: string;
  password?: StoredPassword;
  totp?: TotpRecord;
  recovery?: RecoveryCodeRecord[];
}

const PERSIST_VERSION = 1;
/** 恢复码：10 个、每个 10 个 base32 字符（50 bit）。一次性、只存 hash。 */
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_GROUPS = 2;
const RECOVERY_GROUP_LEN = 5;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 恢复码归一：只留字母数字并大写（用户抄写常带空格/连字符，也可能小写）。 */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_GROUPS * RECOVERY_GROUP_LEN);
  let raw = '';
  for (const byte of bytes) raw += RECOVERY_ALPHABET[byte % 32];
  const groups: string[] = [];
  for (let i = 0; i < RECOVERY_GROUPS; i++) {
    groups.push(raw.slice(i * RECOVERY_GROUP_LEN, (i + 1) * RECOVERY_GROUP_LEN));
  }
  return groups.join('-');
}

export interface CredentialStoreOptions {
  /** 文件路径；省略 = 纯内存（首次引导 / 验收）。 */
  file?: string | undefined;
  /** 可注入时钟。 */
  now?: (() => number) | undefined;
  /** 默认登录名；缺省 `admin`。 */
  username?: string | undefined;
}

/**
 * 凭据库。
 *
 * 读盘失败（缺失 / 坏 JSON）一律当「还没有凭据」—— 这让首次启动去走一次性引导码，
 * 而不是把运维挡在一个「文件坏了所以永远登录不上」的死局里。
 */
export class CredentialStore {
  private data: StoredCredentials;
  private readonly file: string | undefined;
  private readonly now: () => number;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: CredentialStoreOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? (() => Date.now());
    this.data = { version: PERSIST_VERSION, username: options.username ?? 'admin' };
    this.loadFromDisk(options.username);
  }

  get username(): string {
    return this.data.username;
  }

  /** 当前状态快照（浅拷贝，调用方不能改坏内部对象）。 */
  snapshot(): StoredCredentials {
    return {
      ...this.data,
      ...(this.data.password !== undefined ? { password: { ...this.data.password } } : {}),
      ...(this.data.totp !== undefined ? { totp: { ...this.data.totp } } : {}),
      ...(this.data.recovery !== undefined
        ? { recovery: this.data.recovery.map((entry) => ({ ...entry })) }
        : {}),
    };
  }

  hasPassword(): boolean {
    return this.data.password !== undefined;
  }

  /** 是否要求第二因子（配了 TOTP 密钥就要求，没有开关）。 */
  hasTotp(): boolean {
    return this.data.totp !== undefined;
  }

  /** 写入新口令（argon2id）；同时作废已用/未用的恢复码之外的东西不受影响。 */
  async setPassword(password: string): Promise<void> {
    this.data = { ...this.data, password: await hashPassword(password, this.now()) };
    await this.persist();
  }

  /** 绑定 TOTP 密钥；`lastStep` 从 0 开始（重放闸随之重置）。 */
  async setTotpSecret(secret: string): Promise<void> {
    this.data = {
      ...this.data,
      totp: { secret, createdAt: this.now(), lastStep: 0 },
    };
    await this.persist();
  }

  /** 记录已经消费掉的 step（只增不减：重放闸靠它单调）。 */
  async noteTotpStep(step: number): Promise<void> {
    if (this.data.totp === undefined) return;
    if (step <= this.data.totp.lastStep) return;
    this.data = { ...this.data, totp: { ...this.data.totp, lastStep: step } };
    await this.persist();
  }

  /**
   * 重新签发一批恢复码：返回**明文一次**（调用方负责展示给用户），落盘只有 hash。
   * 旧的一批直接丢弃 —— 恢复码不做长期累积。
   */
  async replaceRecoveryCodes(): Promise<string[]> {
    const plain: string[] = [];
    const records: RecoveryCodeRecord[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const code = generateRecoveryCode();
      plain.push(code);
      records.push({ hash: sha256Hex(normalizeRecoveryCode(code)), usedAt: null });
    }
    this.data = { ...this.data, recovery: records };
    await this.persist();
    return plain;
  }

  /** 消费一个恢复码：命中且未用过 → 标记已用并返回 true（一次性）。 */
  async consumeRecoveryCode(input: string): Promise<boolean> {
    const normalized = normalizeRecoveryCode(input);
    if (normalized === '') return false;
    const hash = sha256Hex(normalized);
    const recovery = this.data.recovery ?? [];
    const index = recovery.findIndex((entry) => entry.hash === hash && entry.usedAt === null);
    if (index < 0) return false;
    const next = recovery.map((entry, i) =>
      i === index ? { ...entry, usedAt: this.now() } : entry,
    );
    this.data = { ...this.data, recovery: next };
    await this.persist();
    return true;
  }

  /** 剩余可用恢复码数量（诊断 / 登录页提示用，不泄露具体值）。 */
  recoveryCodesLeft(): number {
    return (this.data.recovery ?? []).filter((entry) => entry.usedAt === null).length;
  }

  /** 等待挂起写入完成。 */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  private persist(): Promise<void> {
    if (this.file === undefined) return Promise.resolve();
    const payload = JSON.stringify(this.data, null, 2);
    const file = this.file;
    this.writeChain = this.writeChain.then(() =>
      // 0600：文件里有 TOTP 密钥与口令 hash，等同于本机私钥。
      atomicWrite(file, payload, { mode: 0o600, ensureDir: true }),
    );
    this.writeChain = this.writeChain.then(
      () => undefined,
      () => undefined,
    );
    return this.writeChain;
  }

  private loadFromDisk(username: string | undefined): void {
    if (this.file === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    const sanitized = sanitizeCredentials(parsed, username);
    if (sanitized === null) return;
    this.data = sanitized;
  }
}

/** 只认回自己写过的形状：坏字段整条丢弃（宁可从引导码重来，也不接受半截凭据）。 */
export function sanitizeCredentials(
  value: unknown,
  username: string | undefined,
): StoredCredentials | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Record<string, unknown>;
  const name =
    typeof item.username === 'string' && item.username.trim() !== ''
      ? item.username.trim()
      : (username ?? 'admin');
  const result: StoredCredentials = { version: PERSIST_VERSION, username: name };
  const password = item.password;
  if (typeof password === 'object' && password !== null) {
    const entry = password as Record<string, unknown>;
    if (typeof entry.value === 'string' && entry.value !== '') {
      result.password = {
        algorithm:
          typeof entry.algorithm === 'string' ? (entry.algorithm as 'argon2id') : 'argon2id',
        value: entry.value,
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
      };
    }
  }
  const totp = item.totp;
  if (typeof totp === 'object' && totp !== null) {
    const entry = totp as Record<string, unknown>;
    if (typeof entry.secret === 'string' && entry.secret !== '') {
      const lastStep =
        typeof entry.lastStep === 'number' && Number.isFinite(entry.lastStep) && entry.lastStep >= 0
          ? Math.floor(entry.lastStep)
          : 0;
      result.totp = {
        secret: entry.secret,
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
        lastStep,
      };
    }
  }
  const recovery = item.recovery;
  if (Array.isArray(recovery)) {
    const records: RecoveryCodeRecord[] = [];
    for (const raw of recovery) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.hash !== 'string' || entry.hash.length !== 64) continue;
      records.push({
        hash: entry.hash,
        usedAt: typeof entry.usedAt === 'number' ? entry.usedAt : null,
      });
    }
    if (records.length > 0) result.recovery = records;
  }
  return result;
}
