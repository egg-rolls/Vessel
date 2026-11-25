/**
 * 待处理条带：聊天输入区上方的一条摘要，**不进入时间线**。
 *
 * 它回答的是「我这一轮还压着几条输入」，不是队列编辑器。
 *
 * **数据源是服务端持久真相（0.53）**：`agents.inbox{ session_id }`（服务端按归属等值过滤，
 * 前端再用 `ownedBySession` 断一次）。不再读客户端内存里的 `queuedRuns` —— 那是「一份内存、
 * 两处渲染」，刷新 / 切会话就消失；也不再读 agent 维度的全量 inbox —— 那会把「父 agent
 * 发给子成员的消息」串进这条带子。
 *
 * 三条硬口径：
 * - **没有 `session_id` 的条目一律不显示**（老条目 / `wake`·`quiet` 投递）：宁可隐藏，
 *   也不把别人的消息串到这条会话上；
 * - **数据永远来自那次 RPC 读**，事件只当触发器（切会话 / 重连 / 本会话新受理一次发送 /
 *   inbox 变更 live 事件：`inbox read/delete` 消费、新条目入队，见 `useInboxRefresh.ts`），
 *   非空时 2s 兜底轮询（空态零流量）；取数前 250ms debounce，让「发完立刻开跑」的条目
 *   不在条带上闪一下；
 * - 条带只做「还有几条在等」，写入口按来源分档（见下）。
 *
 * **来源分档（0.51，0.53 补了 unhold）**：条带展示**两个来源**，写操作按来源给：
 * - human 源（人打的字）：三颗图标键 —— 「收回来编辑」（peek 正文 → 回填草稿 → recall）、
 *   「取消排队」（recall 真删）与「我已处理」（claim：标 consumed，拿走这次投递），
 *   成功后那条从条带上消失；
 * - agent 源（父 agent 发给本会话的消息）：**一颗**「取消 hold / 留档」（`canUnhold`
 *   判定：非 human 源 + 当前 `held`）。它的 recall 语义是 unhold 留档（消息退回可读
 *   unread，模型仍能 read），所以那颗键说的是「留档」而不是「撤掉」—— 按下去条目**不会
 *   从条带上消失**，只是不再被 hold 住、不再随这次投递（这与 `agents.recall` 自己的分档
 *   同一个判据：`source === 'human'` 才真删）。claim 在它身上仍然没有立场（人不能替这具
 *   body 处理掉别人给它的输入），所以 `agents.claim` 在前端**只对 human 源开放**。
 *
 * 这就是 0.53 那条 `from === 'human'` 等值过滤的去向：它当时兼任两件事 ——「别串台」
 * 和「只收人的字」。「别串台」的真判据是 `session_id`（保留，见 `ownedBySession`），
 * 「只收人的字」这一半按上面的分档放开了。
 *
 * 视觉零改动：卡片仍是 `QueuedNotice`（amber / 满宽 / 单圆点 / actions 槽位 / `onBand`
 * 胶囊），卡头文案是「等待中」（`chat.pending.waiting`）—— 条目没有 run，落盘后也没有
 * 权威队列顺序，所以不编序号。**唯一的视觉改动**是 actions 槽里那颗文字按钮换成了圆形
 * 图标键（形状与输入框的发送键 / 回形针共用 `composerIconControlClass`）：卡宽要跟列一致，
 * 两个中文标签会把卡头那行挤到换行。
 *
 * **身份在卡内、等待中的后面**（用户裁决）：卡头读作「等待中　human: 说的话」。以前身份是
 * 卡外左侧一个 `human` 标签，卡片只是「条带上的一行」；现在身份是卡头的轻量标记
 * （`QueuedNotice` 的 `identity` → StreamCard 的 `meta` 槽，等宽小字 + 弱化色），卡外
 * 那条外层 flex 随之消失（一行就是一张满宽的卡）。看谁给的 vs 说了什么：
 * `identityOf` 只负责「谁」，正文仍是摘要。
 *
 * **没有置顶，也别加回来**：原先的「置顶并打断当前运行」按钮、确认框、
 * `agents.send{message_id, interrupt}` 复用与 footer「优先级仅在本次运行期有效」都已删除
 * —— 置顶没了，那句话就是假承诺；`chat.pending.pin*` 文案同步删除（后端 RPC 不动，只是
 * 前端不再有入口）。
 *
 * 宽度与消息列表同宽同内边距：它渲染在 `.content-stage` 里（与转录区同一个容器），
 * 外层用 `.conversation-scroll` 同款内衬，内层用同款 `--chat-content-w` 列宽 + 居中。
 *
 * **三态展示（用户裁定）**：`collapsed` 只留 badge 计数（卡头那行按钮），不画卡片；
 * `default`（缺省）显示前 `previewCount` 组（缺省 3，数量可配置），其余折叠成
 * 「展开全部（还有 N 条）」；`expanded` 给完整列表，高度上限 + 滚动。卡头按钮在
 * 「badge ↔ 卡片」之间开合，footer 按钮在「默认 ↔ 全部」之间开合；都是纯展示状态，
 * 不触发 RPC。同源折叠组（「N 条」）与三态无关，各自独立开合。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../components/ToastProvider';
import { Icon } from '../../components/ui';
import type { GatewayClient } from '../../gateway/client';
import type {
  AgentClaimResponse,
  AgentInboxEntry,
  AgentInboxResponse,
  AgentRecallResponse,
} from '../../gateway/types';
import { t } from '../../i18n';
import { errorMessage } from './errors';
import { claimedEntryIds, inboxSummaryOf, inPendingStrip } from './pending-placement';
import type { PendingSend } from './pending-sends';
import {
  canUnhold,
  groupSenderName,
  HUMAN_SOURCE,
  ownedBySession,
  type PendingStripEntry,
  type PendingStripGroup,
  type PendingStripMode,
  PREVIEW_COUNT,
  pendingIdentityOf,
  pendingStripView,
} from './pending-strip';
import { QueuedNotice, type QueuedSubmission } from './StreamItems';

/**
 * 身份显示在哪：**卡内、卡头「等待中」胶囊之后**（`QueuedNotice` 的 `identity` → 卡头
 * `meta` 槽）。以前是卡外左侧一个标签，用户裁决要「身份放在卡片内部、等待中的后面」。
 *
 * 身份分档由 `pending-strip.ts` 的 `pendingIdentityOf` 定（纯函数，门禁探针直接断言）：
 * - `human` ⇒ i18n 的 `chat.pending.identity.human`；
 * - `ask` / `bash` / `system` 固定标签 ⇒ 对应 i18n 文案（ask 答复 / bash 作业 / 系统）——
 *   它们不是「谁说的话」，不走显示名分支（bash 的 from_name 是收件人自己）；
 * - 有 `from_name` ⇒ `agent:<name>`（与 AgentMessageCard / A2A 卡片同形）；
 * - 没有 `from_name` ⇒ **短 id**（8 位 + `…`）—— 绝不再把完整 UUID 摆到卡头。
 * - 空 `from` ⇒ 不给身份，卡头回到「胶囊 + 摘要」两段。
 *
 * 这里只补两处本层才知道的东西：i18n 的人类文案、以及**同源折叠组的兜底显示名**
 * （`fallbackName`：组头恰好是没名字的老条目时，用组里同名发送者的名字，不让组头退回短 id）。
 *
 * 冒号由 `QueuedNotice` 补（卡面统一 `<身份>: <说的话>`），这里只给纯身份。
 */
