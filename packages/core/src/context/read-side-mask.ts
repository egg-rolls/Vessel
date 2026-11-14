/**
 * 脱敏器端口（0.52 pii-guard → 0.52 pii-vault）。
 * @module @vessel-agent/core/context
 *
 * 位置纪律（0.52 用户裁定，见 `docs/architecture/message-invariants.md`）：
 * **脱敏发生在 append 侧** —— 消息写入上下文那一刻就把真值换成占位符，落盘即占位符。
 *
 * 为什么不再在「请求构造层」打码：两条产品不变量
 * 1. **可见性对等**：UI 渲染的必须包含 agent 看得到的一切。请求侧打码会让模型看到
 *    掩码、UI 看到原文 —— 正是这条不变量禁止的两级形态。
 * 2. **请求 messages 只许 append**：任何一条已发出的消息都不许回改（前缀缓存）。
 * 请求侧打码虽然不改 store，但会让「模型看到的序列」依赖于投影逻辑而不是存储字节。
 *
 * 于是唯一的打码点是 `ExecutionUnit.maskForAppend`：`vault.protect()`（句柄化）
 * 之后再跑这里注册的插件 masker（幂等，给第三方 masker 留扩展点）。
 *
 * 0.52 之前的教训仍然成立：guardrail 的 Output / ToolResult 阶段返回 `replacement`
 * 会被写进会话存储（append-only transcript 不可逆），13 位毫秒时间戳因此被当成手机号
 * 永久污染历史 —— 所以 guardrail 只「检测 + 报告」，这里只做「形状替换」。
 *
 * 这里只放「纯函数 + 端口类型」，不认识任何具体规则，规则由插件 / core 的 `pii/rules` 提供。
 */

import type { ReadSideMasker } from '../types/plugin.js';

export type { ReadSideMasker };

/** 依次应用脱敏器（后面的看到前面的结果）；空列表原样返回 */
export function applyReadSideMaskers(
  text: string,
  maskers: readonly ReadSideMasker[] | undefined,
): string {
  if (maskers === undefined || maskers.length === 0) return text;
  let result = text;
  for (const masker of maskers) {
    const next = masker.mask(result);
    if (typeof next === 'string') result = next;
  }
  return result;
}

/** 最少只需要 content 的消息形状（避免这里的端口依赖完整 Provider 消息类型） */
export interface MaskableMessage {
  content: string;
}

/**
 * 请求 / 展示级投影：返回**新数组**，不修改入参数组与元素，也不写回任何存储。
 * 内容没变的消息保持同一个对象引用，方便上层判定「这次投影到底改没改」。
 */
export function withReadSideMask<T extends MaskableMessage>(
  messages: readonly T[],
  maskers: readonly ReadSideMasker[] | undefined,
): T[] {
  if (maskers === undefined || maskers.length === 0) return [...messages];
  return messages.map((message) => {
    const masked = applyReadSideMaskers(message.content, maskers);
    if (masked === message.content) return message;
    // 只换 content：其余字段（tool_calls / tool_call_id / reasoning_content）原样保留，
    // 结构必须与原文一致，否则 provider 会因配对断裂拒绝请求。
    return { ...message, content: masked } as T;
  });
}
