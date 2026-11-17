/**
 * 「这条消息此刻该画在哪」的唯一判据（纯函数，无 React / DOM / i18n）。
 *
 * 用户口径（0.56 排队生命周期）：**一条消息同一时刻只能出现在一个地方**。
 *
 * | 状态 | 会话流（时间线） | 待处理条带 |
 * |---|---|---|
 * | `sending`（点了发送、还没拿到 run 应答） | 灰态气泡 | **不出现** |
 * | `queued`（服务端说排队了 / 前面还有一轮） | **不出现**（用户点名要删的就是这一块） | 那一行 |
 * | `sent`（run 真的取用了它，`message_id` 落盘） | 正常用户气泡（服务端回显） | **必须消失** |
 * | `failed`（RPC 错 / 断线 / 排队超时） | 不出现 | 那一行 + 「重试 / 编辑」 |
 *
 * 为什么判据要单独成一个模块：这三处渲染（`TranscriptWindow` 的 pending 分支、
 * `PendingStrip` 的条目与客户端行、以及驱动里的「屏上出现次数」计数）**必须用同一份规则**。
 * 三处各写一遍 `state === 'queued'` 的那种写法，只要有一处漏了，用户看到的就是同一条消息
 * 在两块地方各一份 —— 而这正是这条需求要根除的东西。所以「在哪画」只在这里定义，
 * 别处只许调用。
 *
 * 第二件事是**顶替**（{@link claimsEntry}）：条带的数据源是服务端 inbox（`agents.inbox`），
 * 而客户端还握着一条同一条消息的 pending（它知道失败原因、能重试）。两边都画就是两份。
 * 于是规定：「客户端 pending 认领了哪条服务端条目，那条服务端条目就不再单独渲染」。
 * 认领优先用 `message_id`（`agent.message.queued` 事件里带回来，见 `usePendingSends`），
 * 没有时才退到「同会话 + human 源 + 摘要同口径」。
 *
 * @module
 */

import type { PendingSend, PendingSendState } from './pending-sends';
import { HUMAN_SOURCE } from './pending-strip';

/**
 * 服务端 inbox 摘要的口径（`packages/agent/src/inbox.ts` 的 `INBOX_SUMMARY_MAX`）。
 *
 * 客户端重算同一份摘要，是为了在**没有 `message_id`** 时也能认出「这条服务端条目就是我
 * 刚发的那句」。两个常数必须一致：改一边就等于悄悄关掉这条退路。
 */
export const INBOX_SUMMARY_MAX = 160;

/** 与 `inbox.ts#summaryOf` 逐字对齐：trim → 空白折叠 → 前 160 字（截断加 `…`）。 */
export function inboxSummaryOf(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  return collapsed.length > INBOX_SUMMARY_MAX
    ? `${collapsed.slice(0, INBOX_SUMMARY_MAX)}…`
    : collapsed;
}

/** 条带认得的条目形状（`agents.inbox` 子集；`pending-strip.ts` 的纯函数吃同一形状）。 */
export interface StripEntryLike {
  message_id: string;
  from: string;
  summary: string;
  session_id?: string;
}

/** 「消息进队列」事件（`emitMessageQueued`）：唯一能拿到服务端 `message_id` 的地方。 */
const QUEUED_EVENT_TYPE = 'agent.message.queued';

/**
 * 从 `agent.message.queued` 里取出「这条 pending 的服务端身份」。
 *
 * 只认三个字段（`message_id` / `delivery` / `from`），`session_id` 从事件顶层或 `data` 取
 * （与 `usePendingSends.ts#echoOf` 同一条规矩）。其余一概不读：这个事件的载荷里还有
 * `visibility` / `name` 等与「哪句话」无关的东西。
 *
 * 参数是**结构最小集**（不是 `StoredEvent`）：运行期吃 `EventStore` 的条目，驱动也可以拿
 * 实时流里的一条事件直接喂进来 —— 两处走同一份映射，才知道真机上认领到底能不能成立。
 */
export function queuedMessageOf(entry: {
  event: { type: string; data?: Record<string, unknown> };
  sessionId?: string;
}): { messageId: string; sessionId?: string; from?: string; delivery?: string } | undefined {
  const event = entry.event;
  if (event.type !== QUEUED_EVENT_TYPE) return undefined;
  const data = event.data ?? {};
  const messageId = typeof data.message_id === 'string' ? data.message_id : undefined;
  if (messageId === undefined || messageId === '') return undefined;
  const sessionId =
    entry.sessionId ??
    (typeof data.session_id === 'string' ? data.session_id : undefined) ??
    undefined;
  return {
    messageId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(typeof data.from === 'string' ? { from: data.from } : {}),
    ...(typeof data.delivery === 'string' ? { delivery: data.delivery } : {}),
  };
}

