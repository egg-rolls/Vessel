/**
 * inbox `read` 工具结果的消费消息解析（P1-A，症状②「agent→main 消息用户看不到」的承接）。
 *
 * 为什么需要：agent 投递的消息被 main 用 `inbox read` 消费后，从 inbox 消失、又**不会**
 * 成为 run input（read 走工具结果进上下文，不发 `user.message` / `run.started` 回显）——
 * 时间线上没有任何 item 承接它，用户永远看不到这条消息（audit §3 主因）。
 * `tool.call.completed(inbox)` 的结果里带着被取走消息的全文（`messages[].text/source`），
 * 这里把它解析出来，装配面据此在工具卡旁投影出可见的消息 item（见
 * `transcript-items.ts#projectInboxReads`）。
 *
 * 只做解析、不做渲染：身份只有 read 结果给的那一层（`source` = human / agent / system，
 * 没有发送者名 —— 服务端工具面不改，红线）。解析不出（旧数据 / 截断的 live 预览 /
 * 非 read 动作）⇒ 空数组，宁可少一张卡，不吞不造。
 */

/** read 结果里的一条被消费消息（与服务端 `messages[]` 同形）。 */
export interface InboxReadMessage {
  /** inbox 条目的稳定 id（与 `agents.inbox` 的 `message_id` 同一个字符串）。 */
  id: string;
  /** 来源类别：human / agent / system（服务端 `messageSource` 的口径）。 */
  source: string;
  /** 消息全文。 */
  text: string;
  /** 消息入队时刻（Unix ms）；缺省不显示。 */
  ts?: number;
}

/**
 * 从 inbox 工具项解析「这次 read 取走了哪些消息」。
 *
 * 判据（层层设防，任何一层不成形都返回空）：
 * - 工具名必须是 `inbox`；
 * - args 在场时 action 必须是 `read`（或 0.55 前的 legacy `claim`，同形结果）——
 *   list / delete / insert 不消费消息，不产承接卡；args 缺席（历史孤立结果）时
 *   退回结果形状判定；
 * - 结果必须带 `read` 计数与 `messages` 数组（list 的 `messages[]` 只有 preview 没有
 *   text，形状判定天然区分）；每条消息必须有字符串 `id` 与 `text`。
 *
 * output 可能是字符串（落盘 / 事件载荷）或已解析对象；live 侧 8KiB 预览截断的 JSON
 * 解析失败 ⇒ 空数组（历史落盘后拿到全文，同一 key 的卡自然补上）。
 */
export function inboxReadMessagesOf(
  name: string,
  args: unknown,
  output: unknown,
): InboxReadMessage[] {
  if (name !== 'inbox') return [];
  if (args !== null && typeof args === 'object') {
    const action = (args as Record<string, unknown>).action;
    if (typeof action === 'string' && action !== 'read' && action !== 'claim') return [];
  }
  let parsed: unknown = output;
  if (typeof output === 'string') {
    try {
      parsed = JSON.parse(output);
    } catch {
      return [];
    }
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const record = parsed as Record<string, unknown>;
  if (typeof record.read !== 'number' || !Array.isArray(record.messages)) return [];
  const messages: InboxReadMessage[] = [];
  for (const entry of record.messages) {
    if (entry === null || typeof entry !== 'object') continue;
    const message = entry as Record<string, unknown>;
    if (typeof message.id !== 'string' || typeof message.text !== 'string') continue;
    messages.push({
      id: message.id,
      text: message.text,
      source: typeof message.source === 'string' ? message.source : 'system',
      ...(typeof message.ts === 'number' ? { ts: message.ts } : {}),
    });
  }
  return messages;
}
