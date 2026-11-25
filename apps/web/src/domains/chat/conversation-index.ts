/**
 * 会话索引竖条（minimap）的数据映射：transcript item 流 / 团队消息行 → 索引条目。
 *
 * 纯函数，无 React / DOM（与 transcript-items.ts 同一口径）：
 * - 会话页：一条**可见** item 一个 entry，key = `item.key`（身份命名见
 *   transcript-items.ts 头注释）—— 与消息 DOM 上的 `data-index-entry-key` 同值，
 *   点击跳转 / 视口高亮都靠这一个字符串对上。
 * - 团队页：一条日志一个 entry，key = `message_id`（TeamTranscript 的 React key
 *   就是它，DOM 锚点同值）。
 *
 * 「可见」的判据与渲染层逐条对齐（不另立一套）：
 * - `message` item 的 system / tool 角色在 `TranscriptMessage` 里返回 null；
 * - `runtime-notice` 里被待处理条带覆盖的 `[inbox] N pending` 在 TranscriptWindow
 *   的 renderItem 里返回 null（见 env-notice.ts#isStripCoveredInboxNotice）。
 * 渲染不出节点的 item 不给 dot —— 否则点上去跳到一个空锚点。
 */

import type { Message } from '../../gateway/types';
import { t } from '../../i18n';
import {
  isRuntimeMessageVisible,
  type RuntimeVisibility,
  runtimeMessageKind,
} from '../../state/runtime-visibility';
import { isStripCoveredInboxNotice } from './env-notice';
import type { TranscriptItem } from './transcript-items';

export interface ConversationIndexEntry {
  /** 与消息 DOM 的 `data-index-entry-key` 同值：item.key / message_id。 */
  key: string;
  /** aria-label / title：带序号的跳转提示（dot 本身无文字）。 */
  label: string;
}

/** 这条 item 在时间线上有没有渲染节点（判据见文件头注释）。 */
function rendersItem(item: TranscriptItem): boolean {
  if (item.kind === 'message') {
    return item.message.role !== 'system' && item.message.role !== 'tool';
  }
  if (item.kind === 'runtime-notice' && item.env !== undefined) {
    return !isStripCoveredInboxNotice(item.env);
  }
  return true;
}

/** 会话页 item 流 → 索引条目（保持时间线顺序，序号从 1 起）。 */
export function indexEntriesOfItems(items: readonly TranscriptItem[]): ConversationIndexEntry[] {
  const entries: ConversationIndexEntry[] = [];
  for (const item of items) {
    if (!rendersItem(item)) continue;
    entries.push({ key: item.key, label: t('chat.index.jump', { index: entries.length + 1 }) });
  }
  return entries;
}

/** 团队页消息行 → 索引条目（只取身份字段，不依赖 TeamMessageView 的发送态扩展）。 */
export function indexEntriesOfTeamRows(
  rows: readonly { message_id: string }[],
): ConversationIndexEntry[] {
  return rows.map((row, index) => ({
    key: row.message_id,
    label: t('chat.index.jump', { index: index + 1 }),
  }));
}

/**
 * 成员 body 页（只读会话消息）→ 索引条目。
 *
 * 只读消息没有稳定 id：key 用局部序号 `message-<n>`，编号规则与
 * `BodyTranscripts.tsx#SessionTranscript` 逐字对齐 —— 先按 runtime 可见性过滤，
 * 再对每条可见消息自增（system / 环境卡 / 普通消息都占一个号）。那边改过滤 /
 * 编号，这里必须同步，否则 dot 与锚点错位。
 */
export function indexEntriesOfMessages(
  messages: readonly Message[],
  visibility: RuntimeVisibility,
): ConversationIndexEntry[] {
  const entries: ConversationIndexEntry[] = [];
  let keySeq = 0;
  for (const message of messages) {
    const kind = runtimeMessageKind(message);
    if (kind !== undefined && !isRuntimeMessageVisible(visibility, kind)) continue;
    entries.push({
      key: `message-${keySeq++}`,
      label: t('chat.index.jump', { index: entries.length + 1 }),
    });
  }
  return entries;
}
