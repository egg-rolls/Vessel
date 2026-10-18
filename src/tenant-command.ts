/**
 * `vessel tenant list|get|create|update`（0.5 E17 / PLAN §7.6）
 *
 * - 元数据：`<data_dir>/tenants/<id>/tenant.json`
 * - list 扫描目录；缺失 meta 的目录补齐展示（不写盘）
 * - create / update 写前加 tenant 单写者锁
 * - 0.5 不提供物理删除
 *
 * @module vessel/tenant-command
 */

import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertTenantId,
  atomicWrite,
  resolveTenantPaths,
  TenantIdError,
  type TenantPaths,
} from '../packages/core/src/index';
import type { TenantControlLike, TenantInfo, TenantQuota } from '../packages/serve/src/index';
import { TenantLockError, withTenantLock } from './tenant-lock';

/** tenant 元数据（tenant.json 冻结形状） */
export interface TenantMeta {
  tenant_id: string;
  name: string;
  created_at: number;
  status: 'active' | 'disabled';
  quota?: {
    maxSessions?: number;
    maxRunsPerDay?: number;
    maxConcurrentRuns?: number;
    maxStorageBytes?: number;
  };
}

/** 命令结果 */
export interface TenantCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 公共选项 */
export interface TenantCommandOptions {
  /** 全局数据根（已展开的绝对路径） */
  dataDir: string;
  json?: boolean;
  now?: () => number;
  hostname?: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorResult(exitCode: number, message: string): TenantCommandResult {
  return { exitCode, stdout: '', stderr: message };
}

function tenantsRoot(dataDir: string): string {
  return join(dataDir, 'tenants');
}

/** 从未知 JSON 规范化为 TenantMeta；非法返回 undefined */
function normalizeMeta(value: unknown): TenantMeta | undefined {
  if (!isRecord(value) || typeof value.tenant_id !== 'string') return undefined;
  const status = value.status === 'disabled' ? 'disabled' : 'active';
  return {
    tenant_id: value.tenant_id,
    name: typeof value.name === 'string' ? value.name : value.tenant_id,
    created_at: typeof value.created_at === 'number' ? value.created_at : 0,
    status,
    ...(isRecord(value.quota) ? { quota: value.quota as TenantMeta['quota'] } : {}),
  };
}

/** 读取 tenant.json；缺失/损坏返回 undefined */
async function readMeta(paths: TenantPaths): Promise<TenantMeta | undefined> {
  try {
    return normalizeMeta(JSON.parse(await readFile(paths.tenant_file, 'utf8')));
  } catch {
    return undefined;
  }
}

/** 目录存在但没有 meta 时的展示值（不写盘） */
function synthesizedMeta(tenantId: string): TenantMeta {
  return { tenant_id: tenantId, name: tenantId, created_at: 0, status: 'active' };
}

function formatMeta(meta: TenantMeta): string {
  const quota = meta.quota ? `\nquota: ${JSON.stringify(meta.quota)}` : '';
  return (
    [
      `tenant: ${meta.tenant_id}`,
      `name: ${meta.name}`,
      `status: ${meta.status}`,
      `created_at: ${meta.created_at}`,
    ].join('\n') + quota
  );
}

/** 获取写锁；失败返回错误结果 */
async function withLock(
  dataDir: string,
  tenantId: string,
  options: TenantCommandOptions,
  action: () => Promise<TenantCommandResult>,
): Promise<TenantCommandResult> {
  const paths = resolveTenantPaths(dataDir, tenantId);
  try {
    return await withTenantLock(
      {
        tenantDir: paths.root,
        tenantId,
        ...(options.now ? { now: options.now } : {}),
        ...(options.hostname ? { hostname: options.hostname } : {}),
        ...(options.pid ? { pid: options.pid } : {}),
        ...(options.isPidAlive ? { isPidAlive: options.isPidAlive } : {}),
      },
      action,
    );
  } catch (error) {
    if (error instanceof TenantLockError) {
      return errorResult(1, error.message);
    }
    throw error;
  }
}

/** 扫描 tenants/* 并补齐缺失 meta（不写盘） */
async function listTenantMetas(dataDir: string): Promise<TenantMeta[]> {
  let entries: string[];
  try {
    const dirents = await readdir(tenantsRoot(dataDir), { withFileTypes: true });
    entries = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    entries = [];
  }

  const tenants: TenantMeta[] = [];
  for (const id of entries) {
    try {
      assertTenantId(id);
    } catch {
      continue; // 非 tenant 目录（损坏/临时目录）跳过
    }
    const paths = resolveTenantPaths(dataDir, id);
    tenants.push((await readMeta(paths)) ?? synthesizedMeta(id));
  }
  tenants.sort((a, b) => a.tenant_id.localeCompare(b.tenant_id));
  return tenants;
}

/** 读取单个 tenant；目录不存在返回 undefined */
async function getTenantMeta(dataDir: string, tenantId: string): Promise<TenantMeta | undefined> {
  const paths = resolveTenantPaths(dataDir, tenantId);
  if (!existsSync(paths.root)) return undefined;
  return (await readMeta(paths)) ?? synthesizedMeta(tenantId);
}

/** `vessel tenant list [--json]` */
export async function tenantListCommand(
  options: TenantCommandOptions,
): Promise<TenantCommandResult> {
  const tenants = await listTenantMetas(options.dataDir);

  if (options.json) {
    return { exitCode: 0, stdout: JSON.stringify(tenants), stderr: '' };
  }
  return {
    exitCode: 0,
    stdout: tenants
      .map((tenant) => `${tenant.tenant_id}\t${tenant.status}\t${tenant.name}`)
      .join('\n'),
    stderr: '',
  };
}

/** `vessel tenant get <id> [--json]` */
export async function tenantGetCommand(
  tenantId: string,
  options: TenantCommandOptions,
): Promise<TenantCommandResult> {
  try {
    assertTenantId(tenantId);
  } catch (error) {
    return errorResult(2, error instanceof TenantIdError ? error.message : String(error));
  }

  const meta = await getTenantMeta(options.dataDir, tenantId);
  if (!meta) {
    return errorResult(1, `not_found: tenant "${tenantId}"`);
  }

  if (options.json) {
    return { exitCode: 0, stdout: JSON.stringify(meta), stderr: '' };
  }
  return { exitCode: 0, stdout: formatMeta(meta), stderr: '' };
}

/** `vessel tenant create <id> [--name <name>] [--json]` */
export async function tenantCreateCommand(
  tenantId: string,
  options: TenantCommandOptions & { name?: string },
): Promise<TenantCommandResult> {
  try {
    assertTenantId(tenantId);
  } catch (error) {
    return errorResult(2, error instanceof TenantIdError ? error.message : String(error));
  }

  const paths = resolveTenantPaths(options.dataDir, tenantId);
  if (existsSync(paths.root)) {
    return errorResult(1, `conflict: tenant "${tenantId}" already exists`);
  }

  return withLock(options.dataDir, tenantId, options, async () => {
    if (existsSync(paths.tenant_file)) {
      return errorResult(1, `conflict: tenant "${tenantId}" already exists`);
    }
    const meta: TenantMeta = {
      tenant_id: tenantId,
      name: options.name ?? tenantId,
      created_at: (options.now ?? Date.now)(),
      status: 'active',
    };
    await atomicWrite(paths.tenant_file, `${JSON.stringify(meta, null, 2)}\n`, {
      ensureDir: true,
    });
    return options.json
      ? { exitCode: 0, stdout: JSON.stringify(meta), stderr: '' }
      : { exitCode: 0, stdout: `created tenant "${tenantId}"`, stderr: '' };
  });
}

/** `vessel tenant update <id> [--status active|disabled] [--name <name>] [--json]` */
export async function tenantUpdateCommand(
  tenantId: string,
  options: TenantCommandOptions & { name?: string; status?: 'active' | 'disabled' },
): Promise<TenantCommandResult> {
  try {
    assertTenantId(tenantId);
  } catch (error) {
    return errorResult(2, error instanceof TenantIdError ? error.message : String(error));
  }

  const paths = resolveTenantPaths(options.dataDir, tenantId);
  if (!existsSync(paths.root)) {
    return errorResult(1, `not_found: tenant "${tenantId}"`);
  }

  return withLock(options.dataDir, tenantId, options, async () => {
    const meta = (await readMeta(paths)) ?? synthesizedMeta(tenantId);
    const updated: TenantMeta = {
      ...meta,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.status !== undefined ? { status: options.status } : {}),
    };
    await atomicWrite(paths.tenant_file, `${JSON.stringify(updated, null, 2)}\n`, {
      ensureDir: true,
    });
    return options.json
      ? { exitCode: 0, stdout: JSON.stringify(updated), stderr: '' }
      : { exitCode: 0, stdout: `updated tenant "${tenantId}"`, stderr: '' };
  });
}

