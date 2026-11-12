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
 * - **数据永远来自那次 RPC 读**，事件只当触发器（切会话 / 重连 / 本会话新受理一次发送），
 *   非空时 2s 兜底轮询（空态零流量）；取数前 250ms debounce，让「发完立刻开跑」的条目
 *   不在条带上闪一下；
 * - 条带只做「还有几条在等」，写入口按来源分档（见下）。
 *
 * **来源分档（0.51）**：条带展示**两个来源**，但写操作只给 `human`：
 * - human 源（人打的字）：三颗图标键 —— 「收回来编辑」（peek 正文 → 回填草稿 → recall）、
 *   「取消排队」（recall 真删）与「我已处理」（claim：标 consumed，拿走这次投递），
 *   成功后那条从条带上消失；
 * - agent 源（父 agent 发给本会话的消息）：**只展示，一颗写键都不给**。它的 recall 语义是
 *   unhold 留档（消息回到可读 unread，模型仍能 read），画成「撤掉」就是伪装成删除；claim
 *   在它身上等于「人替这具 body 处理掉别人给它的输入」，更没有立场。所以这里 —— 与
 *   取消 / 收回编辑不同 —— `agents.claim` 在前端也**只对 human 源开放**。
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
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../components/ToastProvider';
import type { GatewayClient } from '../../gateway/client';
import type {
  AgentClaimResponse,
  AgentInboxEntry,
  AgentInboxResponse,
  AgentRecallResponse,
} from '../../gateway/types';
import { t } from '../../i18n';
import { errorMessage } from './errors';
import {
  ownedBySession,
  type PendingStripEntry,
  type PendingStripGroup,
  pendingStripView,
} from './pending-strip';
import { QueuedNotice, type QueuedSubmission } from './StreamItems';

/**
 * human 源的值（服务端 inbox 条目里 `source` 就是发送者 principal）。
 *
 * 只用于**能不能写**的判定（`agents.recall` 对 human 才是真删，其它源是 unhold 留档）；
 * 展示不再按来源过滤 —— agent 源的条目同样上条带。
 */
const HUMAN_SOURCE = 'human';

/**
 * 身份显示在哪：**卡内、卡头「等待中」胶囊之后**（`QueuedNotice` 的 `identity` → 卡头
 * `meta` 槽）。以前是卡外左侧一个标签，用户裁决要「身份放在卡片内部、等待中的后面」。
 *
 * `from` → 卡头显示的身份名：
 * - `human` ⇒ i18n 的 `chat.pending.identity.human`（值就是 `human`）；
 * - 其它（agent 源）⇒ **原始 id**（`agent:<alias>` 这类 principal 串，服务端就是这么存的）。
 *   要展示成昵称得另读 `agents.list` / roster（每条带子多一路 RPC 与依赖），本轮不为它
 *   加一次读 —— 原始 id 至少是「谁」的权威答案，不编名字。
 * - 空串（理论上不会发生）⇒ 不给身份，卡头回到「胶囊 + 摘要」两段。
 *
 * 冒号由 `QueuedNotice` 补（卡面统一 `<身份>: <说的话>`），这里只给纯名字。
 */
function identityOf(from: string): string | undefined {
  if (from === HUMAN_SOURCE) return t('chat.pending.identity.human');
  const trimmed = from.trim();
  return trimmed.length === 0 ? undefined : trimmed;
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
  };
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
 * **写操作只给 human 源**（`human` 这一个开关决定三颗键给不给）：agent 源的条目照常展示，
 * 但它的 recall 只是 unhold 留档，按钮放在那里就是假承诺。判定留在这一个地方，展开后的
 * 每一条与组头走同一条路径，不会出现「组头能撤、组内不能」这种分裂。
 */
