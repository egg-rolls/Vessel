/**
 * 会话索引竖条（minimap）的数据映射：transcript item 流 / 团队消息行 → 索引条目。
 *
 * 形态裁定（用户裁定·参考豆包）：**只给「人打的字」一个 dot**——AI 回复 / 工具 /
 * 环境上下文（vessel:*）/ 来源行 / 系统消息 / A2A 投递卡 / rotate 交接卡全都不进索引。
 * 点击跳到 user 消息 DOM，AI 回复自然跟随其后，用户看到完整问答对。
 *
 * 纯函数，无 React / DOM（与 transcript-items.ts 同一口径）：
 * - 会话页：一条 user 消息 item 一个 entry，key = `item.key`（身份命名见
 *   transcript-items.ts 头注释）—— 与消息 DOM 上的 `data-index-entry-key` 同值，
 *   点击跳转 / 视口高亮都靠这一个字符串对上。
 * - 团队页：一条 human 发言一个 entry，key = `message_id`（TeamTranscript 的 React key
 *   就是它，DOM 锚点同值）。
 * - 成员 body 页：一条 user 消息一个 entry，key = 局部序号（编号规则见
 *   indexEntriesOfMessages 注释）。
 *
 * 「人打的字」的判据只有一份：`isIndexUserMessage` / `isIndexUserRow`。锚点侧
 * （Transcript.tsx / TeamTranscript.tsx / BodyTranscripts.tsx）import 同一组函数决定
 * 要不要挂 `data-index-entry-key` —— 索引与锚点永远同一套过滤，不会错位。
 * user 消息的判据与 Transcript.tsx#previousUserMessage（edit / retry 的锚点）同口径：
 * role=user，且不是 runtime 上下文（`vessel:*`），也不是卡输入（`agent:*` / `rotate:handoff`）。
 *
 * 上界：只保留最近 MAX_INDEX_ENTRIES 条（slice(-MAX)），长会话不爆——dot 数有硬上限，
 * 竖条不会随历史无限变密。更早的历史仍可滚动阅读，只是不在索引里（无 dot、无高亮）。
 */

import type { Message, TeamMessage } from '../../gateway/types';
import { t } from '../../i18n';
import {
  isRuntimeMessageVisible,
  type RuntimeVisibility,
  runtimeMessageKind,
} from '../../state/runtime-visibility';
import { isCardInputMessage, type TranscriptItem } from './transcript-items';

/** 索引条目上界：最近 50 条 user 消息，长会话不爆（dot 数 ≤ 50）。 */
export const MAX_INDEX_ENTRIES = 50;

export interface ConversationIndexEntry {
  /** 与消息 DOM 的 `data-index-entry-key` 同值：item.key / message_id / 局部序号。 */
  key: string;
  /** aria-label / title：带序号的跳转提示（dot 本身无文字）。 */
  label: string;
}

/**
 * 这条消息是不是「人打的字」（索引与锚点共用的唯一判据）：
 * role=user，且不是 runtime 上下文（vessel:* → 环境卡 / 来源行），也不是卡输入
 * （agent:<alias> → A2A 卡；rotate:handoff → 交接卡）。与 previousUserMessage 同口径。
 */
export function isIndexUserMessage(message: Message): boolean {
  if (message.role !== 'user') return false;
  if (runtimeMessageKind(message) !== undefined) return false;
  return !isCardInputMessage(message);
}

/** 团队日志行是不是 human 发言（系统灰条不算；agent 的 post / mention / reply 不算）。 */
export function isIndexUserRow(row: Pick<TeamMessage, 'from' | 'kind'>): boolean {
  return row.from === 'human' && row.kind !== 'system';
}

/** key 列表 → 索引条目：取最近 MAX_INDEX_ENTRIES 条，序号在窗口内从 1 起。 */
function entriesFromKeys(keys: readonly string[]): ConversationIndexEntry[] {
  return keys.slice(-MAX_INDEX_ENTRIES).map((key, index) => ({
    key,
    label: t('chat.index.jump', { index: index + 1 }),
  }));
}

/** 会话页 item 流 → 索引条目（只 user 消息，保持时间线顺序，取最近 N 条）。 */
export function indexEntriesOfItems(items: readonly TranscriptItem[]): ConversationIndexEntry[] {
  const keys: string[] = [];
  for (const item of items) {
    if (item.kind !== 'message') continue;
    if (!isIndexUserMessage(item.message)) continue;
    keys.push(item.key);
  }
  return entriesFromKeys(keys);
}

/** 团队页消息行 → 索引条目（只 human 发言，取最近 N 条）。 */
export function indexEntriesOfTeamRows(
  rows: readonly Pick<TeamMessage, 'message_id' | 'from' | 'kind'>[],
): ConversationIndexEntry[] {
  const keys: string[] = [];
  for (const row of rows) {
    if (!isIndexUserRow(row)) continue;
    keys.push(row.message_id);
  }
  return entriesFromKeys(keys);
}

/**
 * 成员 body 页（只读会话消息）→ 索引条目（只 user 消息，取最近 N 条）。
 *
 * 只读消息没有稳定 id：key 用局部序号 `message-<n>`，编号规则与
 * `BodyTranscripts.tsx#SessionTranscript` 逐字对齐 —— 先按 runtime 可见性过滤，
 * 再对每条**可见**消息自增（system / 环境卡 / 普通消息都占一个号，不管进不进索引）。
 * 那边改过滤 / 编号，这里必须同步，否则 dot 与锚点错位。
 */
export function indexEntriesOfMessages(
  messages: readonly Message[],
  visibility: RuntimeVisibility,
): ConversationIndexEntry[] {
  const keys: string[] = [];
  let keySeq = 0;
  for (const message of messages) {
    const kind = runtimeMessageKind(message);
    if (kind !== undefined && !isRuntimeMessageVisible(visibility, kind)) continue;
    const key = `message-${keySeq++}`;
    if (isIndexUserMessage(message)) keys.push(key);
  }
  return entriesFromKeys(keys);
}