// ── Gateway 注入面（A-5：TenantControlLike） ────────────────

/** 配置里的 tenant 元数据（`tenant.tenants.<id>` 的 name/status/quota） */
export interface ConfiguredTenant {
  name?: string;
  status?: 'active' | 'disabled';
  quota?: TenantMeta['quota'];
}

export interface CreateTenantControlOptions {
  /**
   * 已合并配置中的 tenant 定义。配置是 status/quota 的权威来源
   * （A-3 §10.4）；tenant.json 只在配置缺失时兜底。
   */
  configured?: Record<string, ConfiguredTenant>;
}

/** 配置定义 → TenantMeta（created_at=0 表示未落盘） */
function configuredMeta(
  tenantId: string,
  entry: ConfiguredTenant | undefined,
): TenantMeta | undefined {
  if (!entry) return undefined;
  return {
    tenant_id: tenantId,
    name: entry.name ?? tenantId,
    created_at: 0,
    status: entry.status ?? 'active',
    ...(entry.quota ? { quota: { ...entry.quota } } : {}),
  };
}

/** quota 超限（gateway 映射为 RPC `quota_exceeded`） */
function quotaError(tenantId: string, limit: number, kind: string): Error {
  return Object.assign(
    new Error(`quota_exceeded: ${kind} limit ${limit} reached for tenant "${tenantId}"`),
    { code: 'quota_exceeded', details: { tenant_id: tenantId, limit } },
  );
}

