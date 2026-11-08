/**
 * data_dir 与 tenant 路径解析（0.49 T5：只保留根布局）
 *
 * - data_dir 取值：config.dataDir → VESSEL_DATA_DIR → DEFAULT_DATA_DIR；
 * - `~` 展开；相对路径按 cwd 解析；
 * - 0.49 T5 起只支持根布局 `<dataDir>/**`；`<dataDir>/tenants/**` 非空即 fail-fast，
 *   不读 / 不迁 / 不移 / 不删 / 不写 marker/journal；
 * - 布局只由 core 的 TenantPaths 决定，asm 不复制。
 *
 * @module vessel/data-paths
 */

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_DATA_DIR, type VesselConfig } from '../packages/config/src/index';
import {
  assertTenantId,
  resolveSingleTenantPaths as resolveCoreSingleTenantPaths,
  type TenantPaths,
} from '../packages/core/src/index';

/** 展开开头的 `~`（支持 `~`、`~/x`、`~\x`） */
export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/** 非空白字符串 */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * 解析全局数据根为绝对路径。
 * env 只作为兜底（正常路径下 VESSEL_DATA_DIR 已由 loader 写入 config.dataDir）。
 */
export function resolveDataDir(
  config: VesselConfig,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = nonEmpty(config.dataDir) ?? nonEmpty(env.VESSEL_DATA_DIR);
  return path.resolve(expandHome(configured ?? DEFAULT_DATA_DIR));
}

/** 根布局的单 id 数据文件（`<dataDir>/tenant.json`）。 */
const PERSISTED_TENANT_FILE = 'tenant.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `tenant.json` 存在但损坏 / 形状非法：fail-fast，不静默回退 default。 */
function invalidPersistedTenantFile(file: string, detail: string): Error {
  return new Error(
    `invalid tenant.json at ${file}: ${detail}; refusing to fall back to the default tenant id`,
  );
}

/**
 * 读取持久化的单 id（只读；不创建/不修改文件）。
 *
 * 0.49 T5：唯一来源是 `<dataDir>/tenant.json` 的 `tenant_id`（T2 冻结形状）。
 * 文件缺失 → undefined（调用方回落 `loadConfig()` 的 `default`）。
 * 存在但不可读 / JSON 损坏 / `tenant_id` 非法 → 抛错 fail-fast（错误含路径），
 * 不静默回退 default（避免指向错误路径、像数据丢失）。
 */
