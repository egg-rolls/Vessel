/**
 * Hub 密钥存储（S5 / PLAN §5.4）。
 *
 * 端口形状见 `src/hub/types.ts` 的 `SecretStore`。适配器：
 * - `memory`：测试用（也可 `platform: 'memory'`）；
 * - `file`：AES-256-GCM，key 文件 `<dataDir>/secret.key`（0600），密文
 *   `<dataDir>/secrets.bin`（0600）；
 * - win32：DPAPI（CurrentUser）经 PowerShell，密文 `<dataDir>/secrets.bin`；
 * - darwin：`security add/find/delete-generic-password`，service `vessel-hub`；
 * - linux：`secret-tool store/lookup/clear`。
 *
 * 平台命令不可用且 `allowFileSecrets !== true` → `secret_store_unavailable`
 * fail-closed。命令失败绝不打印 secret 值。
 *
 * @module vessel/hub/secret-store
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@vessel-agent/core';
import { atomicWrite } from '@vessel-agent/core';
import type { SecretStore } from './types.js';

/** 平台命令执行结果 */
export interface RunCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunCommandOptions {
  /** 写入子进程 stdin 的文本 */
  input?: string;
}

/** 可注入的命令执行器（测试用） */
export type RunCommand = (
  command: string,
  args: string[],
  options?: RunCommandOptions,
) => Promise<RunCommandResult>;

export interface CreateSecretStoreOptions {
  platform?: NodeJS.Platform | 'memory';
  dataDir: string;
  allowFileSecrets?: boolean;
  /**
   * darwin / linux 的平台密钥库 service 名；缺省 `vessel-hub`（S5 旧行为）。
   * 节点出站凭据使用独立命名空间 `vessel-node`。
   */
  keychainService?: string;
  runCommand?: RunCommand;
  logger?: Logger;
}

/** 稳定错误：密钥存储不可用。 */
export class SecretStoreUnavailableError extends Error {
  readonly code = 'secret_store_unavailable' as const;

  constructor(detail: string) {
    super(`secret_store_unavailable: ${detail}`);
    this.name = 'SecretStoreUnavailableError';
    this.detail = detail;
  }

