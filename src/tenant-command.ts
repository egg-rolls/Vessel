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
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertTenantId,
  atomicWrite,
  resolveTenantPaths,
  TenantIdError,
  type TenantPaths,
} from '../packages/core/src/index';
import { acquireTenantLock, TenantLockError } from './tenant-lock';

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
  let lock: Awaited<ReturnType<typeof acquireTenantLock>> | undefined;
  try {
    lock = await acquireTenantLock({
      tenantDir: paths.root,
      tenantId,
      ...(options.now ? { now: options.now } : {}),
      ...(options.hostname ? { hostname: options.hostname } : {}),
      ...(options.pid ? { pid: options.pid } : {}),
      ...(options.isPidAlive ? { isPidAlive: options.isPidAlive } : {}),
    });
    return await action();
  } catch (error) {
    if (error instanceof TenantLockError) {
      return errorResult(1, error.message);
    }
    throw error;
  } finally {
    await lock?.release();
  }
}

/** `vessel tenant list [--json]` */
export async function tenantListCommand(
  options: TenantCommandOptions,
): Promise<TenantCommandResult> {
  let entries: string[];
  try {
    const dirents = await readdir(tenantsRoot(options.dataDir), { withFileTypes: true });
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
    const paths = resolveTenantPaths(options.dataDir, id);
    tenants.push((await readMeta(paths)) ?? synthesizedMeta(id));
  }
  tenants.sort((a, b) => a.tenant_id.localeCompare(b.tenant_id));

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

  const paths = resolveTenantPaths(options.dataDir, tenantId);
  if (!existsSync(paths.root)) {
    return errorResult(1, `not_found: tenant "${tenantId}"`);
  }

  const meta = (await readMeta(paths)) ?? synthesizedMeta(tenantId);
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
