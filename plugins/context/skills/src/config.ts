/**
 * @vessel-agent/plugin-skills — 配置解析
 * @module @vessel-agent/skills/config
 *
 * 设计 §10.1：install 期解析一次（in-process 生效语义 = 重启，§3.2）。
 * 同时接受 camelCase 与 snake_case；未知键忽略；非法值回落缺省 + 告警，
 * 不半应用（sources 内部形状宿主只校验到 object 层，这里自校验）。
 *
 * 三根（§5.1）：project = <cwd>/skills（装配层注入 agent.cwd）；
 * user = ~/.vessel/skills；library = <dataDir>/plugins/skills/library。
 * dataDir 优先级与 recall 同口径：用户显式 > VESSEL_DATA_DIR > ~/.vessel/data；
 * 装配层 applyDataDirFallback 会注入应用层解析值。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_MAX_LOAD_BYTES } from './types.js';

/** 解析后的插件配置（install 期钉死） */
export interface SkillsConfig {
  /** false = install 不注册任何东西 */
  enabled: boolean;
  /** 扫描哪些根 */
  sources: { project: boolean; user: boolean; library: boolean };
  /** watch 三根，300ms 去抖增量重扫 */
  watch: boolean;
  /** unknown / stale 内容的 load 策略：ask（缺省）| deny（fail-closed 收紧） */
  trustDefault: 'ask' | 'deny';
  /** load / get 返回内容上限（字节） */
  maxLoadBytes: number;
  /** 路径边界（装配层回落 basic-tools 的那份；自身配置优先） */
  allowedRoots: string[];
  denyPaths: string[];
  /** project 根解析基准（装配层注入 agent.cwd 兜底） */
  cwd: string;
  /** 数据目录（装配层注入应用层解析值） */
  dataDir: string;
  /** 插件私有目录 <dataDir>/plugins/skills */
  stateDir: string;
  projectRoot: string;
  userRoot: string;
  libraryRoot: string;
}

/** 解析结果：配置 + 告警（非法值回落缺省的可追溯性） */
export interface ParseSkillsConfigResult {
  config: SkillsConfig;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只展开开头的 `~` */
function expandHomePrefix(entry: string): string {
  if (entry === '~') return os.homedir();
  if (entry.startsWith('~/') || entry.startsWith('~\\')) {
    return path.join(os.homedir(), entry.slice(2));
  }
  return entry;
}

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

function readStringArray(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): string[] | undefined {
  const value = record[camel] ?? record[snake];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

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

/** sources 内部形状自校验：非 object / 非 boolean 值 → 缺省 + 告警（不半应用） */
function parseSources(
  value: unknown,
  warnings: string[],
): { project: boolean; user: boolean; library: boolean } {
  const defaults = { project: true, user: true, library: true };
  if (value === undefined) return defaults;
  if (!isRecord(value)) {
    warnings.push('config: sources must be an object; falling back to all roots enabled');
    return defaults;
  }
  const out = { ...defaults };
  for (const key of ['project', 'user', 'library'] as const) {
    const item = value[key];
    if (item === undefined) continue;
    if (typeof item !== 'boolean') {
      warnings.push(`config: sources.${key} must be a boolean; falling back to true`);
      continue;
    }
    out[key] = item;
  }
  return out;
}

/** 把 YAML 配置解析成已知字段（未知键忽略） */
export function parseSkillsConfig(value: unknown): ParseSkillsConfigResult {
  const source = isRecord(value) ? value : {};
  const warnings: string[] = [];

  const enabled = readBoolean(source, 'enabled', 'enabled') ?? true;
  const sources = parseSources(source.sources, warnings);
  const watch = readBoolean(source, 'watch', 'watch') ?? true;

  const trustRaw = readStringField(source, 'trustDefault', 'trust_default');
  let trustDefault: 'ask' | 'deny' = 'ask';
  if (trustRaw !== undefined) {
    if (trustRaw === 'ask' || trustRaw === 'deny') {
      trustDefault = trustRaw;
    } else {
      warnings.push(`config: trust_default "${trustRaw}" invalid; falling back to "ask"`);
    }
  }

  let maxLoadBytes = DEFAULT_MAX_LOAD_BYTES;
  const maxRaw = source.maxLoadBytes ?? source.max_load_bytes;
  if (maxRaw !== undefined) {
    if (typeof maxRaw === 'number' && Number.isFinite(maxRaw) && maxRaw > 0) {
      maxLoadBytes = Math.floor(maxRaw);
    } else {
      warnings.push('config: max_load_bytes must be a positive number; falling back to 65536');
    }
  }

  const cwdRaw = readStringField(source, 'cwd', 'cwd');
  const cwd = cwdRaw !== undefined ? path.resolve(expandHomePrefix(cwdRaw)) : process.cwd();

  const dataDirRaw =
    readStringField(source, 'dataDir', 'data_dir') ??
    (typeof process.env.VESSEL_DATA_DIR === 'string' && process.env.VESSEL_DATA_DIR.trim() !== ''
      ? process.env.VESSEL_DATA_DIR.trim()
      : path.join(os.homedir(), '.vessel', 'data'));
  const dataDir = path.resolve(expandHomePrefix(dataDirRaw));

  const stateDir = path.join(dataDir, 'plugins', 'skills');
  return {
    config: {
      enabled,
      sources,
      watch,
      trustDefault,
      maxLoadBytes,
      allowedRoots: readStringArray(source, 'allowedRoots', 'allowed_roots') ?? [],
      denyPaths: readStringArray(source, 'denyPaths', 'deny_paths') ?? [],
      cwd,
      dataDir,
      stateDir,
      projectRoot: path.join(cwd, 'skills'),
      userRoot: path.join(os.homedir(), '.vessel', 'skills'),
      libraryRoot: path.join(stateDir, 'library'),
    },
    warnings,
  };
}
