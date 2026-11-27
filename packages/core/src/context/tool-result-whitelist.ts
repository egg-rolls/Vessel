/**
 * 工具结果压缩白名单（q-tool-result-whitelist）。
 *
 * 哲学：会话文件本身就是真相源 —— 沟通消息（inbox read / agent read）在应该存在
 * 的时候不被压缩掉。白名单让命中的工具结果在相关生命周期内保持请求视图原文可见，
 * 最终由段边界 compaction 自然收尾（recall 保全原文）。
 *
 * 实现口径（main 评审 PASS 的机制提案）：
 * - **消费侧纯后过滤**：`planClearedToolResults` / `IncrementalClearedToolResultPlanner`
 *   一字不动（确定性不变量、增量合同、reset() 合同全保留）。白名单只在两个消费点
 *   过滤已算出的 tool_call_id 集合：EU 段起点冻结（请求视图）与 MemoryWorkingContext
 *   的压缩审计集合。同输入同输出，纯函数。
 * - **抗 trim 不抗 compaction**：compaction 的摘要 / 移除照常，白名单不豁免段边界清理。
 * - **落盘永远原文**：白名单只影响请求视图投影，不动 SessionState.messages。
 * - 匹配复用 {@link indexToolCalls}（与占位格式化同一回溯语义：tool_call_id →
 *   assistant.tool_calls 的 name + arguments），O(消息条数 + tool_call 数) 建一次索引。
 *
 * @module @vessel-agent/core/context
 */

import type { ToolResultWhitelistRule } from '../types/context.js';
import type { Message } from '../types/provider.js';
import { indexToolCalls, type ToolCallLookup } from './cleared-tool-result.js';

export type { ToolResultWhitelistRule } from '../types/context.js';

/**
 * 内置默认白名单：两条沟通读路径。
 *
 * 配置键缺省时生效；显式 `[]` 关闭；显式列表整体替换（不合并）。
 */
export const DEFAULT_TOOL_RESULT_WHITELIST: readonly ToolResultWhitelistRule[] = [
  { tool: 'inbox', action: 'read' },
  { tool: 'agent', action: 'read' },
];

/**
 * 生效规则：配置缺省（`undefined`）⇒ 内置默认；显式列表（含 `[]`）⇒ 原样使用。
 * 纯函数；不做合并 —— 显式列表整体替换内置默认（可预测）。
 */
export function effectiveToolResultWhitelist(
  configured: readonly ToolResultWhitelistRule[] | undefined,
): readonly ToolResultWhitelistRule[] {
  return configured ?? DEFAULT_TOOL_RESULT_WHITELIST;
}

/** 解析调用参数的顶层 `action` 字符串字段；非法 JSON / 非对象 / 非字符串 ⇒ undefined。 */
function actionFromArguments(args: string | undefined): string | undefined {
  if (!args) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const action = (parsed as Record<string, unknown>).action;
  return typeof action === 'string' ? action : undefined;
}

/**
 * 一条工具调用是否命中白名单（纯函数、确定性）。
 *
 * - tool 级规则（无 action）：工具名精确相等即命中；
 * - action 级规则：工具名相等 **且** 参数顶层 action 精确相等；
 * - 回溯不到调用（lookup 返回 undefined）⇒ 不命中（保守：宁可照常 trim）。
 */
export function isWhitelistedToolCall(
  call: { name: string; arguments: string } | undefined,
  rules: readonly ToolResultWhitelistRule[],
): boolean {
  if (call === undefined || rules.length === 0) return false;
  let action: string | undefined;
  let actionParsed = false;
  for (const rule of rules) {
    if (rule.tool !== call.name) continue;
    if (rule.action === undefined) return true;
    if (!actionParsed) {
      action = actionFromArguments(call.arguments);
      actionParsed = true;
    }
    if (action !== undefined && action === rule.action) return true;
  }
  return false;
}

/**
 * 从已算出的占位集合里过滤掉白名单命中的 tool_call_id（纯函数，**不改任何消息**）。
 *
 * 空集合 / 空规则 ⇒ 原样返回（零回归快路径）。顺序保持输入顺序（与
 * `planClearedToolResults` 的消息顺序口径一致）。
 */
export function filterWhitelistedToolResults(
  messages: readonly Message[],
  ids: readonly string[],
  rules: readonly ToolResultWhitelistRule[],
): string[] {
  if (ids.length === 0 || rules.length === 0) return [...ids];
  const lookup = indexToolCalls(messages);
  return ids.filter((id) => !isWhitelistedToolCall(lookup(id), rules));
}

/**
 * 归一配置值（additive 键的读容忍）：非数组 ⇒ undefined（= 未配置，走内置默认）；
 * 数组 ⇒ 只保留合法元素（tool 为非空字符串；action 若存在必须为字符串）。
 * 空数组保留为 `[]`（= 显式关闭），与「未配置」语义区分。
 */
export function normalizeToolResultWhitelist(
  value: unknown,
): ToolResultWhitelistRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rules: ToolResultWhitelistRule[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.tool !== 'string' || record.tool.length === 0) continue;
    if (record.action !== undefined && typeof record.action !== 'string') continue;
    rules.push(
      record.action !== undefined
        ? { tool: record.tool, action: record.action }
        : { tool: record.tool },
    );
  }
  return rules;
}

/** 批量过滤时复用已建好的索引（与 {@link filterWhitelistedToolResults} 同一语义）。 */
export function filterWhitelistedWithLookup(
  lookup: ToolCallLookup,
  ids: readonly string[],
  rules: readonly ToolResultWhitelistRule[],
): string[] {
  if (ids.length === 0 || rules.length === 0) return [...ids];
  return ids.filter((id) => !isWhitelistedToolCall(lookup(id), rules));
}