function identityOf(entry: PendingStripEntry, fallbackName?: string): string | undefined {
  return pendingIdentityOf(entry, {
    humanLabel: t('chat.pending.identity.human'),
    askLabel: t('chat.pending.identity.ask'),
    bashLabel: t('chat.pending.identity.bash'),
    systemLabel: t('chat.pending.identity.system'),
    agentLabel: (name) => t('chat.pending.identity.agent', { name }),
    ...(fallbackName !== undefined ? { fallbackName } : {}),
  });
}

/** 取数前的去抖：`agent.message.queued` 先于 run 开跑到达，空闲会话里那条毫秒级就被消费。 */
const DEBOUNCE_MS = 250;
/** 非空时的兜底轮询（空态零流量）：事件只当触发器，数据永远来自这次读。 */
const POLL_MS = 2000;

/** 一次读到的会话内待处理条目（连同它属于哪个会话，切会话时不串台）。 */
interface PendingInbox {
  sessionId: string;
  /** 取消要用它（条目没有 run id，recall 按 agent + message id 定位）。 */
  agentId?: string;
  entries: AgentInboxEntry[];
}

/** 条目 → 条带排序 / 折叠用的形状（`held` 与 `unread` 都保留：口径见 pending-strip.ts）。 */
function toEntry(entry: AgentInboxEntry): PendingStripEntry {
  return {
    message_id: entry.message_id,
    from: entry.from,
    summary: entry.summary,
    status: entry.status,
    ts: entry.ts,
    // 身份行要读名字：服务端在入队时存下的发送者显示名，原样带到条带上。
    ...(entry.from_name !== undefined ? { from_name: entry.from_name } : {}),
  };
}

/**
 * 就地改一条条目的 `status`：乐观更新与回滚共用这一份（不动顺序、不动别的条目）。
 *
 * 为什么不整体快照回退：unhold 只来回翻一条 `held ↔ unread`，轮询可能同时在更新别的
 * 条目 —— 回滚整摞会把别人的更新一起抹掉。
 */
function withEntryStatus(
  entries: readonly AgentInboxEntry[],
  messageId: string,
  status: AgentInboxEntry['status'],
): AgentInboxEntry[] {
  return entries.map((entry) => (entry.message_id === messageId ? { ...entry, status } : entry));
}

/**
 * 一行待处理项：时间线同款排队卡（现在只在条带里用）+ 可选的「N 条」折叠按钮。
 *
 * **身份在卡内**：`QueuedNotice` 的 `identity` → 卡头 `meta` 槽（「等待中」胶囊之后），
 * 卡外不再有 `human` 标签，所以这里也没有「标签 + 卡」那一层横向 flex —— 一行就是一张
 * 满宽的卡。卡片样式不在这里复制：圆点 / amber 带 / 胶囊 / 图标键全在 `QueuedNotice`
 * 里。同源折叠组只有**组头**带 `fold`（「N 条」开合），展开后的每一条都各自是一张完整
 * 的卡 —— 折叠只影响展示。
 *
 * **写操作按来源分档**：human 源三颗（收回编辑 / 取消排队 / 我已处理），非 human 源一颗
 * 「取消 hold 留档」（`onUnhold`，`canUnhold` 判定：非 human + 当前 held）。判定留在这一个
 * 地方，展开后的每一条与组头走同一条路径，不会出现「组头能撤、组内不能」这种分裂。
 */