function PendingRow({
  item,
  identity,
  human,
  onCancel,
  onEdit,
  onClaim,
  fold,
}: {
  item: QueuedSubmission;
  /** 卡头身份（`human` / agent 名或 id）；`undefined` = 不渲染身份槽。 */
  identity?: string;
  /** 是不是 human 源（只有它是真删，才有写入口）。 */
  human: boolean;
  onCancel: (id: string) => void;
  /** 缺省 = 这个宿主没有草稿槽可写（「收回编辑」不放一个点了没反应的键）。 */
  onEdit?: (id: string) => void;
  /** 缺省 = 不给「我已处理」（不可逆，只给 human 源）。 */
  onClaim?: (id: string) => void;
  /** 组头才传：组内条数、开合状态与切换。 */
  fold?: { count: number; open: boolean; onToggle: () => void };
}) {
  // 写操作只有「human 源」才出现：agent 源的 recall 只是 unhold 留档，画成删除就是骗人。
  // `undefined` = 没给（`QueuedNotice` 把缺省当成「不给这颗键」，不画空槽）。
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <QueuedNotice
        item={item}
        identity={identity}
        onCancel={human ? onCancel : undefined}
        onEdit={human ? onEdit : undefined}
        onClaim={human ? onClaim : undefined}
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

/** 组内条目 → 排队项。对不上的（理论上不会发生）直接跳过：不渲染半张卡。 */
function rowsOf(
  group: PendingStripGroup,
  byId: ReadonlyMap<string, QueuedSubmission>,
): { entry: PendingStripEntry; item: QueuedSubmission }[] {
  return group.entries.flatMap((entry) => {
    const item = byId.get(entry.message_id);
    return item === undefined ? [] : [{ entry, item }];
  });
}

export function PendingStrip({
  sessionId,
  client,
  epoch,
  refreshKey,
  onRefillDraft,
}: {
  /** 当前会话（`selectedId`）：条带只显示归属它的待处理输入。 */
  sessionId: string | null;
  client: GatewayClient;
  /** 连接代际：重连后重新读一次（断线期间落盘的条目要补上）。 */
  epoch: number;
  /** 外部触发器（本会话新受理一次发送 / run 数变化）：变一次读一次。 */
  refreshKey: number;
  /**
   * 把一条待处理输入的**全文**放回本会话的输入框草稿（「收回来编辑」的第二步）。
   *
   * 由页面给（草稿槽在 `useChatSubmit` 手里，条带只认这一条回调）：**只写草稿、
   * 绝不触发发送**。缺省 = 没有草稿槽可写（设计预览 / 未来别的宿主），此时「收回编辑」
   * 那颗键不出现 —— 点了没反应的按钮比没有按钮更糟。
   */
  onRefillDraft?: (text: string) => void;
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

  // 非空时才轮询：空态零流量（条带绝大多数时间是空的）。
  useEffect(() => {
    if (sessionId === null || !hasPending) return;
    const id = window.setInterval(() => void load(sessionId), POLL_MS);
    return () => window.clearInterval(id);
  }, [sessionId, hasPending, load]);

  const view = useMemo(() => pendingStripView(entries.map(toEntry)), [entries]);
  /** 条目 id → 卡片数据（`QueuedNotice` 要吃 `QueuedSubmission`，不能只给条目）。 */
  const byId = useMemo(
    () =>
      new Map(
        entries.map((entry) => [
          entry.message_id,
          {
            id: entry.message_id,
            input: entry.summary,
            submittedAt: entry.ts,
            cancelling: cancelling.has(entry.message_id),
          } satisfies QueuedSubmission,
        ]),
      ),
    [entries, cancelling],
  );

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

  // 空列表整块不渲染（不占高度、不留空壳）。
  if (view.total === 0) return null;

  const label = t('chat.pending.title', { count: view.total });
  // 三个写操作只在这里接一次：组头 / 组内 / 展开后的每条都走同一组回调。
  // 「收回编辑」额外要宿主给草稿槽，没有就不给这颗键（点了没反应比没有更糟）。
  const cancelRow = (id: string) => void handleCancel(id);
  const takeBackRow = (id: string) => void handleTakeBack(id);
  const editRow = onRefillDraft === undefined ? undefined : takeBackRow;
  const claimRow = (id: string) => void handleClaim(id);

  return (
    <section className="flex-none pb-2" aria-label={label}>
      {/* 与消息列同宽同内边距：外层是 `.conversation-scroll` 的内衬，内层是
          `.conversation-scroll > *` 的 `--chat-content-w` 列宽 + 居中。 */}
      <div className="px-[var(--content-pad-inline)]">
        <div className="mx-auto flex max-w-[var(--chat-content-w,860px)] flex-col gap-1.5">
          <p className="m-0 font-mono text-2xs tracking-wide text-faint">{label}</p>

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
              return (
                <li key={group.key} className="flex flex-col gap-1.5">
                  <PendingRow
                    item={head.item}
                    identity={identityOf(head.entry.from)}
                    human={head.entry.from === HUMAN_SOURCE}
                    onCancel={cancelRow}
                    onEdit={editRow}
                    onClaim={claimRow}
                    fold={fold}
                  />
                  {/* 展开后逐条列出：仍是那些待处理条目，写操作按各自的条目 id 与来源判定。 */}
                  {open && (
                    <ul className="m-0 flex list-none flex-col gap-1.5 border-l border-line pl-2">
                      {rest.map((row) => (
                        <li key={row.entry.message_id}>
                          <PendingRow
                            item={row.item}
                            identity={identityOf(row.entry.from)}
                            human={row.entry.from === HUMAN_SOURCE}
                            onCancel={cancelRow}
                            onEdit={editRow}
                            onClaim={claimRow}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>

          {view.hidden > 0 && (
            <p className="m-0 text-2xs text-faint">
              {t('chat.pending.more', { count: view.hidden })}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
