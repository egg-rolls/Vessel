/**
 * 密钥：**配置里只存环境变量名**（`key_env` / `search_key_env` / `fetch_key_env`）。
 *
 * 三条硬约束（设计 §6.1）：
 * 1. 每次调用时读 `process.env`；key 不进 config 对象、不进任何输出、不进缓存；
 * 2. 缺失 ⇒ `provider_auth_failed`，**本地判、不发请求**、不静默降级；
 * 3. 上游错误体常回显 key 片段 ⇒ 上游文本进 `message` 前先做「精确串替换 + `sk-` 形态」双擦除。
 *
 * 日志侧只允许记 `key_env` 的名字与 `present: true/false`。
 */

import type { WebToolsConfig } from './config';

export type KeyKind = 'search' | 'fetch';

/** 解析出这次调用该看哪个环境变量（`*_key_env` 空则回落 `key_env`） */
export function resolveKeyEnvName(config: WebToolsConfig, kind: KeyKind): string {
  const specific = kind === 'search' ? config.searchKeyEnv : config.fetchKeyEnv;
  return specific !== '' ? specific : config.keyEnv;
}

export interface ResolvedKey {
  /** 环境变量名（可以进日志） */
  envName: string;
  /** 变量值（绝不进日志/输出/缓存） */
  value: string;
  present: boolean;
}

type EnvLike = Record<string, string | undefined>;

export function readKey(
  config: WebToolsConfig,
  kind: KeyKind,
  env: EnvLike = process.env,
): ResolvedKey {
  const envName = resolveKeyEnvName(config, kind);
  const raw = env[envName];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return { envName, value, present: value !== '' };
}

/** 缺 key 的统一文案：明说是本地判定、本次没有发请求 */
export function missingKeyMessage(envName: string): string {
  return `环境变量 ${envName} 未设置或为空；设置后重试（本次没有发出任何请求）`;
}

/**
 * 把上游文本里可能回显的 key 擦掉。
 *
 * 双擦除：
 * - 精确串替换（上游原样回显）；
 * - `sk-` 前缀形态（上游只回显前缀或截断后的形态）。
 */
export function redactKey(text: string, key: string): string {
  let out = text;
  if (key !== '') {
    out = out.split(key).join('<redacted-key>');
    // URL 编码 / JSON 转义后的形态也一起清掉（上游有时把 key 放进 query 回显）
    const encoded = encodeURIComponent(key);
    if (encoded !== key) out = out.split(encoded).join('<redacted-key>');
  }
  return out.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>');
}

/** 上游错误文本进 `message` 之前的统一处理：截断 + 擦除 */
export function sanitizeUpstreamText(text: string, key: string, limit = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const redacted = redactKey(flat, key);
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

/** 日志用的 key 描述：只有名字与否，永远没有值 */
export function describeKey(resolved: ResolvedKey): { key_env: string; present: boolean } {
  return { key_env: resolved.envName, present: resolved.present };
}