  readonly detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errnoCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function isUnavailable(error: unknown): boolean {
  if (error instanceof SecretStoreUnavailableError) return true;
  return errnoCode(error) === 'ENOENT';
}

/** 命令缺失（spawn 失败）统一转 unavailable；消息不含参数（可能含 secret）。 */
function commandError(command: string, error: unknown): SecretStoreUnavailableError {
  const reason = errnoCode(error) === 'ENOENT' ? 'command not found' : 'command failed';
  return new SecretStoreUnavailableError(`${command}: ${reason}`);
}

/** 默认命令执行器：Bun.spawn，stdin 支持注入文本；不经过 shell。 */
const defaultRunCommand: RunCommand = async (command, args, options) => {
  const proc = Bun.spawn([command, ...args], {
    stdin: options?.input !== undefined ? new Blob([options.input]) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
};

/** 测试 / 进程内 memory 适配器。 */
export function createMemorySecretStore(): SecretStore {
  const values = new Map<string, string>();
  return {
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

interface FileEntry {
  iv: string;
  tag: string;
  data: string;
}

interface FileEnvelope {
  v: 1;
  entries: Record<string, FileEntry>;
}

const SECRET_FILE = 'secrets.bin';
const KEY_FILE = 'secret.key';
const KEY_BYTES = 32;

function encrypt(key: Buffer, plaintext: string): FileEntry {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decrypt(key: Buffer, entry: FileEntry): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(entry.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function parseEnvelope(raw: string, path: string): FileEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error(`secret_store_corrupt: ${path}: invalid JSON`), {
      code: 'secret_store_corrupt' as const,
    });
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.entries)) {
    throw Object.assign(new Error(`secret_store_corrupt: ${path}: invalid envelope`), {
      code: 'secret_store_corrupt' as const,
    });
  }
  const entries: Record<string, FileEntry> = {};
  for (const [key, value] of Object.entries(parsed.entries)) {
    if (
      !isRecord(value) ||
      typeof value.iv !== 'string' ||
      typeof value.tag !== 'string' ||
      typeof value.data !== 'string'
    ) {
      throw Object.assign(new Error(`secret_store_corrupt: ${path}: invalid entry`), {
        code: 'secret_store_corrupt' as const,
      });
    }
    entries[key] = { iv: value.iv, tag: value.tag, data: value.data };
  }
  return { v: 1, entries };
}

/** AES-256-GCM 文件适配器；key 文件 0600。 */
export function createFileSecretStore(options: { dataDir: string }): SecretStore {
  const dir = options.dataDir;
  const secretPath = join(dir, SECRET_FILE);
  const keyPath = join(dir, KEY_FILE);

  let keyPromise: Promise<Buffer> | undefined;
  let envelope: FileEnvelope | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  async function loadKey(): Promise<Buffer> {
    if (keyPromise) return keyPromise;
    keyPromise = (async () => {
      let raw: string;
      try {
        raw = await readFile(keyPath, 'utf8');
      } catch (error) {
        if (errnoCode(error) !== 'ENOENT') throw error;
        const generated = randomBytes(KEY_BYTES);
        await atomicWrite(keyPath, `${generated.toString('base64')}\n`, {
          mode: 0o600,
          ensureDir: true,
        });
        return generated;
      }
      const decoded = Buffer.from(raw.trim(), 'base64');
      if (decoded.length !== KEY_BYTES) {
        throw Object.assign(new Error(`secret_store_corrupt: ${keyPath}: invalid key length`), {
          code: 'secret_store_corrupt' as const,
        });
      }
      return decoded;
    })();
    return keyPromise;
  }

  async function loadEnvelope(): Promise<FileEnvelope> {
    if (envelope) return envelope;
    let raw: string;
    try {
      raw = await readFile(secretPath, 'utf8');
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error;
      envelope = { v: 1, entries: {} };
      return envelope;
    }
    envelope = parseEnvelope(raw, secretPath);
    return envelope;
  }

  async function saveEnvelope(next: FileEnvelope): Promise<void> {
    envelope = next;
    await atomicWrite(secretPath, `${JSON.stringify(next)}\n`, {
      mode: 0o600,
      ensureDir: true,
    });
  }

  function mutate(fn: (entries: Record<string, FileEntry>) => void): Promise<void> {
    const task = queue.then(async () => {
      const current = await loadEnvelope();
      const entries = { ...current.entries };
      fn(entries);
      await saveEnvelope({ v: 1, entries });
    });
    queue = task.catch(() => {});
    return task;
  }

  return {
    async get(key) {
      const current = await loadEnvelope();
      const entry = current.entries[key];
      if (!entry) return undefined;
      return decrypt(await loadKey(), entry);
    },
    async set(key, value) {
      const encrypted = encrypt(await loadKey(), value);
      await mutate((entries) => {
        entries[key] = encrypted;
      });
    },
    async delete(key) {
      await mutate((entries) => {
        delete entries[key];
      });
    },
  };
}

/** win32：DPAPI CurrentUser，密文聚合在 `<dataDir>/secrets.bin`。 */
function createDpapiSecretStore(dataDir: string, run: RunCommand): SecretStore {
  const path = join(dataDir, SECRET_FILE);
  let values: Record<string, string> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const protectScript = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    '$in=[Console]::In.ReadToEnd()',
    '$bytes=[Convert]::FromBase64String($in)',
    "$out=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,'CurrentUser')",
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ');

  const unprotectScript = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    '$in=[Console]::In.ReadToEnd()',
    '$bytes=[Convert]::FromBase64String($in)',
    "$out=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,'CurrentUser')",
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ');

  async function load(): Promise<Record<string, string>> {
    if (values) return values;
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error;
      values = {};
      return values;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error(`secret_store_corrupt: ${path}: invalid JSON`), {
        code: 'secret_store_corrupt' as const,
      });
    }
    if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.entries)) {
      throw Object.assign(new Error(`secret_store_corrupt: ${path}: invalid envelope`), {
        code: 'secret_store_corrupt' as const,
      });
    }
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (typeof value !== 'string') {
        throw Object.assign(new Error(`secret_store_corrupt: ${path}: invalid entry`), {
          code: 'secret_store_corrupt' as const,
        });
      }
      entries[key] = value;
    }
    values = entries;
    return values;
  }

  async function save(next: Record<string, string>): Promise<void> {
    values = next;
    await atomicWrite(path, `${JSON.stringify({ v: 1, entries: next })}\n`, {
      mode: 0o600,
      ensureDir: true,
    });
  }

  async function runPowerShell(script: string, input: string): Promise<string> {
    let result: RunCommandResult;
    try {
      result = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { input },
      );
    } catch (error) {
      throw commandError('powershell.exe', error);
    }
    if (result.code !== 0) throw commandError('powershell.exe', undefined);
    return result.stdout.trim();
  }

  function mutate(fn: (entries: Record<string, string>) => void): Promise<void> {
    const task = queue.then(async () => {
      const current = await load();
      const next = { ...current };
      fn(next);
      await save(next);
    });
    queue = task.catch(() => {});
    return task;
  }

  return {
    async get(key) {
      const current = await load();
      const blob = current[key];
      if (!blob) return undefined;
      const plain = await runPowerShell(unprotectScript, blob);
      return Buffer.from(plain, 'base64').toString('utf8');
    },
    async set(key, value) {
      const blob = await runPowerShell(
        protectScript,
        Buffer.from(value, 'utf8').toString('base64'),
      );
      await mutate((entries) => {
        entries[key] = blob;
      });
    },
    async delete(key) {
      await mutate((entries) => {
        delete entries[key];
      });
    },
  };
}

const DEFAULT_KEYCHAIN_SERVICE = 'vessel-hub';

