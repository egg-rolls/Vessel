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
  resolveTenantPaths as resolveCoreTenantPaths,
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

/** 按 tenant 派生冻结目录布局（委托 core）。 */
export function resolveTenantPaths(dataDir: string, tenantId: string): TenantPaths {
  return resolveCoreTenantPaths(dataDir, tenantId);
}
