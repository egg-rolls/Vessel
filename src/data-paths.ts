/**
 * data_dir 与 tenant 目录布局适配（0.5 E15 / DECISION-010 §2.1）
 *
 * - data_dir 取值：config.dataDir → VESSEL_DATA_DIR → DEFAULT_DATA_DIR；
 * - `~` 展开；相对路径按 cwd 解析；
 * - 布局只由 core 的 TenantPaths 决定，asm 不复制。
 *
 * @module vessel/data-paths
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_DATA_DIR, type VesselConfig } from '../packages/config/src/index';
import {
  resolveSingleTenantPaths as resolveCoreSingleTenantPaths,
  resolveTenantPaths as resolveCoreTenantPaths,
  type TenantPaths,
} from '../packages/core/src/index';
import { ensureTenantLayout } from './tenant-layout-migration';
import { detectTenantLayoutState } from './tenant-layout-state';

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
