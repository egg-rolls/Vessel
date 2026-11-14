/**
 * 环境快照（上下文卡）的**发布指纹**：跨进程重启的去重凭据（0.52）。
 * @module @vessel-agent/core/context
 *
 * 解决的缺口：去重状态原来是 `ExecutionUnit.lastSystemContext` —— **纯内存**。每次重启
 * gateway 都是新 body、新 EU，于是 `last === undefined` ⇒ 下一条消息必然重发一张全量
 * 「上下文」卡，哪怕只有消息数/tokens 变了（用户报的「每次重启都发一次」）。
 *
 * 指纹按 session 落进 `SessionState`（RunJournal 单写口），重启后 seed 时恢复，于是：
 * - 新会话（无指纹）⇒ 发全量卡（用户要的「新会话开始才发」）；
 * - 重启且 hash / model / tools 全同 ⇒ **不发**；
 * - 有实质变化 ⇒ 发卡（跨进程拿不到原文差，所以只发全量卡 + `previous_hash`）。
 *
 * 这里只放纯函数与类型判定，落盘路径（file / sqlite backend）与 EU 都复用它。
 */

import type { PromptContextFingerprint } from '../types/context.js';

/** 校验一份落盘指纹；任何字段不合法即丢弃（宁可不建卡，也不要不准的去重）。 */
export function normalizePromptContextFingerprint(
  value: unknown,
): PromptContextFingerprint | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const { hash, model, tools_count: toolsCount, at } = raw;
  if (typeof hash !== 'string' || hash === '') return undefined;
  if (typeof model !== 'string') return undefined;
  if (typeof toolsCount !== 'number' || !Number.isFinite(toolsCount)) return undefined;
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  return { hash, model, tools_count: toolsCount, at };
}

/** 两份指纹是否代表「同一个环境」——只有 hash / model / tools 参与判定。 */
export function samePromptContext(
  left: PromptContextFingerprint | undefined,
  right: PromptContextFingerprint | undefined,
): boolean {
  if (left === undefined || right === undefined) return false;
  return (
    left.hash === right.hash && left.model === right.model && left.tools_count === right.tools_count
  );
}

/**
 * 本轮到底要不要发这张卡。
 *
 * - `live`（同进程上一份快照存在）⇒ 交给既有 `systemContextChanges` 逻辑（可能发布增量卡）；
 * - `live` 不在但有 `restored`（重启后从 SessionState 恢复）⇒ 只在指纹不同才发；
 * - 都没有 ⇒ 发（新会话）。
 */
export function shouldPublishSystemContext(input: {
  live: boolean;
  restored?: PromptContextFingerprint;
  next: PromptContextFingerprint;
}): boolean {
  if (input.live) return true;
  if (input.restored === undefined) return true;
  return !samePromptContext(input.restored, input.next);
}
