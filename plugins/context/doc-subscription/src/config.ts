/**
 * @vessel-agent/doc-subscription - 配置解析
 * @module @vessel-agent/doc-subscription/config
 *
 * 同时接受 camelCase 与 snake_case；未知键忽略。所有数值缺省时回落到默认值，
 * 非法值（非有限数 / 非正数）同样回落，避免配置错误让插件整体失效。
 */

import * as os from 'node:os';
import * as path from 'node:path';

/** 插件配置（解析后形态） */
export interface DocSubscriptionConfig {
  /** 订阅状态目录；per-session JSON 写在 `<stateDir>/sessions/` */
  stateDir: string;
  /** 相对路径解析基准 */
  cwd: string;
  /** 允许的根；空 = 不限制根（内置 denylist 仍生效） */
  allowedRoots: string[];
  /** 追加到内置 denylist 的敏感路径 */
  denyPaths: string[];
  /** 首次投递（或无快照时）允许内联的最大字节数 */
  maxFullBytes: number;
  /** unified diff 字节上限 */
  maxDiffBytes: number;
  /** unified diff 行数上限 */
  maxDiffLines: number;
  /** 每个 run 注入内容的总字节预算 */
  maxTotalBytesPerRun: number;
  /** false 时 install 直接返回，不注册工具与 hook */
  enabled: boolean;
}

/** 默认值 */
export const DEFAULT_CONFIG: Readonly<DocSubscriptionConfig> = {
  stateDir: path.join(os.homedir(), '.vessel', 'subscriptions'),
  cwd: process.cwd(),
  allowedRoots: [],
  denyPaths: [],
  maxFullBytes: 102400,
  maxDiffBytes: 16384,
  maxDiffLines: 200,
  maxTotalBytesPerRun: 262144,
  enabled: true,
};

/** 类型守卫：值是否为对象记录 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 只展开开头的 `~`，其余保持原样 */
function expandHomePrefix(entry: string): string {
  if (entry === '~') return os.homedir();
  if (entry.startsWith('~/') || entry.startsWith('~\\')) {
    return path.join(os.homedir(), entry.slice(2));
  }
  return entry;
}

/** 读取字符串数组字段（camelCase 优先，兼容 snake_case） */
function readStringArray(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): string[] | undefined {
  const value = record[camel] ?? record[snake];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

/** 读取非空字符串字段（camelCase 优先，空值回落 snake_case） */
function readStringField(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): string | undefined {
  for (const value of [record[camel], record[snake]]) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/** 读取正有限数字字段（camelCase 优先，兼容 snake_case） */
function readPositiveNumber(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): number | undefined {
  for (const value of [record[camel], record[snake]]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** 读取布尔字段（只认显式 boolean） */
function readBoolean(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): boolean | undefined {
  for (const value of [record[camel], record[snake]]) {
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

/** 把 YAML 配置解析成已知字段（未知键忽略） */
export function parseDocSubscriptionConfig(value: unknown): DocSubscriptionConfig {
  const source = isRecord(value) ? value : {};

  const stateDirValue = readStringField(source, 'stateDir', 'state_dir');
  const cwdValue = readStringField(source, 'cwd', 'working_dir');

  const stateDir =
    stateDirValue !== undefined
      ? path.resolve(expandHomePrefix(stateDirValue))
      : DEFAULT_CONFIG.stateDir;
  const cwd =
    cwdValue !== undefined ? path.resolve(expandHomePrefix(cwdValue)) : DEFAULT_CONFIG.cwd;

  return {
    stateDir,
    cwd,
    allowedRoots: readStringArray(source, 'allowedRoots', 'allowed_roots') ?? [],
    denyPaths: readStringArray(source, 'denyPaths', 'deny_paths') ?? [],
    maxFullBytes:
      readPositiveNumber(source, 'maxFullBytes', 'max_full_bytes') ?? DEFAULT_CONFIG.maxFullBytes,
    maxDiffBytes:
      readPositiveNumber(source, 'maxDiffBytes', 'max_diff_bytes') ?? DEFAULT_CONFIG.maxDiffBytes,
    maxDiffLines:
      readPositiveNumber(source, 'maxDiffLines', 'max_diff_lines') ?? DEFAULT_CONFIG.maxDiffLines,
    maxTotalBytesPerRun:
      readPositiveNumber(source, 'maxTotalBytesPerRun', 'max_total_bytes_per_run') ??
      DEFAULT_CONFIG.maxTotalBytesPerRun,
    enabled: readBoolean(source, 'enabled', 'enabled') ?? DEFAULT_CONFIG.enabled,
  };
}
