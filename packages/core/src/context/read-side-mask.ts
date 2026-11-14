/**
 * 读侧脱敏端口（0.52 pii-guard）。
 * @module @vessel-agent/core/context
 *
 * 位置纪律：**脱敏只许发生在「请求构造层」和「展示投影层」，绝不许改写落盘正文。**
 *
 * 0.52 之前 guardrail-pii 在 Output / ToolResult 阶段返回 `replacement`，而这两个阶段的
 * replacement 会被写进会话存储（append-only 的 transcript 是不可逆数据），于是 13 位
 * 毫秒时间戳被当成手机号打码后直接污染了历史。现在：
 *
 * - guardrail 只做「检测 + 报告」（不返回 replacement，落盘原文一个字不改）；
 * - 需要给模型 / 给用户看的文本，在请求构造与展示投影里过一次这里注册的 masker。
 *
 * 这里只放「纯函数 + 端口类型」，不认识任何具体规则，规则由插件注册。
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

