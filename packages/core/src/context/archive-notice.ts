/**
 * `archive_notice` 的归档卡（0.53 U3，ADR-104 §2.3(c) / 附录 B 的 U3）。
 *
 * 一句话口径：**这个模式不改写一个字节的正文**，省字全部来自压缩既有的「最旧优先丢弃」；
 * 它的全部产出就是 run 起点追加的这张卡 —— 把「有一批工具结果不在最近的保留窗口里了」
 * 从「无声消失」变成「一条带 id、带字节数、带怎么读回来的卡」。
 *
 * 三条硬口径（都写成了断言，见 `scripts/check-archive-notice.ts`）：
 *
 * 1. **卡里没有正文**。只有元数据：call id、工具名、字节数、读回方式。卡本身净增几十
 *    token（上限 200），一个字节都不省 —— 想让卡「顺便当摘要」就是把卡变成第二条投影路径。
 * 2. **两个数字口径分两层**（`docs/specs/projection-card-spec.md` §3.0）：
 *    首行（折叠态）只说**本轮**归档几条，展开后的明细才给**会话内累计**与逐条字节。
 *    首行塞累计数会让人以为「又发生了一次」（用户原话）。
 * 3. **读回提示必须能兑现**。卡上写的是 `sessions.events{session_id, tool_call_id}`，
 *    所以只有读回能力可用时才会发卡（运行期判据见 `archiveReadbackAvailability`）——
 *    读不回来的东西不许写成「可以读回来」。
 *
 * ## 为什么 scope 复用 `trim` 而不是新造一个词
 *
 * 归档卡与 trim 卡是**同一类**卡（ADR-104 §2.3(c)：「走既有 `appendNotice` 路径 ⇒ 与 trim 卡
 * 同一类」），讲的是同一件事的两个分支：同一套「保留最近 N 条」预算下，`placeholder`
 * 把窗口外的正文换成占位（trim 卡），`archive_notice` 不动正文、只登记归档（归档卡）。
 *
 * 词表这条是硬约束，不是偷懒：`scope` 的第一个词必须已在
 * `apps/web/src/domains/chat/env-notice.ts` 的 `ENV_NOTICE_SCOPES` 里，否则
 * `scripts/check-env-scope-parity.ts` 直接红（未登记的 scope 会让卡头静默退化成「上下文」）。
 * 新造一个 `archive` 词要同时改 `apps/web` 的词表与两个 locale 的标签 —— 本轮 `apps/web/**`
 * 是禁改区，而 `trim` 的标签本来就是「已裁剪上下文」，正是这张卡在讲的事。
 * 代价写清楚：两张卡会归到同一个卡头标签下，但**它们永远不会同时出现**（一个会话只有一个
 * 模式），所以不存在把两件事搅在一起的风险。
 *
 * 本模块是纯函数模块（无时钟、无随机、无 IO）：同样的输入产出逐字节相同的卡与签名。
 *
 * @module @vessel-agent/core/context
 */

import type { Message } from '../types/provider.js';
import { TRIM_ENV_DETAIL_MARK, TRIM_ENV_SCOPE } from './cleared-tool-result.js';

/** 文案语言：模型侧默认 en，UI 侧按用户语言渲染同一份文案。 */
export type ArchiveNoticeLocale = 'en' | 'zh-CN';

/** 卡里最多点名几个 call id（其余折成 `+N`）：与 trim 卡同一口径，别让卡本身撑大上下文。 */
const ARCHIVE_NOTICE_MAX_IDS = 8;

/** 读回通道的线上形态（本版本唯一读回路径，ADR-104 §2.3(f)）。 */
export const ARCHIVE_READBACK_RPC = 'sessions.events';

/**
 * 一条被归档的工具结果（逐条元数据）。
 *
 * `bytes` 是**原始正文的 UTF-8 字节数**：码点与字节是两个数（card-spec §6 第 4 条），
 * 卡上出现数字时必须带单位，别把「60 码点的摘要」与「60 字节」混着说。
 */
export interface ArchiveEntry {
  /** 被归档结果的 `tool_call_id`。 */
  readonly tool_call_id: string;
  /** 工具名（拿不到时用 `?`，不许编造）。 */
  readonly tool_name: string;
  /** 原始正文的 UTF-8 字节数（不是码点数）。 */
  readonly bytes: number;
}

