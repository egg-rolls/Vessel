/**
 * 消息身份（0.51）：给落盘的 assistant 正文盖章「同一次 run 内第几段」。
 *
 * 存在理由：Web 时间线跨来源去重（认领）过去只能拿正文内容当代理键，而 Output 阶段
 * guardrail 会在落盘前改写正文（PII 打码：13 位数字的中间 7 位换成 `*`），
 * 于是实时流那份（原文）与落盘那份（打码后）内容不等 ⇒ 认不出是同一段 ⇒ 两份都渲染。
 * `run_id` + 段序是结构化事实：内容被怎么改写都不影响「这是同一段」。
 *
 * 为什么是「后置盖章」而不是写入时计数：
 * - **一个口径**：身份只在落盘（`RunJournal.saveSessionState`）与事件投影
 *   （`projectMessages`）两个出口盖章，两者共用本函数；写入点（`addContext`）
 *   只管 `run_id`，不维护计数器 —— 计数器分散在多处就等于多处可能漂移。
 * - **幂等 + 续编**：已经盖过的段序**永不重写**，新消息续在「该 run 已分配的最大
 *   段序 + 1」。压缩会把早期段整条删掉（摘要替换），若按「从头数第几个」重编，
 *   幸存段的段序就会整体前移 ⇒ 与 Web 侧流式段序错位；续编则天然不受影响。
 * - **resume 安全**：投影重建出来的消息同样由本函数盖章，所以 resume 不会把身份丢掉。
 *
 * 段序口径（与 Web 侧一致）：只数「role 是 assistant 且正文非空（trim 后）」的消息，
 * 0 起。只有 tool_calls、正文为空的那一轮不占号 —— 它在时间线上不产生正文段。
 *
 * @module @vessel-agent/core/session
 */

import type { Message } from '../types/provider.js';

/** 该消息是否占用一个正文段号（口径见文件头注释）。 */
function occupiesSegment(message: Message): boolean {
  return message.role === 'assistant' && message.content.trim().length > 0;
}

/**
 * 给一条**正在写入上下文**的消息盖 `run_id`（只补缺，不覆盖已有值）。
 *
 * 为什么不覆盖：resume / rotate 会先把历史消息灌回上下文，那些消息的身份属于**原来那次
 * run**，被当前 runId 改写就是伪造归属（历史那轮的正文段会认不出来）。同理，已经带
 * `run_id` 的消息一律原样返回 —— 不产生副本，调用侧引用身份不变。
 */
export function withRunIdentity(message: Message, runId: string): Message {
  if (typeof message.run_id === 'string' && message.run_id.length > 0) return message;
  if (runId.length === 0) return message;
  return { ...message, run_id: runId };
}

/**
 * 给一批消息补上 `run_segment`（原地写入；只补缺，不改已有值）。
 *
 * 调用点必须保证「同一批消息按会话顺序排列」（`state.messages` / 投影结果都是），
 * 否则「最大段序 + 1」的续编会给出与流式侧不一致的号。
 */
export function assignMessageIdentities(messages: readonly Message[]): void {
  if (messages.length === 0) return;
  /** run_id → 已分配的最大段序（缺省 = 该 run 还没有正文段）。 */
  const lastByRun = new Map<string, number>();
  for (const message of messages) {
    const runId = message.run_id;
    if (typeof runId !== 'string' || runId.length === 0) continue;
    if (!occupiesSegment(message)) continue;
    const assigned = message.run_segment;
    const known = lastByRun.get(runId);
    if (typeof assigned === 'number' && Number.isFinite(assigned)) {
      // 已盖章：只把水位抬到它（压缩 / 重投影都可能是「中间缺了几段」的形状）。
      lastByRun.set(runId, known === undefined ? assigned : Math.max(known, assigned));
      continue;
    }
    const next = known === undefined ? 0 : known + 1;
    message.run_segment = next;
    lastByRun.set(runId, next);
  }
}