/**
 * 会话流里画不画这条 pending：**只有 `sending`**。
 *
 * `queued` / `failed` 都只在条带上 —— 这是用户的原话（「入队消息的展示只显示从 inbox 到发的
 * 这一部分」），也是「一条消息一个地方」的那条线。`sending` 保留在会话里是因为那几十毫秒里
 * 服务端还什么都不知道：不画它，用户点完发送就会看到「输入框清空了、哪儿都没有」。
 */
export function inConversationStream(pending: Pick<PendingSend, 'state'>): boolean {
  return pending.state === 'sending';
}

/**
 * 条带上画不画这条**客户端** pending：`queued` / `deferred` / `failed`。
 *
 * `sending` 不画（它在会话流里，画两处就是重复）。`queued` 虽然服务端条目也在条带上，
 * 但那条会被 {@link claimsEntry} 顶替 —— 所以「条带上这一条到底由谁画」始终只有一方。
 *
 * `deferred`（0.57：服务端收下了、这一轮没起跑、没有 run id）**只能**在条带上：会话流
 * 只画 `sending`，而它已经过了那一档；它的行通常也认领着服务端 inbox 里那条
 * （`message_id` 由 `runs.start` 的应答或 `agent.message.queued` 带来）。
 */
export function inPendingStrip(pending: Pick<PendingSend, 'state'>): boolean {
  return pending.state === 'queued' || pending.state === 'deferred' || pending.state === 'failed';
}

/** 摘要与正文是否对得上（服务端摘要可能被截断成 `…`）。 */
function summaryMatches(summary: string, text: string): boolean {
  const mine = inboxSummaryOf(text);
  if (summary === mine) return true;
  // 截断过的摘要：去掉尾巴上的省略号后必须是正文摘要的前缀（反过来不成立 —— 短的那条
  // 不会被截断，所以只有「服务端更长」这一种情况允许前缀匹配）。
  if (summary.endsWith('…')) return mine.startsWith(summary.slice(0, -1));
  return false;
}

/**
 * 这条客户端 pending 是不是「那条服务端条目」的同一句话。
 *
 * 两种认领：
 * 1. **精确**：`messageId` 相等（`agent.message.queued` 事件把服务端 id 带回来了）。
 *    这是首选路径，与正文是否被改写无关。
 * 2. **退路**：没有 id 时按 `human` 源 + 同会话 + 摘要同口径认领。它只在「事件流断了 /
 *    旧 gateway 不带 message_id」时兜底；认错的最坏后果是条带上少一行（那一行由客户端
 *    行代替），而不是多一行 —— 失败方向选的是「宁可少画，不可重复」。
 *
 * 真机读数（`apps/web/scripts/queued-lifecycle-live.ts`，0.56）：`agent.message.queued`
 * 落进了会话事件日志，但**实时流没有把它送给直连的客户端** —— 也就是说线上现在**主要走
 * 的是退路**（第 2 条）。所以那一条不是「旧 gateway 才有用」的遗留：它是当下的主力路径，
 * 摘要口径（{@link inboxSummaryOf}）必须与服务端 `summaryOf` 保持一致。
 */
export function claimsEntry(pending: PendingSend, entry: StripEntryLike): boolean {
  if (pending.messageId !== undefined) return pending.messageId === entry.message_id;
  // 没有任何公开写入口会让人发一条「非 human」的消息，所以没 id 时不认别人的条目。
  if (entry.from !== HUMAN_SOURCE) return false;
  if (entry.session_id === undefined) return false;
  if (pending.sessionId !== null && pending.sessionId !== entry.session_id) return false;
  return summaryMatches(entry.summary, pending.text);
}

/**
 * 被客户端 pending 认领掉的条目 id 集合（条带据此跳过那些条目）。
 *
 * 认领按 pending 的创建顺序贪心配对：同一个人连发两条一样的话时，第一条 pending 拿走
 * 最早的那条条目，第二条拿走下一条 —— 不会两条 pending 抢同一条条目（否则就会有一条
 * 消息在条带上出现两次）。
 */