export function readPersistedTenantId(dataDir: string): string | undefined {
  const tenantPath = path.join(dataDir, PERSISTED_TENANT_FILE);
  let raw: string;
  try {
    raw = readFileSync(tenantPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    const detail = error instanceof Error ? error.message : String(error);
    throw invalidPersistedTenantFile(tenantPath, `cannot read file: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw invalidPersistedTenantFile(tenantPath, `invalid JSON: ${detail}`);
  }
  if (!isRecord(parsed)) {
    throw invalidPersistedTenantFile(tenantPath, 'expected a JSON object');
  }
  const value = parsed.tenant_id;
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidPersistedTenantFile(tenantPath, 'expected a non-empty string "tenant_id"');
  }
  try {
    return assertTenantId(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw invalidPersistedTenantFile(tenantPath, `invalid tenant_id: ${detail}`);
  }
}

/**
 * 生效的单 id：持久化来源优先，否则用 `loadConfig()` 的解析结果。
 *
 * T4 删除 config `tenant` 块后解析结果恒为内部常量 `default`；真实单 id 只来自
 * `<dataDir>/tenant.json`（R1：路径文件名段保持原样）。fresh 数据根没有该文件时
 * 回 `default`，且不落盘。
 */
export function resolveEffectiveTenantId(configTenantId: string, dataDir: string): string {
  return readPersistedTenantId(dataDir) ?? configTenantId;
}

/** 0.49 T5 后仍存在非根布局数据（`<dataDir>/tenants/**`）。 */
export interface NonRootLayoutError extends Error {
  code: 'non_root_layout';
  tenants_dir: string;
  entries: number;
  bytes: number;
}

interface TreeMeasure {
  entries: number;
  bytes: number;
}

/** 递归统计条目数与字节数（只读；不跟随 symlink）。 */
function measureTree(dir: string): TreeMeasure {
  const measure: TreeMeasure = { entries: 0, bytes: 0 };
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      measure.entries += 1;
      const child = path.join(current, name);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(child);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        measure.bytes += stat.size;
      } else if (stat.isDirectory()) {
        stack.push(child);
      } else if (stat.isFile()) {
        measure.bytes += stat.size;
      }
    }
  }
  return measure;
}

function nonRootLayoutError(
  targetPath: string,
  measure: TreeMeasure,
  firstEntry: string | undefined,
  detail: string,
): NonRootLayoutError {
  const sample =
    firstEntry === undefined ? '' : ` (first entry "${path.join(targetPath, firstEntry)}")`;
  return Object.assign(
    new Error(
      `non_root_layout: ${detail} found at "${targetPath}"${sample}: ` +
        `${measure.entries} entries, ${measure.bytes} bytes; ` +
        'this build only supports the root layout — archive or migrate this data before starting',
    ),
    {
      code: 'non_root_layout' as const,
      tenants_dir: targetPath,
      entries: measure.entries,
      bytes: measure.bytes,
    },
  );
}

/** 旧树 `<dataDir>/tenants/*`：非空即拒绝（空目录允许）。 */
function assertNoLegacyTenantData(dataDir: string): void {
  const tenantsDir = path.join(dataDir, 'tenants');
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(tenantsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory()) {
    throw nonRootLayoutError(
      tenantsDir,
      { entries: 1, bytes: stat.size },
      undefined,
      'legacy tenant data',
    );
  }
  const names = readdirSync(tenantsDir);
  if (names.length === 0) return;
  throw nonRootLayoutError(tenantsDir, measureTree(tenantsDir), names[0], 'legacy tenant data');
}

/**
 * T2 迁移中断残留 `<dataDir>/.t2-migrating-*`：journal 可能含唯一数据副本。
 * 任一非空 → 拒绝（空目录 / 不存在允许）。
 */
function assertNoMigrationStaging(dataDir: string): void {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    if (!name.startsWith('.t2-migrating-')) continue;
    const target = path.join(dataDir, name);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isDirectory()) {
      throw nonRootLayoutError(
        target,
        { entries: 1, bytes: stat.size },
        undefined,
        'incomplete migration staging',
      );
    }
    const inner = readdirSync(target);
    if (inner.length === 0) continue;
    throw nonRootLayoutError(target, measureTree(target), inner[0], 'incomplete migration staging');
  }
}

/**
 * 0.49 T5 启动守卫（C6）：
 * - `<dataDir>/tenants/<sid>` 或任何非空 `<dataDir>/tenants/*`；
 * - 任何非空 `<dataDir>/.t2-migrating-*`（T2 迁移中断残留）。
 *
 * 命中 → 抛 `non_root_layout`（错误含路径、条目数、字节数）。
 * 只读：不读被拒数据的内容、不迁、不移、不删、不写 marker/journal。
 * 空目录 / 不存在允许。
 */
export function assertRootTenantLayout(dataDir: string): void {
  assertNoLegacyTenantData(dataDir);
  assertNoMigrationStaging(dataDir);
}

/**
 * 单公司根布局 `<dataDir>/**`（0.49 T2 C1 / T5 C6）。
 *
 * 写模式与只读入口统一走这里；调用方必须已确定 `tenantId` 是单公司 id。
 * 非根布局数据存在时 fail-fast。
 */
export function resolveSingleTenantPaths(dataDir: string, tenantId: string): TenantPaths {
  assertRootTenantLayout(dataDir);
  return resolveCoreSingleTenantPaths(dataDir, tenantId);
}
