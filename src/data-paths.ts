/**
 * data_dir 与 tenant 目录布局适配（0.5 E15 / DECISION-010 §2.1）
 *
 * - data_dir 取值：config.dataDir → VESSEL_DATA_DIR → DEFAULT_DATA_DIR；
 * - `~` 展开；相对路径按 cwd 解析；
 * - 布局只由 core 的 TenantPaths 决定，asm 不复制。
 *
 * @module vessel/data-paths
 */

import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_DATA_DIR, type VesselConfig } from '../packages/config/src/index';
import {
  assertTenantId,
  resolveSingleTenantPaths as resolveCoreSingleTenantPaths,
  resolveTenantPaths as resolveCoreTenantPaths,
  type TenantPaths,
} from '../packages/core/src/index';
import { ensureTenantLayout } from './tenant-layout-migration';
import { detectTenantLayoutState, parseLayoutMarker } from './tenant-layout-state';

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

/** T2 迁移后保留在根布局的单 id 数据文件（`<dataDir>/tenant.json`）。 */
const PERSISTED_TENANT_FILE = 'tenant.json';
/** T2 迁移 marker；仅在 `tenant.json` 不存在时作为 T4 过渡 fallback。 */
const LAYOUT_MARKER_FILE = '.layout.json';

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
 * 读取 T2 迁移 marker 的单 id（仅 `tenant.json` 不存在时调用）。
 * marker 缺失/不可解析 → undefined；不写文件。
 */
function readMarkerTenantId(dataDir: string): string | undefined {
  const markerPath = path.join(dataDir, LAYOUT_MARKER_FILE);
  let raw: string;
  try {
    raw = readFileSync(markerPath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const marker = parseLayoutMarker(parsed);
  if (marker === null) return undefined;
  try {
    return assertTenantId(marker.source_tenant);
  } catch {
    return undefined;
  }
}

/**
 * 读取持久化的单 id（只读；不创建/不修改文件）。
 *
 * 优先级（T4 R1 errata）：
 * 1. `<dataDir>/tenant.json` 的 `tenant_id`（T2 冻结形状）；
 * 2. 仅当 `tenant.json` **不存在**时，`<dataDir>/.layout.json` 的 `source_tenant`
 *    （T2 迁移 marker；T5 随迁移层删除，只是 T4 过渡）；
 * 3. 都没有 → undefined（调用方回落 `loadConfig()` 的 `default`）。
 *
 * `tenant.json` 存在但不可读 / JSON 损坏 / `tenant_id` 非法 → 抛错 fail-fast，
 * 不静默回退 default（避免指向错误路径、像数据丢失）。
 */
export function readPersistedTenantId(dataDir: string): string | undefined {
  const tenantPath = path.join(dataDir, PERSISTED_TENANT_FILE);
  let raw: string;
  try {
    raw = readFileSync(tenantPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return readMarkerTenantId(dataDir);
    }
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
 * T4 删除 config `tenant` 块后解析结果恒为内部常量 `default`；真实单 id 来自
 * `<dataDir>/tenant.json` 或（仅当其不存在时）`.layout.json` 的 `source_tenant`
 * （R1：路径文件名段保持原样）。fresh 数据根两者都没有时回 `default`。
 */
export function resolveEffectiveTenantId(configTenantId: string, dataDir: string): string {
  return readPersistedTenantId(dataDir) ?? configTenantId;
}

/** 按 tenant 派生冻结目录布局（委托 core；旧树语义）。 */
export function resolveTenantPaths(dataDir: string, tenantId: string): TenantPaths {
  return resolveCoreTenantPaths(dataDir, tenantId);
}

/**
 * 单公司根布局 `<dataDir>/**`（0.49 T2 C1/C9）。
 *
 * 写模式与已迁移的读取一律走这里；调用方必须已确定 `tenantId` 是单公司 id。
 */
export function resolveSingleTenantPaths(dataDir: string, tenantId: string): TenantPaths {
  return resolveCoreSingleTenantPaths(dataDir, tenantId);
}

/** 只读入口布局判定失败（C10：不读半迁移数据）。 */
export interface TenantLayoutReadError extends Error {
  code: 'layout_migration_incomplete';
  state: 'migrating' | 'blocked';
}

function layoutReadError(dataDir: string, state: 'migrating' | 'blocked'): TenantLayoutReadError {
  return Object.assign(
    new Error(
      `layout_migration_incomplete: layout under "${dataDir}" is ${state}; refusing to read partial data`,
    ),
    { code: 'layout_migration_incomplete' as const, state },
  );
}

/**
 * 只读入口的布局选择（0.49 T2 C10）：
 *
 * - `legacy` → 旧树（`<dataDir>/tenants/<sid>`），不构造 SQLite、不拿写锁；
 * - `migrating` / `blocked` → 中止（不读半迁移数据）；
 * - `root` / `fresh` → 根布局。
 *
 * 同一进程只用一种布局，不做逐文件 union 双读。
 */
export async function resolveReadonlyTenantPaths(
  dataDir: string,
  singleTenantId: string,
): Promise<TenantPaths> {
  const status = await detectTenantLayoutState(dataDir, singleTenantId);
  if (status.state === 'migrating' || status.state === 'blocked') {
    throw layoutReadError(dataDir, status.state);
  }
  if (status.state === 'legacy') return resolveCoreTenantPaths(dataDir, singleTenantId);
  return resolveCoreSingleTenantPaths(dataDir, singleTenantId);
}

/**
 * 写模式布局（0.49 T2 C9/C14）：先 `ensureTenantLayout({apply:true})`（含
 * `migrating` 前滚恢复），成功后再返回根布局。
 *
 * 所有单 id 本地写命令（bootstrap / tenant update / eval / trace prune /
 * migrate / `-c`/`-r` 续接）统一走这里，避免在 legacy 树上先写根造成冲突。
 * 失败抛 `TenantLayoutMigrationError`（blocked/冲突等稳定 code）。
 */
export async function ensureWriteTenantPaths(
  dataDir: string,
  singleTenantId: string,
): Promise<TenantPaths> {
  await ensureTenantLayout({ dataDir, singleTenantId, apply: true });
  return resolveCoreSingleTenantPaths(dataDir, singleTenantId);
}
