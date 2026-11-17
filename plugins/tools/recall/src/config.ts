/**
 * `recall` 插件的配置解析
 * @module @vessel-agent/recall
 *
 * 解析规则与其它插件同一套：camelCase 优先、兼容 snake_case、非法值回落缺省、未知键忽略。
 * 只有两个键：
 *
 * - `data_dir`：数据目录（`<data_dir>/sessions` 就是会话根）。缺省按
 *   `VESSEL_DATA_DIR` 环境变量 → `~/.vessel/data`；装配层会把它按 `config.data_dir`
 *   **显式注入**（`buildPluginConfigMap`），所以正常情况下不需要用户配。
 * - `enabled`：`false` 时安装期直接返回，不注册工具。
 *
 * 为什么不从 `ctx` 拿数据目录：`ToolContext` 没有它（只有 `session_id` / `cwd`），而
 * 插件自己读 `~/.vessel/config.yaml` 会变成第二套配置解析（热应用语义会分裂）。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { resolveSingleTenantPaths } from '@vessel-agent/core';

/** 插件名。 */
export const RECALL_PLUGIN_NAME = 'recall';

/** 解析后的配置。 */
export interface RecallConfig {
  /** `<dataDir>/sessions`（会话根：`<sessionId>/wal.log` + `compactions.ndjson`） */
  sessionsDir: string;
  /** `false` ⇒ 安装期不注册工具 */
  enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只展开开头的 `~`，其余保持原样。 */
function expandHomePrefix(entry: string): string {
  if (entry === '~') return os.homedir();
  if (entry.startsWith('~/') || entry.startsWith('~\\')) {
    return path.join(os.homedir(), entry.slice(2));
  }
  return entry;
}

function readString(
  source: Record<string, unknown>,
  camel: string,
  snake: string,
): string | undefined {
  for (const value of [source[camel], source[snake]]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** 解析配置（`fallbackDataDir` 由安装方给：插件自己不该硬编码用户的目录）。 */
export function parseRecallConfig(value: unknown, fallbackDataDir: string): RecallConfig {
  const source = isRecord(value) ? value : {};
  const configured = readString(source, 'dataDir', 'data_dir');
  const fromEnv = process.env.VESSEL_DATA_DIR;
  const raw =
    configured ??
    (typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : fallbackDataDir);
  // 与 `resolveDataDir` 同一口径：绝对化 + 展开 `~`；租户根布局（0.49 T2）用
  // `resolveSingleTenantPaths` 拼 `sessions` —— 不在插件里另写一套路径规则。
  const dataDir = path.resolve(expandHomePrefix(raw));
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : true;
  return { sessionsDir: resolveSingleTenantPaths(dataDir).sessions_dir, enabled };
}

/** `resolveRecallConfig` 的别名（装配层读起来更直白）。 */
export function resolveRecallConfig(value: unknown, fallbackDataDir: string): RecallConfig {
  return parseRecallConfig(value, fallbackDataDir);
}
