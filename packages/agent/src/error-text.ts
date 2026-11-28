/**
 * agent 包单一错误展示文本（q-error-e1，设计 §3.2 / D2）。
 *
 * 收敛原散布 6 处的同形 `errorText`（service / team-service / inbox /
 * conversation-store / conversation-budget / tool）：统一调 core `errorSummary`。
 * 拍扁文本只用于**展示**（日志字段 / 事件 reason），不再作为跨层**数据**——
 * 跨层边界读结构化字段走 errorSummary / 注册表。
 *
 * 渲染口径（lead 裁定 B）：message 原样；仅当 cause 链非空时追加链摘要
 * （每层 code: message）。顶层不加 code 前缀——既有调用点大量
 * `spawn_failed: ${errorText(e)}` 手拼前缀，加顶层 code 会双前缀。
 * agent 包自产错误均无 cause ⇒ 现网展示文本逐字不变。
 *
 * @module @vessel-agent/agent
 */

import { errorSummary } from '@vessel-agent/core';

/** 错误 → 单行展示文本（message 原样 + cause 链摘要，防环/截断由 errorSummary 保证） */
export function errorText(error: unknown): string {
  const summary = errorSummary(error);
  if (summary.chain.length === 0) return summary.message;
  const chain = summary.chain
    .map((link) => (link.code !== undefined ? `${link.code}: ${link.message}` : link.message))
    .join(' <- ');
  return `${summary.message} (cause: ${chain})`;
}