function PendingRow({
  item,
  identity,
  human,
  label,
  onCancel,
  onEdit,
  onClaim,
  onUnhold,
  onRetry,
  fold,
}: {
  item: QueuedSubmission;
  /** 卡头身份（`human` / agent 名或 id）；`undefined` = 不渲染身份槽。 */
  identity?: string;
  /** 是不是 human 源（只有它是真删，才有三颗写键）。 */
  human: boolean;
  /**
   * 卡头文案覆盖（`QueuedNotice` 的 `label`）；缺省「等待中」。
   *
   * 本文件只有一处用它：**客户端失败的 pending**——「未发送 · 排队超时」这种结论句必须
   * 顶在卡头上（用户一眼就知道这条没发出去），而不是伪装成还在排队的「等待中」。
   */
  label?: string;
  onCancel: (id: string) => void;
  /** 缺省 = 这个宿主没有草稿槽可写（「收回编辑」不放一个点了没反应的键）。 */
  onEdit?: (id: string) => void;
  /** 缺省 = 不给「我已处理」（不可逆，只给 human 源）。 */
  onClaim?: (id: string) => void;
  /**
   * 缺省 = 不给「取消 hold / 留档」（只给「非 human 源 + 当前 held」的条目，见 `canUnhold`：
   * `unread` 的条目本来就是留档态，再给一颗「取消 hold」是假承诺）。
   */
  onUnhold?: (id: string) => void;
  /**
   * 缺省 = 不给「重试」。
   *
   * 只有**客户端失败**的 pending 给：重试是「再发一次同一句话」（由 `useChatSubmit` 复用
   * 同一个 pending id），而服务端条目上的重试会变成「同一个服务端 id 再投一次」，语义不同。
   */
  onRetry?: (id: string) => void;
  /** 组头才传：组内条数、开合状态与切换。 */
  fold?: { count: number; open: boolean; onToggle: () => void };
}) {
  // 写操作按来源分档：human 源三颗，非 human 源只有 unhold 那一颗（它的 recall 不是删除，
  // 而是把消息退回可读 unread）。`undefined` = 没给（`QueuedNotice` 把缺省当成「不给这颗
  // 键」，不画空槽）。
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <QueuedNotice
        item={item}
        identity={identity}
        onCancel={human ? onCancel : undefined}
        onEdit={human ? onEdit : undefined}
        onClaim={human ? onClaim : undefined}
        onUnhold={onUnhold}
        onRetry={human ? onRetry : undefined}
        {...(label !== undefined ? { label } : {})}
      />
      {fold && (
        <button
          type="button"
          className="self-start font-mono text-2xs text-faint hover:text-ink"
          onClick={fold.onToggle}
          aria-expanded={fold.open}
        >
          {t('chat.pending.sameSource', { count: fold.count })}
        </button>
      )}
    </div>
  );
}

/**
 * 条带的一行：可能是**服务端条目**，也可能是**客户端 pending**（用户刚发、还没被 run 取用）。
 *
 * 两者统一成一行，是因为「一条消息在条带上只有一行」这个保证必须落在同一份排序 / 折叠 /
 * 计数里；分成两个列表各画一遍，就会出现「服务端一条 + 客户端一条」的重复。
 *
 * `pending` 非空 = 这一行代表一条本地 pending：写操作除了 RPC 还要把那条 pending 收掉
 * （否则它会在下一次渲染里继续认领同一行）。
 */
interface StripRow {
  entry: PendingStripEntry;
  item: QueuedSubmission;
  pending?: PendingSend;
}

/** 客户端行的稳定 key：有服务端 id 就用它（写操作正好按它走），否则用本地 id。 */
function clientKeyOf(pending: PendingSend): string {
  return pending.messageId ?? `pending:${pending.id}`;
}

/**
 * 客户端 pending → 一行。
 *
 * 为什么这些消息要由客户端画、而不是等 `agents.inbox` 那条：两者是**同一条消息**，服务端
 * 那条会被 `claimedEntryIds` 顶替掉（见 `pending-placement.ts`）。客户端这行知道得更多 ——
 * 失败原因、重试、编辑（内容就在本地，不需要 peek）。这也让 `queued` 从会话流里撤掉的
 * 那一刻就有落点：同一帧里它从「会话气泡」变成「条带这一行」，中间没有空档。
 */
function clientRowOf(pending: PendingSend, cancelling: ReadonlySet<string>): StripRow {
  const key = clientKeyOf(pending);
  const summary = inboxSummaryOf(pending.text);
  return {
    entry: {
      message_id: key,
      from: HUMAN_SOURCE,
      summary,
      status: 'held',
      ts: pending.createdAt,
    },
    item: {
      id: key,
      input: summary,
      submittedAt: pending.createdAt,
      cancelling: cancelling.has(key),
    },
    pending,
  };
}

/**
 * 失败 pending 的卡头结论句：`未发送 · <原因>`。
 *
 * 只给四种已知原因翻人话（`queue_timeout` / `defer_timeout` / `timeout` / 断线文案），其余
 * 原样带出 —— 给命令、给内部错误码都不是人该读的东西（宪法第十四条）。
 */
function failureLabel(pending: PendingSend): string {
  const notSent = t('chat.pendingSend.failed');
  if (pending.failure === undefined) return notSent;
  if (pending.failure === 'queue_timeout') {
    return `${notSent} · ${t('chat.pendingSend.queueTimeout')}`;
  }
  if (pending.failure === 'defer_timeout') {
    return `${notSent} · ${t('chat.pendingSend.deferTimeout')}`;
  }
  if (pending.failure === 'timeout') return `${notSent} · ${t('chat.pendingSend.echoTimeout')}`;
  if (pending.failure === 'offline') return `${notSent} · ${t('chat.pendingSend.offline')}`;
  return `${notSent} · ${pending.failure}`;
}

/**
 * `deferred` pending 的卡头：`服务端已收下 · <为什么还没跑>`（0.57）。
 *
 * 为什么不能沿用「等待中」：`deferred` 与 `queued` 的用户动作不同 —— `stopped` 要人去
 * 处理（重试 / 换 body），`draining` / `rotate` 只要等。用同一句话会把「等」和「需要你动手」
 * 混成一档。未知 reason（服务端加了新的）走通用那句，不崩、也不谎称知道原因。
 */
function deferredLabel(pending: PendingSend): string {
  return t('chat.pendingSend.deferred', { reason: deferReasonText(pending.deferredReason) });
}

/** 服务端 reason 码 → 人话；未知码落到「等待服务端接单」。 */
export function deferReasonText(reason: string | undefined): string {
  if (reason === 'draining') return t('chat.pendingSend.deferred.draining');
  if (reason === 'rotate') return t('chat.pendingSend.deferred.rotate');
  if (reason === 'stopped') return t('chat.pendingSend.deferred.stopped');
  return t('chat.pendingSend.deferred.other');
}

