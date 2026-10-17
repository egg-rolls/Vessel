/**
 * MCP 工具名规则（DECISION-008 §4.2 + Addendum B §9.3 Q4）。
 *
 * - 非法字符（非 `[A-Za-z0-9_]`，连字符也算非法）替换为 `_`；
 * - 默认加前缀 `mcp__<server>__<tool>`；`toolPrefix === false` 时用原名；
 * - 超过 64 字符：取前 55 + `_` + 原始名的 8 位 SHA-1 十六进制 = 64（总长上限）。
 */

import { createHash } from 'node:crypto';

const INVALID_SEGMENT = /[^A-Za-z0-9_]/g;
/** 工具名总长上限 */
export const MAX_TOOL_NAME_LENGTH = 64;
/** hash 后缀长度 */
export const HASH_SUFFIX_LENGTH = 8;
/** 截断时保留的原始前缀长度：64 - 1（下划线）- 8（hash） */
const TRUNCATED_PREFIX_LENGTH = MAX_TOOL_NAME_LENGTH - HASH_SUFFIX_LENGTH - 1;

/** 清洗单个名称段 */
export function sanitizeSegment(value: string): string {
  return value.replace(INVALID_SEGMENT, '_');
}

/** 8 位 SHA-1 前缀（确定性、避免截断碰撞） */
export function hashSuffix(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, HASH_SUFFIX_LENGTH);
}

/** 生成暴露给模型的工具名 */
export function exposedToolName(server: string, tool: string, toolPrefix: boolean): string {
  const raw = toolPrefix
    ? `mcp__${sanitizeSegment(server)}__${sanitizeSegment(tool)}`
    : sanitizeSegment(tool);
  if (raw.length <= MAX_TOOL_NAME_LENGTH) return raw;
  return `${raw.slice(0, TRUNCATED_PREFIX_LENGTH)}_${hashSuffix(raw)}`;
}
