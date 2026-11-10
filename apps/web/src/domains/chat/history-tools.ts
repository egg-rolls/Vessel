/**
 * 历史消息里的工具调用重建（纯函数，无 React / DOM）。
 *
 * sessions.get 只给 messages：assistant 的 tool_calls[] 与随后的 role:'tool'
 * 消息靠 tool_call_id 配对。运行态来自 tool.call.* 事件（有 status / duration），
 * 历史里没有状态，因此统一给 'neutral' —— 渲染层用同一张 StreamCard，只是颜色
 * 中性、不显示 duration。
 *
 * 退化规则（不变量：**任何一条调用都不能渲染成空白**）：
 * - 有调用、无结果（被截断 / 历史不完整）→ output: undefined + paired: false，
 *   渲染层据此显示 chat.tool.outputMissing；
 * - 有结果、无对应调用（历史从中间开始）→ 仍然产出一条 item，name 取消息自带的
 *   name，paired: false；
 * - arguments 是 JSON 字符串时原样保留（渲染层用 parseToolArgs 解析，失败再按
 *   原文展示）—— 这里不做解析，保持纯函数无歧义。
 */

import type { Message } from '../../gateway/types';

export interface HistoryToolItem {
  /** 稳定 key：配对到调用时用 call id，孤立结果用消息下标，供 React 复用不重挂。 */
  key: string;
  callId?: string;
  name: string;
  /** 原始 arguments（可能是 JSON 字符串，也可能是对象）。 */
  args?: unknown;
  /** 工具输出；undefined = 结果缺失（不是空字符串）。 */
  output?: string;
  /** 历史不带成功/失败，统一中性。 */
  status: 'neutral';
  /** 是否找到了与调用配对的结果。 */
  paired: boolean;
}

/**
 * messages → 历史工具卡条目（按出现顺序）。
 *
 * 只做配对，不做可见性判定（可见性仍由 historyToolVisible / verbosity 决定）。
 */
export function buildHistoryToolItems(messages: readonly Message[]): HistoryToolItem[] {
  const items: HistoryToolItem[] = [];
  const byCallId = new Map<string, HistoryToolItem>();

  messages.forEach((message, index) => {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        const callId = typeof call.id === 'string' && call.id.length > 0 ? call.id : undefined;
        const name =
          typeof call.function?.name === 'string' && call.function.name.length > 0
            ? call.function.name
            : 'tool';
        const item: HistoryToolItem = {
          key: `history-tool-${callId ?? index}`,
          ...(callId !== undefined ? { callId } : {}),
          name,
          ...(call.function?.arguments !== undefined ? { args: call.function.arguments } : {}),
          status: 'neutral',
          paired: false,
        };
        items.push(item);
        if (callId !== undefined) byCallId.set(callId, item);
      }
      return;
    }
    if (message.role !== 'tool') return;

    const callId =
      typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0
        ? message.tool_call_id
        : undefined;
    const output = typeof message.content === 'string' ? message.content : '';
    const matched = callId === undefined ? undefined : byCallId.get(callId);
    if (matched !== undefined) {
      matched.output = output;
      matched.paired = true;
      // 调用没带 name 时用结果消息上的 name 补全（旧数据只有 tool 消息才带 name）。
      if (matched.name === 'tool' && typeof message.name === 'string' && message.name.length > 0) {
        matched.name = message.name;
      }
      return;
    }
    // 孤立结果（历史从中间开始 / 调用被截断）：保留输出，别丢。
    items.push({
      key: `history-tool-${index}`,
      ...(callId !== undefined ? { callId } : {}),
      name: typeof message.name === 'string' && message.name.length > 0 ? message.name : 'tool',
      output,
      status: 'neutral',
      paired: false,
    });
  });

  return items;
}