/** `renderArchiveNotice` 的输入。 */
export interface ArchiveNoticeInput {
  /**
   * **本轮新增**归档的 `tool_call_id`（按丢弃顺序）。
   *
   * 它的长度就是卡面首行那个数（「本轮归档 N 条」）—— 与 trim 卡同一条规矩：不另开一个
   * `added` 字段，两个数分别传入就可能不一致（累计 231 + 增量 6 + 只列了 5 个 id）。
   * 必须非空：空集没有卡（调用方在 `fresh.length === 0` 时直接返回）。
   */
  readonly ids: readonly string[];
  /** 逐条工具名，与 `ids` 同序（缺项 / 空串渲染成 `?`）。 */
  readonly tools: readonly string[];
  /** 逐条 UTF-8 字节数，与 `ids` 同序（缺项渲染成 0）。 */
  readonly bytes: readonly number[];
  /** 会话 id（读回 RPC 的参数）。 */
  readonly sessionId: string;
  /**
   * 会话内**累计**归档条数（展开态口径，只出现在明细行）。
   *
   * 缺省 = `ids.length`（第一次归档时两个数本来就相等）。
   */
  readonly archived?: number;
}

/** 归档卡的去重键三元组：累计 / 本轮新增 / 本轮新增的 call id。 */
export interface ArchiveNoticeSignatureInput {
  archived: number;
  added: number;
  tool_call_ids: readonly string[];
}

/**
 * 归档卡的**去重键**（同一载荷不重复发卡）。
 *
 * 与 `trimNoticeSignature` 同一形状、同一理由：用 JSON 编码而不是自定义分隔符拼接
 * （id 里出现分隔符时 `['a|b']` 与 `['a','b']` 会拼出同一个键 ⇒ 不同载荷被误判成重复）。
 */
export function archiveNoticeSignature(input: ArchiveNoticeSignatureInput): string {
  return JSON.stringify([input.archived, input.added, [...input.tool_call_ids]]);
}

/** 一段文本的 UTF-8 字节数（不引 `Buffer`：core 也会进 Web 侧产物）。 */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    if (point < 0x80) bytes += 1;
    else if (point < 0x800) bytes += 2;
    else if (point < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** 字节数的人类可读形态（`<1024` 用 B，否则 1 位小数的 KB）。 */
function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? Math.trunc(bytes) : 0;
  return value < 1024 ? String(value) + ' B' : (value / 1024).toFixed(1) + ' KB';
}

/** 在已构建消息里找拥有该 tool_call 的 assistant，返回工具名。 */
function toolNameOfCall(messages: readonly Message[], toolCallId: string): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    for (const call of message.tool_calls ?? []) {
      if (call.id === toolCallId) return call.function?.name;
    }
  }
  return undefined;
}

/**
 * 从落盘历史里量出「这批 id 各自的工具名与原始字节数」（纯函数，只读消息）。
 *
 * 为什么在 core 侧量而不是让调用方拼：字节数必须是**落盘正文**的 UTF-8 长度（卡上承诺的
 * 「原文多少字节」），而正文刚好是 `archive_notice` 一个字节都不改的那份；由调用方自己算
 * 容易算成占位文本或估算 token。工具名优先取 owning assistant 的 `tool_calls`（与
 * `formatClearedToolResult` 同一来源），拿不到再退回 tool 消息自带的 `name`。
 */
export function measureArchivedToolResults(
  messages: readonly Message[],
  ids: readonly string[],
): ArchiveEntry[] {
  const byId = new Map<string, Message>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    if (typeof message.tool_call_id !== 'string') continue;
    // 同 id 只可能有一条（tool_call_id 是配对键）；后写的那条代表当前正文。
    byId.set(message.tool_call_id, message);
  }
  return ids.map((id) => {
    const message = byId.get(id);
    const content: unknown = message?.content;
    return {
      tool_call_id: id,
      tool_name: toolNameOfCall(messages, id) ?? message?.name ?? '?',
      bytes: typeof content === 'string' ? utf8Bytes(content) : 0,
    };
  });
}

/** id 列表缩略（超过上限折成 `+N`；与 trim 卡同一个显示口径）。 */
function listIds(ids: readonly string[]): string {
  const shown = ids.slice(0, ARCHIVE_NOTICE_MAX_IDS);
  const rest = ids.length - shown.length;
  return rest > 0 ? shown.join(', ') + ', +' + String(rest) : shown.join(', ');
}

/** id → 工具名 / 字节数（按位置对齐；缺项各给一个不会撒谎的兜底）。 */
function pairEntries(input: ArchiveNoticeInput): { name: string; bytes: number }[] {
  const entries: { name: string; bytes: number }[] = [];
  for (let index = 0; index < input.ids.length; index += 1) {
    entries.push({ name: (input.tools[index] ?? '') || '?', bytes: input.bytes[index] ?? 0 });
  }
  return entries;
}

/**
 * 归档卡的正文（`vessel:notice` 消息体）。
 *
 * 分层口径见文件头：**首行只说本轮**，明细行给累计 + 逐条字节 + id 缩略 + 读回方式。
 * 不含任何工具输出正文，也不含路径以外的机器信息；逐行以 `\n` 分隔，首行是
 * `scope: summary`、明细行以 `  · ` 开头 —— `apps/web` 的 `envNoticeCard()` 就按这个
 * 线格式解析（首行进折叠摘要、其余行展开），与 trim 卡共用同一套渲染，不需要前端改动。
 */