export function claimedEntryIds(
  pendings: readonly PendingSend[],
  entries: readonly StripEntryLike[],
): ReadonlySet<string> {
  const claimed = new Set<string>();
  for (const pending of pendings) {
    for (const entry of entries) {
      if (claimed.has(entry.message_id)) continue;
      if (!claimsEntry(pending, entry)) continue;
      claimed.add(entry.message_id);
      break;
    }
  }
  return claimed;
}

/** 一条消息在各处的出现次数（驱动断言用；渲染侧不读它）。 */
export interface MessageOnScreen {
  /** 身份：`message_id`，退路是正文摘要（`text:` 前缀）。 */
  key: string;
  /** 会话流里出现几次。 */
  conversation: number;
  /** 待处理条带上出现几次。 */
  strip: number;
  /** 两处之和 —— 硬保证要求它恒 `<= 1`。 */
  total: number;
}

/**
 * 数「同一条消息在屏上出现几次」：输入就是两块屏各自真实吃的那两份数据。
 *
 * 规则**只从本模块来**（{@link inConversationStream} / {@link inPendingStrip} /
 * {@link claimedEntryIds}），所以这份计数与真机渲染是同一套判据 —— 不是对着截图再猜一遍。
 */
export function onScreenCounts(input: {
  pendings: readonly PendingSend[];
  entries: readonly StripEntryLike[];
  /** 服务端已经回显成正常用户气泡的那些 `message_id`（会话里各一份）。 */
  echoed?: readonly string[];
  /**
   * 已经发出去、条带那份缓存读数该立刻忘掉的 `message_id`（`pendingSends.sentMessageIds`）。
   *
   * 计数必须和条带用同一条规矩：条目在被取用后还会在缓存里活最多 2 s，那段时间屏上
   * 已经有会话里那条正常气泡了 —— 不滤掉就是两份。
   */
  sentMessageIds?: readonly string[];
}): MessageOnScreen[] {
  const { pendings } = input;
  const sent = new Set(input.sentMessageIds ?? []);
  const entries = input.entries.filter((entry) => !sent.has(entry.message_id));
  const claimed = claimedEntryIds(pendings, entries);
  const byKey = new Map<string, { conversation: number; strip: number }>();
  const bump = (key: string, where: 'conversation' | 'strip'): void => {
    const cell = byKey.get(key) ?? { conversation: 0, strip: 0 };
    cell[where] += 1;
    byKey.set(key, cell);
  };
  for (const pending of pendings) {
    let key = pending.messageId !== undefined ? `msg:${pending.messageId}` : undefined;
    for (const entry of entries) {
      if (!claimed.has(entry.message_id)) continue;
      if (!claimsEntry(pending, entry)) continue;
      key ??= `msg:${entry.message_id}`;
      break;
    }
    key ??= `text:${inboxSummaryOf(pending.text)}`;
    if (inConversationStream(pending)) bump(key, 'conversation');
    if (inPendingStrip(pending)) bump(key, 'strip');
  }
  for (const entry of entries) {
    if (claimed.has(entry.message_id)) continue;
    bump(`msg:${entry.message_id}`, 'strip');
  }
  // 服务端回显（`user.message`）就是会话里那条正常用户气泡：它也必须算出现一次，
  // 否则「sent 之后会话一条、条带 0」这个验收读数就漏了会话那一半。
  for (const id of input.echoed ?? []) bump(`msg:${id}`, 'conversation');
  return [...byKey.entries()].map(([key, cell]) => ({
    key,
    conversation: cell.conversation,
    strip: cell.strip,
    total: cell.conversation + cell.strip,
  }));
}

/** 各状态该在哪：给驱动与注释用的**可执行**说明（不是又一份开关）。 */
export function surfaceOf(pending: Pick<PendingSend, 'state'>): 'conversation' | 'strip' | 'none' {
  if (inConversationStream(pending)) return 'conversation';
  if (inPendingStrip(pending)) return 'strip';
  return 'none';
}

/** 状态名的中文说明（驱动打印用；不进 i18n —— 用户界面上不出现这些词）。 */
export function stateLabel(state: PendingSendState): string {
  switch (state) {
    case 'sending':
      return 'sending（会话灰气泡）';
    case 'queued':
      return 'queued（只在条带）';
    case 'deferred':
      return 'deferred（只在条带：服务端收下了、这一轮没起跑，没有 run id）';
    case 'failed':
      return 'failed（只在条带，带重试/编辑）';
    default:
      return state;
  }
}
