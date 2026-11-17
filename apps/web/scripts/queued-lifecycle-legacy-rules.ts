/**
 * 改前（main `7078b446`）两处渲染的**真实规则**，只为 A/B 计数而复制在这里。
 *
 * 为什么复制而不是改成调用生产代码：改前那两处没有「判据」可调 —— 规则就是
 * 「`TranscriptWindow` 把每一条 pending 都画出来」+「`PendingStrip` 把每一条服务端条目都
 * 画出来」，谁也不认识谁。本文件把这两句原样写成两个函数，驱动就能在**同一份状态快照**
 * 上算出改前的「屏上出现次数」。
 *
 * 这是**验证脚本**的脚手架，不进产品代码、不进任何 gate。
 *
 * @module scripts/queued-lifecycle-legacy-rules
 */

import type { PendingSend } from '../src/domains/chat/pending-sends';

/** 改前：`TranscriptWindow` 里 `pendingSends.map(...)` —— 每一条都画。 */
export function legacyInConversation(_pending: PendingSend): boolean {
  return true;
}

/** 改前：`PendingStrip` 里 `entries.map(toEntry)` —— 每一条服务端条目都画，且不认识 pending。 */
export function legacyStripEntryIds(entries: readonly { message_id: string }[]): string[] {
  return entries.map((entry) => entry.message_id);
}

/** 改前的「屏上出现次数」：会话 = 每条 pending（含服务端回显），条带 = 每条服务端条目。 */
export function legacyCounts(input: {
  pendings: readonly PendingSend[];
  entries: readonly { message_id: string }[];
  echoed: readonly string[];
}): { key: string; conversation: number; strip: number; total: number }[] {
  const byKey = new Map<string, { conversation: number; strip: number }>();
  const bump = (key: string, where: 'conversation' | 'strip'): void => {
    const cell = byKey.get(key) ?? { conversation: 0, strip: 0 };
    cell[where] += 1;
    byKey.set(key, cell);
  };
  for (const pending of input.pendings) {
    if (!legacyInConversation(pending)) continue;
    bump(
      pending.messageId !== undefined ? `msg:${pending.messageId}` : `pending:${pending.id}`,
      'conversation',
    );
  }
  for (const id of legacyStripEntryIds(input.entries)) bump(`msg:${id}`, 'strip');
  // 回显那一份在改前也在会话里（服务端气泡），单独记一笔：改前它同样是「第二条」。
  for (const id of input.echoed) bump(`msg:${id}`, 'conversation');
  return [...byKey.entries()].map(([key, cell]) => ({
    key,
    conversation: cell.conversation,
    strip: cell.strip,
    total: cell.conversation + cell.strip,
  }));
}