/** 组内条目 → 条带行。对不上的（理论上不会发生）直接跳过：不渲染半张卡。 */
function rowsOf(group: PendingStripGroup, byId: ReadonlyMap<string, StripRow>): StripRow[] {
  return group.entries.flatMap((entry) => {
    const row = byId.get(entry.message_id);
    return row === undefined ? [] : [row];
  });
}

export function PendingStrip({
  sessionId,
  client,
  epoch,
  refreshKey,
  pendings = [],
  sentMessageIds = [],
  onRefillDraft,
  onRetryPending,
  onEditPending,
  onDismissPending,
  previewCount = PREVIEW_COUNT,
}: {
  /** 当前会话（`selectedId`）：条带只显示归属它的待处理输入。 */
  sessionId: string | null;
  client: GatewayClient;
  /** 连接代际：重连后重新读一次（断线期间落盘的条目要补上）。 */
  epoch: number;
  /** 外部触发器（本会话新受理一次发送 / run 数变化 / inbox 变更 live 事件）：变一次读一次。 */
  refreshKey: number;
  /**
   * 本会话的**客户端 pending**（`usePendingSends` 已按会话过滤）。
   *
   * 条带会把它里面的 `queued` / `failed` 画成行，并把被它们认领的服务端条目让位
   * （`pending-placement.ts#claimsEntry`）—— 「一条消息在条带上只有一行」就是这样保证的。
   */
  pendings?: readonly PendingSend[];
  /**
   * 已经**发出去**（服务端取用、回显到达）的 `message_id`。
   *
   * 条带的 `agents.inbox` 读数是**上一次轮询的缓存**（非空时每 2 s 一次）：那条消息被取用
   * 之后，缓存里还留着它，最长 2 s 内会与「会话里那条正常气泡」同时出现在屏上 ——
   * 又是同一条消息两份。这份名单让条带立刻把旧读数滤掉（不等下一次轮询，也不用猜）。
   */
  sentMessageIds?: readonly string[];
  /**
   * 把一条待处理输入的**全文**放回本会话的输入框草稿（「收回来编辑」的第二步）。
   *
   * 由页面给（草稿槽在 `useChatSubmit` 手里，条带只认这一条回调）：**只写草稿、
   * 绝不触发发送**。缺省 = 没有草稿槽可写（设计预览 / 未来别的宿主），此时「收回编辑」
   * 那颗键不出现 —— 点了没反应的按钮比没有按钮更糟。
   */
  onRefillDraft?: (text: string) => void;
  /**
   * 重试一条**客户端失败的** pending（`useChatSubmit.handleRetryPending`：复用同一个 id 重发）。
   *
   * 与「取消排队」的区别：那个是把这条从队列里拿走，这个是把同一句话再发一次。
   */
  onRetryPending?: (pending: PendingSend) => void;
  /**
   * 「编辑」一条客户端失败的 pending：把内容放回输入框 + 把这条从条带上删掉。
   *
   * 两部分都由页面提供（草稿槽 + `pendingSends.remove`）：条带只负责**先撤掉服务端那份**
   * （如果它已经在队列里），否则改完再发就会出现两条一模一样的消息。
   */
  onEditPending?: (pending: PendingSend) => void;
  /** 删掉一条客户端 pending（它还没成为服务端条目时，「取消」就是纯本地删除）。 */
  onDismissPending?: (pending: PendingSend) => void;
  /**
   * 默认态展示的组数（用户裁定「默认 3 条，数量可配置」）；缺省 {@link PREVIEW_COUNT}。
   * 展开态不受它限制（完整列表 + 限高滚动）。
   */
  previewCount?: number;
}) {
  const toast = useToast();
  /** 服务端最近一次读数；带归属会话，切会话时旧响应不会串到新会话上。 */
  const [pending, setPending] = useState<PendingInbox | null>(null);
  /** 在途的写操作（取消 / 收回编辑 / 我已处理）：同一条消息同时只允许一次，三颗键一起禁用。 */
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  /** 本地重读（写操作被拒 / 出错后与服务端对齐）。 */
  const [reloadTick, setReloadTick] = useState(0);
  /** 同源折叠组的展开状态（只影响展示：组内条目各自仍是真实的待处理条目）。 */
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  /**
   * 条带三态（用户裁定）：收起 = 只 badge；默认 = 前 previewCount 组；展开 = 全部 + 限高滚动。
   * 纯本地展示状态，不触发 RPC；切会话不重置（它是用户的查看偏好，不是会话数据）。
   */
  const [mode, setMode] = useState<PendingStripMode>('default');

  /**
   * 读一次盘。失败保留上一份读数（条带是提示，不把网络抖动升级成全局错误）。
   *
   * `session_id` 过滤在服务端做（等值比较，缺 `session_id` 的老条目永不命中），这里再走
   * 一遍同一个纯函数（`ownedBySession`）：防旧响应串台，也防「服务端哪天不再过滤」这个
   * 假设 —— 缺 `session_id` 一律不认，是这条带子的第一条硬口径。
   * **不再按来源过滤**：agent 源照常上带子，只在渲染时不给写操作。
   */
  const load = useCallback(
    async (targetSessionId: string) => {
      try {
        const body = await client.rpc<AgentInboxResponse>('agents.inbox', {
          session_id: targetSessionId,
        });
        const entries = ownedBySession(
          Array.isArray(body?.entries) ? body.entries : [],
          targetSessionId,
        );
        setPending({
          sessionId: targetSessionId,
          ...(typeof body?.agent_id === 'string' ? { agentId: body.agent_id } : {}),
          entries,
        });
      } catch {
        // 读失败：保留上一份（下次轮询 / 触发器再试），不弹 toast。
      }
    },
    [client],
  );

  // 触发读：切会话 / 重连（epoch）/ 本会话新受理一次发送（refreshKey）/ 取消后对齐
  // （reloadTick）。后三个只是「再读一次盘」的触发器，不参与读数本身 —— 条带的数据源
  // 永远是那次 RPC，不拿事件拼条目。
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch / refreshKey / reloadTick 是有意的触发器
  useEffect(() => {
    if (sessionId === null) {
      setPending(null);
      return;
    }
    const timer = window.setTimeout(() => void load(sessionId), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [sessionId, epoch, refreshKey, reloadTick, load]);

  const current = sessionId !== null && pending?.sessionId === sessionId ? pending : null;
  const entries = current?.entries ?? [];
  const hasPending = entries.length > 0;

  /**
   * 条带的**行**：未认领的服务端条目 + 客户端 pending 行，混成一份再排序 / 折叠。
   *
   * 认领（{@link claimedEntryIds}）在这里生效：客户端 pending 已经是同一条消息的另一个
   * 表示，服务端那份就不再单独出现 —— 这是「一条消息在条带上只有一行」的唯一开关，
   * 也是从会话流里撤掉 `queued` 气泡之后那条消息的落点。
   */
  const rows = useMemo(() => {
    const claimed = claimedEntryIds(pendings, entries);
    const sent = new Set(sentMessageIds);
    const serverRows: StripRow[] = entries
      .filter((entry) => !claimed.has(entry.message_id) && !sent.has(entry.message_id))
      .map((entry) => ({
        entry: toEntry(entry),
        item: {
          id: entry.message_id,
          input: entry.summary,
          submittedAt: entry.ts,
          cancelling: cancelling.has(entry.message_id),
        } satisfies QueuedSubmission,
      }));
    const clientRows = pendings.filter(inPendingStrip).map((item) => clientRowOf(item, cancelling));
    return [...serverRows, ...clientRows];
  }, [entries, pendings, sentMessageIds, cancelling]);

  // 非空时才轮询：空态零流量（条带绝大多数时间是空的）。
  useEffect(() => {
    if (sessionId === null || !hasPending) return;
    const id = window.setInterval(() => void load(sessionId), POLL_MS);
    return () => window.clearInterval(id);
  }, [sessionId, hasPending, load]);

  // 展开态给全部组（slice 上界取 MAX_SAFE_INTEGER = 不裁）；默认态按 previewCount 裁。
  const view = useMemo(
    () =>
      pendingStripView(
        rows.map((row) => row.entry),
        mode === 'expanded' ? Number.MAX_SAFE_INTEGER : previewCount,
      ),
    [rows, mode, previewCount],
  );
  /** 条目 id → 条带行（`QueuedNotice` 要吃 `QueuedSubmission`，动作还要认出客户端那条）。 */
  const byId = useMemo(() => new Map(rows.map((row) => [row.entry.message_id, row])), [rows]);

  /** 折叠组开合：纯本地状态，不触发任何 RPC。 */
  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /**
   * 取消一条待处理输入：`agents.recall`（human 源 = 真删）。
   *
   * 成功后**直接从条带里去掉**（不重读）：条目已经不在待处理集合里，下一次轮询也会得到
   * 同样的结果；失败 / 未受理则重读一次与服务端对齐，并给出提示，不本地假装成功。
   */
  const handleCancel = useCallback(
    async (messageId: string) => {
      const agentId = current?.agentId;
      if (agentId === undefined) return;
      setCancelling((prev) => new Set(prev).add(messageId));
      try {
        const result = await client.rpc<AgentRecallResponse>('agents.recall', {
          agent_id: agentId,
          message_ids: [messageId],
        });
        const deleted = Array.isArray(result?.deleted) ? result.deleted : [];
        if (deleted.includes(messageId)) {
          setPending((prev) =>
            prev === null
              ? prev
              : {
                  ...prev,
                  entries: prev.entries.filter((entry) => entry.message_id !== messageId),
                },
          );
          toast.success(t('chat.toast.queueCancelled'));
        } else {
          toast.error(t('chat.toast.cancelNotAccepted'));
          setReloadTick((value) => value + 1);
        }
      } catch (error) {
        toast.error(errorMessage(error));
        setReloadTick((value) => value + 1);
      } finally {
        setCancelling((prev) => {
          const next = new Set(prev);
          next.delete(messageId);
          return next;
        });
      }
    },
    [client, current?.agentId, toast],
  );

  /**
   * 「取消 hold / 留档」：`agents.recall` 对**非 human 源**的那个分支（消息不删，只 unhold）。
   *
   * 与取消的差别在**本地怎么改**：取消是从条带上把那条抹掉（条目真的没了），而这里消息
   * 还在 —— 只是从 `held` 退回 `unread`（模型仍能 read，条带也照样列着它）。所以成功之后
   * 不能照抄「filter 掉」那一步：那是把一个还在的条目伪装成消失。
   *
   * 于是这里做**乐观更新 + 按 id 回滚**：先把这一条就地翻成 `unread`（那颗键随之消失、
   * 排序把它排到还 held 的后面），RPC 被拒 / 抛错时按 id 翻回 `held` 再重读对齐。只回滚
   * 自己动过的那一条，不整体快照回退 —— 轮询可能同时在更新别的条目。
   */
  const handleUnhold = useCallback(
    async (messageId: string) => {
      const agentId = current?.agentId;
      if (agentId === undefined) return;
      setCancelling((prev) => new Set(prev).add(messageId));
      setPending((prev) =>
        prev === null
          ? prev
          : { ...prev, entries: withEntryStatus(prev.entries, messageId, 'unread') },
      );
      try {
        const result = await client.rpc<AgentRecallResponse>('agents.recall', {
          agent_id: agentId,
          message_ids: [messageId],
        });
        const deleted = Array.isArray(result?.deleted) ? result.deleted : [];
        if (deleted.includes(messageId)) {
          toast.success(t('chat.pending.unheld'));
        } else {
          // 服务端没受理（条目已经被别处处理掉了）：翻回去，再重读一次对齐。
          setPending((prev) =>
            prev === null
              ? prev
              : { ...prev, entries: withEntryStatus(prev.entries, messageId, 'held') },
          );
          toast.error(t('chat.pending.unholdRejected'));
          setReloadTick((value) => value + 1);
        }
      } catch (error) {
        setPending((prev) =>
          prev === null
            ? prev
            : { ...prev, entries: withEntryStatus(prev.entries, messageId, 'held') },
        );
        toast.error(t('chat.pending.unholdFailed', { detail: errorMessage(error) }));
        setReloadTick((value) => value + 1);
      } finally {
        setCancelling((prev) => {
          const next = new Set(prev);
          next.delete(messageId);
          return next;
        });
      }
    },
    [client, current?.agentId, toast],
  );

  /**
   * 收回一条待处理输入来改：**peek 全文 → 回填草稿 → recall 真删**，顺序不能反。
   *
   * 为什么必须是这个次序：recall 对 human 源是**真删**，删完这条消息就没了，`text` 也就再也
   * peek 不到 —— 而 `agents.inbox{ message_ids }` 是唯一能拿全文的现成途径（条带上只有
   * `summary`，是截断后的那一行）。所以「先拿正文、再删」不是风格，是唯一可行的次序：
   * 写反了就是「点一下，字没了」。三步全在这一个函数里、靠三个 `await` / 语句的先后钉住，
   * 中间没有第二个入口能插进来（在途期间整条的两个键都禁用）。
   *
   * 三个落点：
   * - **peek 失败**（RPC 报错 / 没命中那条 / 没有 `text` / 归属或来源对不上）：什么都不写、
   *   什么都不删 —— 条带原样留着，只给一句提示。宁可这次收不回来，也不能在没拿到正文的
   *   情况下把它删掉；
   * - **recall 被拒 / 抛错**：草稿**保留**（人手里至少还有那份文本），条带重读一次对齐，
   *   提示里说清「已放回输入框，但没撤下来」；
   * - 成功：从条带去掉那一条（与取消同一条本地减法），草稿里是全文，等着人改。
   */
  const handleTakeBack = useCallback(
    async (messageId: string) => {
      const agentId = current?.agentId;
      const targetSessionId = current?.sessionId;
      if (agentId === undefined || targetSessionId === undefined) return;
      if (onRefillDraft === undefined) return;
      setCancelling((prev) => new Set(prev).add(messageId));
      // 草稿是否已经写进去：决定 recall 失败时报哪一句（「已放回输入框，但…」vs 原样报错）。
      let refilled = false;
      try {
        // ① peek 全文：`agents.inbox` + `message_ids` 是只读（不改状态）。
        const peeked = await client.rpc<AgentInboxResponse>('agents.inbox', {
          agent_id: agentId,
          message_ids: [messageId],
        });
        const found = (Array.isArray(peeked?.entries) ? peeked.entries : []).find(
          (entry) => entry.message_id === messageId,
        );
        const text = found?.text;
        // 归属 / 来源再断一次：peek 按 agent 读（不带会话过滤），而写操作只对 human 源成立。
        // 对不上就按 peek 失败处理 —— 绝不顺着这条 id 去删别的会话 / 别的来源的消息。
        if (
          typeof text !== 'string' ||
          found?.from !== HUMAN_SOURCE ||
          found?.session_id !== targetSessionId
        ) {
          toast.error(t('chat.pending.editPeekFailed'));
          setReloadTick((value) => value + 1);
          return;
        }
        // ② 回填草稿：只写本地草稿槽（同步），不触发发送。空正文没有可改的东西，照样往下走。
        if (text.length > 0) {
          onRefillDraft(text);
          refilled = true;
        }
        // ③ 真删：human 源被删之后这条消息不再存在，正是「回到手里改完重发」的语义。
        const result = await client.rpc<AgentRecallResponse>('agents.recall', {
          agent_id: agentId,
          message_ids: [messageId],
        });
        const deleted = Array.isArray(result?.deleted) ? result.deleted : [];
        if (deleted.includes(messageId)) {
          setPending((prev) =>
            prev === null
              ? prev
              : {
                  ...prev,
                  entries: prev.entries.filter((entry) => entry.message_id !== messageId),
                },
          );
          toast.success(t('chat.pending.editTaken'));
        } else {
          toast.error(t('chat.pending.editRecallRejected'));
          setReloadTick((value) => value + 1);
        }
      } catch (error) {
        // 走到这里可能是 peek 抛错（此时还没动任何东西），也可能是 recall 抛错（草稿已在手里）。
        toast.error(
          refilled
            ? t('chat.pending.editRecallFailed', { detail: errorMessage(error) })
            : errorMessage(error),
        );
        setReloadTick((value) => value + 1);
      } finally {
        setCancelling((prev) => {
          const next = new Set(prev);
          next.delete(messageId);
          return next;
        });
      }
    },
    [client, current?.agentId, current?.sessionId, onRefillDraft, toast],
  );

  /**
   * 「我已处理」= `agents.claim`：把这条从队列里拿走，**不可逆**。
   *
   * 与取消（`agents.recall`）/ 收回编辑的差别只在「拿走之后留什么」：那两条一个真删、一个
   * 回填草稿，这条只要求「别再送进模型」（服务端标 consumed，条目从此不再投递、不再出现
   * 在 `agents.inbox` 里）。所以这里不需要 peek 正文 —— 条带上的摘要就是人自己写的那句话，
   * 他点的是「我处理过了」，不是「把字还给我」。
   *
   * 失败要如实：`skipped` 的 `not_found` / `consumed` 说明这条早就走了（别人 / run 已经
   * 拿走了它），此时不本地假装成功 —— 重读一次与服务端对齐，并把原因说出来。条带之后
   * 自己也会因为这一条不在读数里而消失，但那是「重读的结果」，不是我们猜的。
   */
  const handleClaim = useCallback(
    async (messageId: string) => {
      const agentId = current?.agentId;
      if (agentId === undefined) return;
      setCancelling((prev) => new Set(prev).add(messageId));
      try {
        const result = await client.rpc<AgentClaimResponse>('agents.claim', {
          agent_id: agentId,
          message_ids: [messageId],
        });
        const claimed = Array.isArray(result?.claimed) ? result.claimed : [];
        if (claimed.includes(messageId)) {
          setPending((prev) =>
            prev === null
              ? prev
              : {
                  ...prev,
                  entries: prev.entries.filter((entry) => entry.message_id !== messageId),
                },
          );
          toast.success(t('chat.pending.claimTaken'));
        } else {
          // 没拿成就别猜「为什么」：reason 由服务端给，翻成人话再说。
          const skip = (result?.skipped ?? []).find((entry) => entry.message_id === messageId);
          const why =
            skip?.reason === 'consumed'
              ? t('chat.pending.claimSkipped.consumed')
              : t('chat.pending.claimSkipped.notFound');
          toast.error(t('chat.pending.claimSkipped', { reason: why }));
          setReloadTick((value) => value + 1);
        }
      } catch (error) {
        toast.error(errorMessage(error));
        setReloadTick((value) => value + 1);
      } finally {
        setCancelling((prev) => {
          const next = new Set(prev);
          next.delete(messageId);
          return next;
        });
      }
    },
    [client, current?.agentId, toast],
  );

  /**
   * 只撤一条**服务端**队列条目（不带成功提示）：客户端行的「编辑 / 重试」在动手之前必须
   * 先把它撤掉 —— 否则同一句话会在服务端队列里再跑一遍，用户看到的就是两份。
   *
   * 缺 `agentId`（还没读到过盘）时按失败处理：宁可这一次什么都不动，也不能在不知道往哪撤的
   * 时候把本地那条删掉（正文就真的没了）。
   */
  const recallEntry = useCallback(
    async (messageId: string): Promise<boolean> => {
      const agentId = current?.agentId;
      if (agentId === undefined) {
        toast.error(t('chat.pendingSend.recallUnknown'));
        return false;
      }
      try {
        const result = await client.rpc<AgentRecallResponse>('agents.recall', {
          agent_id: agentId,
          message_ids: [messageId],
        });
        const deleted = Array.isArray(result?.deleted) ? result.deleted : [];
        if (!deleted.includes(messageId)) {
          toast.error(t('chat.pendingSend.recallRejected'));
          setReloadTick((value) => value + 1);
          return false;
        }
        setPending((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                entries: prev.entries.filter((entry) => entry.message_id !== messageId),
              },
        );
        return true;
      } catch (error) {
        toast.error(errorMessage(error));
        setReloadTick((value) => value + 1);
        return false;
      }
    },
    [client, current?.agentId, toast],
  );

  /** 某一行代表的客户端 pending（服务端条目行没有它）。 */
  const pendingOf = (id: string): PendingSend | undefined => byId.get(id)?.pending;

  /** 把这一行对应的客户端 pending 从 store 里删掉（它已经不该在屏上了）。 */
  const dropPending = (pending: PendingSend | undefined) => {
    if (pending !== undefined) onDismissPending?.(pending);
  };

  // 空列表整块不渲染（不占高度、不留空壳）。
  if (view.total === 0) return null;

  const label = t('chat.pending.title', { count: view.total });

  /**
   * 取消：服务端条目走 `agents.recall`（真删）；**还没被服务端收下的** pending 是纯本地
   * 删除（服务端什么都没收到，没有孤儿要清理）。客户端行有 `messageId` 时两者都要做。
   */
  const cancelRow = (id: string) => {
    const pending = pendingOf(id);
    if (pending === undefined) {
      void handleCancel(id);
      return;
    }
    if (pending.messageId === undefined) {
      dropPending(pending);
      return;
    }
    void handleCancel(pending.messageId).then(() => dropPending(pending));
  };

  /**
   * 编辑（= 用户的「编辑」）：**先撤服务端那份，再把内容放回输入框并删掉这一行**。
   *
   * 顺序不能反：先回填再撤，撤失败时屏上会同时出现「输入框里那段字」和「队列里那条」，
   * 用户一按发送就是两份。所以撤不下来就什么都不改（草稿原样、条带那行留着）。
   *
   * 服务端条目行仍然走老的「peek 全文 → 回填 → recall」（正文在服务端，本地没有副本）。
   */
  const editRow = (id: string) => {
    const pending = pendingOf(id);
    if (pending === undefined) {
      void handleTakeBack(id);
      return;
    }
    void (async () => {
      if (pending.messageId !== undefined) {
        const recalled = await recallEntry(pending.messageId);
        if (!recalled) return;
      }
      if (onEditPending !== undefined) {
        onEditPending(pending);
        return;
      }
      // 没有 onEditPending 的宿主（设计预览）：只做能得到的那一半，绝不假装成功。
      onRefillDraft?.(pending.text);
      dropPending(pending);
    })();
  };

  /**
   * 重试：**先撤掉服务端那条排队中的旧消息**，再用同一个 pending id 重发同一句话。
   *
   * 不先撤就重发 = 同一句话执行两次（旧的还在队列里，新的又排一条）。撤不下来就不重发：
   * 条带那行留着，「重试」随时可以再点。
   */
  const retryRow = (id: string) => {
    const pending = pendingOf(id);
    if (pending === undefined) return;
    void (async () => {
      if (pending.messageId !== undefined) {
        const recalled = await recallEntry(pending.messageId);
        if (!recalled) return;
      }
      onRetryPending?.(pending);
    })();
  };

  /** 我已处理：不可逆，只给「服务端真的收下了」的那些行（本地 pending 没有可处理的东西）。 */
  const claimRow = (id: string) => {
    const pending = pendingOf(id);
    if (pending === undefined) {
      void handleClaim(id);
      return;
    }
    if (pending.messageId === undefined) return;
    void handleClaim(pending.messageId).then(() => dropPending(pending));
  };
  const unholdRow = (id: string) => void handleUnhold(id);

  /**
   * 行的卡头文案：失败的客户端行说「未发送 · 原因」，`deferred` 说「已收下 · 为什么还没跑」，
   * 其余照旧「等待中」。
   */
  const labelOf = (row: StripRow): string | undefined =>
    row.pending?.state === 'failed'
      ? failureLabel(row.pending)
      : row.pending?.state === 'deferred'
        ? deferredLabel(row.pending)
        : undefined;
  /** 只有失败的客户端行给「重试」（服务端条目没有「再发一次」的语义）。 */
  const retryOf = (row: StripRow): ((id: string) => void) | undefined =>
    row.pending?.state === 'failed' ? retryRow : undefined;
  /** 只有真的有服务端 id 的行给「我已处理」（否则它等价于删除，用取消那颗键就够）。 */
  const claimOf = (row: StripRow): ((id: string) => void) | undefined =>
    row.pending === undefined || row.pending.messageId !== undefined ? claimRow : undefined;
  /** 「收回编辑」要宿主给草稿槽；客户端行只需要 pending 正文（本地就有）。 */
  const editOf = (row: StripRow): ((id: string) => void) | undefined =>
    row.pending !== undefined || onRefillDraft !== undefined ? editRow : undefined;

  return (
    <section className="flex-none pb-2" aria-label={label}>
      {/* 与消息列同宽同内边距：外层是 `.conversation-scroll` 的内衬，内层是
          `.conversation-scroll > *` 的 `--chat-content-w` 列宽 + 居中。 */}
      <div className="px-[var(--content-pad-inline)]">
        <div className="mx-auto flex max-w-[var(--chat-content-w,860px)] flex-col gap-1.5">
          {/* 卡头 = badge + 三态开关：点击在「只 badge ↔ 卡片」之间开合（用户裁定）。
              chevron 与 StreamCard 同形：收起指右，展开旋转 90° 指下。 */}
          <button
            type="button"
            className="m-0 flex items-center gap-1 self-start font-mono text-2xs tracking-wide text-faint hover:text-ink"
            onClick={() => setMode((prev) => (prev === 'collapsed' ? 'default' : 'collapsed'))}
            aria-expanded={mode !== 'collapsed'}
          >
            <Icon
              name="chevron"
              className={`event-toggle-icon h-3 w-3 ${mode === 'collapsed' ? '' : 'rotate-90'}`}
            />
            {label}
          </button>

          {mode !== 'collapsed' && (
            <div className={mode === 'expanded' ? 'max-h-[40vh] overflow-y-auto' : undefined}>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {view.preview.map((group) => {
                  // 组头 + 其余：`head` 取不到就整组跳过（不渲染半张卡）。
                  const [head, ...rest] = rowsOf(group, byId);
                  if (head === undefined) return null;
                  const folded = group.entries.length > 1;
                  const open = folded && expandedGroups.has(group.key);
                  const fold = folded
                    ? { count: group.entries.length, open, onToggle: () => toggleGroup(group.key) }
                    : undefined;
                  // 组内条目同源（`from` 相同），所以显示名只需算一次：组里任一条有名字，
                  // 组头与展开后的每一条都用它 —— 同一张卡的不同行不该出现两种身份写法。
                  const senderName = groupSenderName(group);
                  return (
                    <li key={group.key} className="flex flex-col gap-1.5">
                      <PendingRow
                        item={head.item}
                        identity={identityOf(head.entry, senderName)}
                        human={head.entry.from === HUMAN_SOURCE}
                        {...(labelOf(head) !== undefined ? { label: labelOf(head) } : {})}
                        onCancel={cancelRow}
                        onEdit={editOf(head)}
                        onClaim={claimOf(head)}
                        onUnhold={
                          head.pending === undefined && canUnhold(head.entry)
                            ? unholdRow
                            : undefined
                        }
                        onRetry={retryOf(head)}
                        fold={fold}
                      />
                      {/* 展开后逐条列出：仍是那些待处理条目，写操作按各自的条目 id 与来源判定。 */}
                      {open && (
                        <ul className="m-0 flex list-none flex-col gap-1.5 border-l border-line pl-2">
                          {rest.map((row) => (
                            <li key={row.entry.message_id}>
                              <PendingRow
                                item={row.item}
                                identity={identityOf(row.entry, senderName)}
                                human={row.entry.from === HUMAN_SOURCE}
                                {...(labelOf(row) !== undefined ? { label: labelOf(row) } : {})}
                                onCancel={cancelRow}
                                onEdit={editOf(row)}
                                onClaim={claimOf(row)}
                                onUnhold={
                                  row.pending === undefined && canUnhold(row.entry)
                                    ? unholdRow
                                    : undefined
                                }
                                onRetry={retryOf(row)}
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* 默认态：其余条目折叠成一颗「展开全部」；展开态：一颗「收起」回到默认。
              都是纯展示切换，不触发 RPC。 */}
          {mode === 'default' && view.hidden > 0 && (
            <button
              type="button"
              className="m-0 self-start font-mono text-2xs text-faint hover:text-ink"
              onClick={() => setMode('expanded')}
            >
              {t('chat.pending.expandAll', { count: view.hidden })}
            </button>
          )}
          {mode === 'expanded' && (
            <button
              type="button"
              className="m-0 self-start font-mono text-2xs text-faint hover:text-ink"
              onClick={() => setMode('default')}
            >
              {t('chat.pending.collapseList')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