export function renderArchiveNotice(
  input: ArchiveNoticeInput,
  locale: ArchiveNoticeLocale = 'en',
): string {
  const added = input.ids.length;
  // 空集没有卡：调用方在「本轮没有新增归档」时负责不发（这里只是兜底，不伪造数字）。
  if (added === 0) return '';
  const archived = input.archived ?? added;
  const entries = pairEntries(input);
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const perEntry = entries
    .slice(0, ARCHIVE_NOTICE_MAX_IDS)
    .map((entry) => entry.name + ' ' + formatBytes(entry.bytes))
    .join(' / ');
  const ids = listIds(input.ids);
  if (locale === 'zh-CN') {
    return [
      TRIM_ENV_SCOPE +
        '：本轮归档 ' +
        String(added) +
        ' 条旧工具结果（正文未改写，按 call id 可读回）',
      TRIM_ENV_DETAIL_MARK + '会话内已累计 ' + String(archived) + ' 条被归档',
      TRIM_ENV_DETAIL_MARK + '本轮合计 ' + formatBytes(total) + '：' + perEntry,
      TRIM_ENV_DETAIL_MARK + '归档的 call id：' + ids,
      TRIM_ENV_DETAIL_MARK +
        '读回：' +
        ARCHIVE_READBACK_RPC +
        '{session_id, tool_call_id} 取 data.result',
    ].join('\n');
  }
  return [
    TRIM_ENV_SCOPE +
      ': ' +
      String(added) +
      ' older tool result(s) archived this run (bodies untouched, read back by call id)',
    TRIM_ENV_DETAIL_MARK + String(archived) + ' archived in this session',
    TRIM_ENV_DETAIL_MARK + formatBytes(total) + ' total this run: ' + perEntry,
    TRIM_ENV_DETAIL_MARK + 'archived call ids: ' + ids,
    TRIM_ENV_DETAIL_MARK +
      'read back: ' +
      ARCHIVE_READBACK_RPC +
      '{session_id, tool_call_id} -> data.result',
  ].join('\n');
}

/**
 * 读回能力判据要的最小端口形状（`SessionEventLogPort` 的子集）。
 *
 * 为什么不直接吃 `SessionEventLogPort`：本模块是纯函数模块，只描述「读回需要什么」，
 * 不 import runtime 类型；调用方（`execution-unit`）传进来的就是它的 event log 端口。
 */
export interface ArchiveReadbackLogPort {
  /** 读 `seq > sinceSeq` 的记录（`sessions.events` 的同一份磁盘事实）。 */
  read(sessionId: string, opts?: { sinceSeq?: number; limit?: number }): Promise<unknown[]>;
  /** 日志尾最新 `seq`：**`sessions.events` 的端口契约要求它**（见下）。 */
  lastSeq?(sessionId: string): Promise<number | undefined>;
  /** 派生水位（`sessions.get.event_cursor` 用；读回本身不需要）。 */
  cursor?(sessionId: string): Promise<unknown>;
}

/** 读回能力判据的结果（`reason` 只在不可用时非 null）。 */
export interface ArchiveReadbackAvailability {
  /** 卡上那条「按 id 读回」的指引现在能不能兑现。 */
  readonly available: boolean;
  /** 不可用的原因（写进 `steps` 与日志；**不**新造审计码）。 */
  readonly reason: 'readback_unavailable' | null;
}

/**
 * 运行期「读回能力」判据（同步、纯函数、只看端口形状）。
 *
 * 判据只认一件事：**本会话的事件日志能不能被 `sessions.events` 读回来**。那个 RPC 的端口
 * 契约（`packages/serve/src/gateway/methods/sessions.ts` 的 `SessionEventsPort`）要求
 * `read` **和** `lastSeq` 两个方法 —— 后者是 `latest_seq` 的来源，缺了它「追平了没有」
 * 就答不出来，`sessions.events` 这条路本身就是断的。core 的 `SessionEventLogPort` 把
 * `lastSeq` 声明为可缺省（内存态 / 探针替身可以不实现），所以「端口在」不等于「读得回来」：
 * 磁盘实现（`SessionEventLog`）两个都有，替身常常没有。判据因此取两者的交集，而不是猜。
 *
 * 不可用时调用方**必须** fail-open 到 `passthrough`（ADR-104 §4.4 的运行期降级口径），
 * 不许发一张指向不存在日志的卡。
 */
export function archiveReadbackAvailability(
  eventLog: ArchiveReadbackLogPort | undefined,
): ArchiveReadbackAvailability {
  if (eventLog === undefined) return { available: false, reason: 'readback_unavailable' };
  if (typeof eventLog.read !== 'function') {
    return { available: false, reason: 'readback_unavailable' };
  }
  if (typeof eventLog.lastSeq !== 'function') {
    return { available: false, reason: 'readback_unavailable' };
  }
  return { available: true, reason: null };
}