/** darwin：security generic-password。 */
function createDarwinSecretStore(run: RunCommand, service = DEFAULT_KEYCHAIN_SERVICE): SecretStore {
  return {
    async get(key) {
      let result: RunCommandResult;
      try {
        result = await run('security', ['find-generic-password', '-s', service, '-a', key, '-w']);
      } catch (error) {
        throw commandError('security', error);
      }
      // 未找到时 security 返回非零（通常是 44）；返回 undefined，不当作不可用。
      if (result.code !== 0) return undefined;
      return result.stdout.replace(/\r?\n$/, '');
    },
    async set(key, value) {
      let result: RunCommandResult;
      try {
        result = await run('security', [
          'add-generic-password',
          '-U',
          '-s',
          service,
          '-a',
          key,
          '-w',
          value,
        ]);
      } catch (error) {
        throw commandError('security', error);
      }
      if (result.code !== 0) throw commandError('security', undefined);
    },
    async delete(key) {
      let result: RunCommandResult;
      try {
        result = await run('security', ['delete-generic-password', '-s', service, '-a', key]);
      } catch (error) {
        throw commandError('security', error);
      }
      // 44 = item not found；删除幂等。
      if (result.code !== 0 && result.code !== 44) throw commandError('security', undefined);
    },
  };
}

/** secret-tool 不可用的典型 stderr（无会话总线 / 命令缺失）。 */
function secretToolUnavailable(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes('cannot autolaunch') ||
    lower.includes('dbus') ||
    lower.includes('no such file') ||
    lower.includes('not found')
  );
}

/** linux：secret-tool（libsecret）。 */
function createSecretToolStore(run: RunCommand, service = DEFAULT_KEYCHAIN_SERVICE): SecretStore {
  const attrs = ['service', service];
  return {
    async get(key) {
      let result: RunCommandResult;
      try {
        result = await run('secret-tool', ['lookup', ...attrs, 'key', key]);
      } catch (error) {
        throw commandError('secret-tool', error);
      }
      if (result.code !== 0) {
        if (secretToolUnavailable(result.stderr)) throw commandError('secret-tool', undefined);
        return undefined;
      }
      return result.stdout.replace(/\r?\n$/, '');
    },
    async set(key, value) {
      let result: RunCommandResult;
      try {
        result = await run('secret-tool', ['store', '--label', service, ...attrs, 'key', key], {
          input: value,
        });
      } catch (error) {
        throw commandError('secret-tool', error);
      }
      if (result.code !== 0) throw commandError('secret-tool', undefined);
    },
    async delete(key) {
      let result: RunCommandResult;
      try {
        result = await run('secret-tool', ['clear', ...attrs, 'key', key]);
      } catch (error) {
        throw commandError('secret-tool', error);
      }
      if (result.code !== 0 && secretToolUnavailable(result.stderr)) {
        throw commandError('secret-tool', undefined);
      }
    },
  };
}

/**
 * 平台适配器 + 可选文件回退。
 *
 * 命令首次失败（不可用）时，若 `allowFileSecrets === true` 则永久切到文件
 * 适配器并重试本次操作；否则抛 `secret_store_unavailable`。
 */
class ResilientSecretStore implements SecretStore {
  private active: SecretStore;

  constructor(
    primary: SecretStore,
    private readonly fallback: SecretStore | undefined,
    private readonly logger: Logger | undefined,
  ) {
    this.active = primary;
  }

  async get(key: string): Promise<string | undefined> {
    return this.invoke((store) => store.get(key));
  }

  async set(key: string, value: string): Promise<void> {
    await this.invoke((store) => store.set(key, value));
  }

  async delete(key: string): Promise<void> {
    await this.invoke((store) => store.delete(key));
  }

  private async invoke<T>(operation: (store: SecretStore) => Promise<T>): Promise<T> {
    try {
      return await operation(this.active);
    } catch (error) {
      if (!isUnavailable(error) || this.active === this.fallback) throw error;
      if (!this.fallback) throw error;
      this.logger?.warn('hub.secret.fallback', { reason: 'platform secret store unavailable' });
      this.active = this.fallback;
      return operation(this.active);
    }
  }
}

/** 创建密钥存储；平台不可用时按 `allowFileSecrets` 决定回退或 fail-closed。 */
export function createSecretStore(options: CreateSecretStoreOptions): SecretStore {
  if (typeof options.dataDir !== 'string' || options.dataDir === '') {
    throw new Error('invalid_path: dataDir must be a non-empty string');
  }
  const platform = options.platform ?? process.platform;
  if (platform === 'memory') return createMemorySecretStore();

  const run = options.runCommand ?? defaultRunCommand;
  const keychainService = options.keychainService ?? DEFAULT_KEYCHAIN_SERVICE;
  const fallback =
    options.allowFileSecrets === true
      ? createFileSecretStore({ dataDir: options.dataDir })
      : undefined;

  let primary: SecretStore;
  switch (platform) {
    case 'win32':
      primary = createDpapiSecretStore(options.dataDir, run);
      break;
    case 'darwin':
      primary = createDarwinSecretStore(run, keychainService);
      break;
    case 'linux':
      primary = createSecretToolStore(run, keychainService);
      break;
    default:
      if (fallback) return fallback;
      throw new SecretStoreUnavailableError(`unsupported platform: ${platform}`);
  }

  return fallback ? new ResilientSecretStore(primary, fallback, options.logger) : primary;
}