/** 本地日界（用于 max_runs_per_day） */
function dayStartMs(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 当天已启动 run 数：trace 中的 run.started（若 trace 关闭则为 0）。 */
async function countRunsToday(paths: TenantPaths, now: number): Promise<number> {
  const since = dayStartMs(now);
  let names: string[];
  try {
    names = await readdir(paths.events_dir);
  } catch {
    return 0;
  }

  let count = 0;
  for (const name of names) {
    if (!name.endsWith('.jsonl') || name.startsWith('.')) continue;
    let text: string;
    try {
      text = await readFile(join(paths.events_dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const event = JSON.parse(line) as { type?: unknown; ts?: unknown };
        if (event.type === 'run.started' && typeof event.ts === 'number' && event.ts >= since) {
          count += 1;
        }
      } catch {
        // 损坏行跳过（trace 读取同一口径）
      }
    }
  }
  return count;
}

/** tenant 数据目录的递归字节数（max_storage_bytes） */
async function directorySize(dir: string): Promise<number> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const target = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(target);
    } else if (entry.isFile()) {
      try {
        total += (await stat(target)).size;
      } catch {
        // 并发删除等，忽略
      }
    }
  }
  return total;
}

/** 当前 session 数（file backend）；sqlite / memory 返回 0。 */
async function countSessions(paths: TenantPaths): Promise<number> {
  try {
    const names = await readdir(paths.sessions_dir);
    return names.filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

/** 磁盘 meta 与配置 meta 合并；配置的 status/quota 优先。 */
function mergeMeta(
  disk: TenantMeta | undefined,
  configured: TenantMeta | undefined,
): TenantMeta | undefined {
  if (!disk) return configured;
  if (!configured) return disk;
  return {
    ...disk,
    name: configured.name,
    status: configured.status,
    ...(configured.quota || disk.quota
      ? { quota: { ...(disk.quota ?? {}), ...(configured.quota ?? {}) } }
      : {}),
  };
}

function tenantControlError(
  code: 'not_found' | 'conflict' | 'invalid_params',
  message: string,
): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function quotaToWire(quota: TenantMeta['quota']): TenantQuota | undefined {
  if (!quota) return undefined;
  const result: TenantQuota = {};
  if (quota.maxSessions !== undefined) result.max_sessions = quota.maxSessions;
  if (quota.maxRunsPerDay !== undefined) result.max_runs_per_day = quota.maxRunsPerDay;
  if (quota.maxConcurrentRuns !== undefined) {
    result.max_concurrent_runs = quota.maxConcurrentRuns;
  }
  if (quota.maxStorageBytes !== undefined) result.max_storage_bytes = quota.maxStorageBytes;
  return Object.keys(result).length > 0 ? result : undefined;
}

function quotaFromWire(quota: TenantQuota): TenantMeta['quota'] {
  const result: NonNullable<TenantMeta['quota']> = {};
  if (quota.max_sessions !== undefined) result.maxSessions = quota.max_sessions;
  if (quota.max_runs_per_day !== undefined) result.maxRunsPerDay = quota.max_runs_per_day;
  if (quota.max_concurrent_runs !== undefined) {
    result.maxConcurrentRuns = quota.max_concurrent_runs;
  }
  if (quota.max_storage_bytes !== undefined) {
    result.maxStorageBytes = quota.max_storage_bytes;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function toTenantInfo(meta: TenantMeta): TenantInfo {
  const quota = quotaToWire(meta.quota);
  return {
    tenant_id: meta.tenant_id,
    name: meta.name,
    status: meta.status,
    created_at: meta.created_at,
    ...(quota ? { quota } : {}),
  };
}

/** max_storage_bytes 执行点（runs.start / storage） */
async function enforceStorage(
  tenantId: string,
  paths: TenantPaths,
  quota: NonNullable<TenantMeta['quota']>,
): Promise<void> {
  if (quota.maxStorageBytes === undefined) return;
  const size = await directorySize(paths.root);
  if (size >= quota.maxStorageBytes) {
    throw quotaError(tenantId, quota.maxStorageBytes, 'max_storage_bytes');
  }
}

/** `GatewayOptions.tenants` 的 asm 适配（0.5 无 purge） */
export function createTenantControl(
  dataDir: string,
  options: CreateTenantControlOptions = {},
): TenantControlLike {
  const configured = options.configured ?? {};
  const configuredFor = (tenantId: string): TenantMeta | undefined =>
    configuredMeta(tenantId, configured[tenantId]);

  /** tenant.json（若目录存在）与配置定义合并；配置优先。 */
  const resolveMeta = async (tenantId: string): Promise<TenantMeta | undefined> => {
    const paths = resolveTenantPaths(dataDir, tenantId);
    const disk = existsSync(paths.root)
      ? ((await readMeta(paths)) ?? synthesizedMeta(tenantId))
      : undefined;
    return mergeMeta(disk, configuredFor(tenantId));
  };

  /** 当天 run 计数的进程内兜底（trace 关闭时仍能限流）。 */
  const daily = new Map<string, { day: number; count: number }>();

  return {
    async checkQuota(tenantId, operation): Promise<void> {
      const meta = await resolveMeta(tenantId);
      const quota = meta?.quota;
      if (!quota) return;
      const paths = resolveTenantPaths(dataDir, tenantId);
      const now = Date.now();

      if (operation === 'runs.start' || operation === 'runs.concurrent') {
        // max_runs_per_day：trace 统计 + 进程内计数取最大值。
        if (quota.maxRunsPerDay !== undefined) {
          const day = dayStartMs(now);
          const entry = daily.get(tenantId);
          const memory = entry && entry.day === day ? entry.count : 0;
          const used = Math.max(await countRunsToday(paths, now), memory);
          if (used >= quota.maxRunsPerDay) {
            throw quotaError(tenantId, quota.maxRunsPerDay, 'max_runs_per_day');
          }
          daily.set(tenantId, { day, count: used + 1 });
        }
        await enforceStorage(tenantId, paths, quota);
        return;
      }

      if (operation === 'sessions.create') {
        // 0.5 gateway 目前没有 sessions.create 调用点；保留执行点供后续接入。
        if (quota.maxSessions !== undefined) {
          const used = await countSessions(paths);
          if (used >= quota.maxSessions) {
            throw quotaError(tenantId, quota.maxSessions, 'max_sessions');
          }
        }
        return;
      }

      if (operation === 'storage') {
        await enforceStorage(tenantId, paths, quota);
      }
    },

    async list(): Promise<TenantInfo[]> {
      const byId = new Map<string, TenantMeta>();
      for (const meta of await listTenantMetas(dataDir)) byId.set(meta.tenant_id, meta);
      for (const tenantId of Object.keys(configured)) {
        try {
          assertTenantId(tenantId);
        } catch {
          continue;
        }
        const merged = mergeMeta(byId.get(tenantId), configuredFor(tenantId));
        if (merged) byId.set(tenantId, merged);
      }
      return [...byId.values()]
        .sort((a, b) => a.tenant_id.localeCompare(b.tenant_id))
        .map(toTenantInfo);
    },

    async get(tenantId: string): Promise<TenantInfo | null> {
      const meta = await resolveMeta(tenantId);
      return meta ? toTenantInfo(meta) : null;
    },

    async create(
      tenantId: string,
      options: { name?: string; quota?: TenantQuota } = {},
    ): Promise<TenantInfo> {
      try {
        assertTenantId(tenantId);
      } catch {
        throw tenantControlError('invalid_params', `invalid tenant id "${tenantId}"`);
      }
      const paths = resolveTenantPaths(dataDir, tenantId);
      if (existsSync(paths.root) || configuredFor(tenantId)) {
        throw tenantControlError('conflict', `tenant "${tenantId}" already exists`);
      }

      return withTenantLock({ tenantDir: paths.root, tenantId }, async () => {
        if (existsSync(paths.tenant_file)) {
          throw tenantControlError('conflict', `tenant "${tenantId}" already exists`);
        }
        const quota = options.quota !== undefined ? quotaFromWire(options.quota) : undefined;
        const meta: TenantMeta = {
          tenant_id: tenantId,
          name: options.name ?? tenantId,
          created_at: Date.now(),
          status: 'active',
          ...(quota ? { quota } : {}),
        };
        await atomicWrite(paths.tenant_file, `${JSON.stringify(meta, null, 2)}\n`, {
          ensureDir: true,
        });
        return toTenantInfo(meta);
      });
    },

    async update(
      tenantId: string,
      patch: { name?: string; status?: 'active' | 'disabled'; quota?: TenantQuota },
    ): Promise<TenantInfo> {
      try {
        assertTenantId(tenantId);
      } catch {
        throw tenantControlError('invalid_params', `invalid tenant id "${tenantId}"`);
      }
      const paths = resolveTenantPaths(dataDir, tenantId);
      if (!(await resolveMeta(tenantId))) {
        throw tenantControlError('not_found', `tenant "${tenantId}"`);
      }

      return withTenantLock({ tenantDir: paths.root, tenantId }, async () => {
        const meta = (await readMeta(paths)) ?? synthesizedMeta(tenantId);
        const updated: TenantMeta = {
          ...meta,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
        };
        if (patch.quota !== undefined) {
          const quota = quotaFromWire(patch.quota);
          if (quota) updated.quota = quota;
          else delete updated.quota;
        }
        await atomicWrite(paths.tenant_file, `${JSON.stringify(updated, null, 2)}\n`, {
          ensureDir: true,
        });
        return toTenantInfo(updated);
      });
    },
  };
}
