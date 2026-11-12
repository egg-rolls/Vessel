/**
 * 待处理条带：聊天输入区上方的一条摘要，**不进入时间线**。
 *
 * 它回答的是「我这一轮还压着几条输入」，不是队列编辑器。
 *
 * **数据源是服务端持久真相（0.53）**：`agents.inbox{ session_id }`（服务端按归属等值过滤，
 * 前端再断 `from === 'human'`）。不再读客户端内存里的 `queuedRuns` —— 那是「一份内存、
 * 两处渲染」，刷新 / 切会话就消失；也不再读 agent 维度的全量 inbox —— 那会把「父 agent
 * 发给子成员的消息」串进这条带子。
 *
 * 三条硬口径：
 * - **没有 `session_id` 的条目一律不显示**（老条目 / `wake`·`quiet` 投递）：宁可隐藏，
 *   也不把别人的消息串到这条会话上；
 * - **数据永远来自那次 RPC 读**，事件只当触发器（切会话 / 重连 / 本会话新受理一次发送），
 *   非空时 2s 兜底轮询（空态零流量）；取数前 250ms debounce，让「发完立刻开跑」的条目
 *   不在条带上闪一下；
 * - 条带只做「还有几条在等」，写入口只有「取消」—— 走 `agents.recall`（human 源 = 真删），
 *   成功后那条从条带上消失（没有「已取消」残留态）。
 *
 * 视觉零改动：卡片仍是 `QueuedNotice`（amber / 满宽 / 单圆点 / actions 槽位 / `onBand`
 * 胶囊），卡头文案换成「等待中」（`chat.pending.waiting`）—— 条目没有 run，落盘后也没有
 * 权威队列顺序，所以不编序号。
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
import type { AgentInboxEntry, AgentInboxResponse, AgentRecallResponse } from '../../gateway/types';
import { t } from '../../i18n';
import { errorMessage } from './errors';
import { type PendingStripEntry, type PendingStripGroup, pendingStripView } from './pending-strip';
import { QueuedNotice, type QueuedSubmission } from './StreamItems';

/**
 * 条带里唯一的来源标识。条带只收人发的待处理输入（agent 源属于另一个切片：需要
 * `from_name` 与「谁的收件箱」语义，本轮不做），所以固定是「人」；文案走 i18n
 * （`chat.pending.identity.human`），不在 JSX 里硬编码。
 */
const HUMAN_SOURCE = 'human';

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
 * 一行待处理项：身份前缀（`human`）+ 时间线同款排队卡（现在只在条带里用）。
 *
 * 卡片本身由 `QueuedNotice` 提供（含「取消」控件），这里只负责布局与身份前缀：
 * 不复制样式、不在卡外再拼一层卡片。同源折叠组只有**组头**带 `fold`（「N 条」开合），
 * 展开后的每一条都各自是一张完整的卡 —— 折叠只影响展示。
 */
function PendingRow({
  item,
  onCancel,
  fold,
}: {
  item: QueuedSubmission;
  onCancel: (id: string) => void;
  /** 组头才传：组内条数、开合状态与切换。 */
  fold?: { count: number; open: boolean; onToggle: () => void };
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="flex-none pt-1.5 font-mono text-2xs tracking-wide text-faint">
        {t('chat.pending.identity.human')}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <QueuedNotice item={item} onCancel={onCancel} />
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
}: {
  /** 当前会话（`selectedId`）：条带只显示归属它的待处理输入。 */
  sessionId: string | null;
  client: GatewayClient;
  /** 连接代际：重连后重新读一次（断线期间落盘的条目要补上）。 */
  epoch: number;
  /** 外部触发器（本会话新受理一次发送 / run 数变化）：变一次读一次。 */
  refreshKey: number;
}) {
  const toast = useToast();
  /** 服务端最近一次读数；带归属会话，切会话时旧响应不会串到新会话上。 */
  const [pending, setPending] = useState<PendingInbox | null>(null);
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  /** 本地重读（取消被拒 / 出错后与服务端对齐）。 */
  const [reloadTick, setReloadTick] = useState(0);
  /** 同源折叠组的展开状态（只影响展示：组内条目各自仍是真实的待处理条目）。 */
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());

  /**
   * 读一次盘。失败保留上一份读数（条带是提示，不把网络抖动升级成全局错误）。
   *
   * `session_id` 过滤在服务端做（等值比较，缺 `session_id` 的老条目永不命中），这里再断
   * 一次 `session_id === 目标会话` + `from === 'human'`：前者防旧响应串台，后者只收人发的。
   */
  const load = useCallback(
    async (targetSessionId: string) => {
      try {
        const body = await client.rpc<AgentInboxResponse>('agents.inbox', {
          session_id: targetSessionId,
        });
        const entries = (Array.isArray(body?.entries) ? body.entries : []).filter(
          (entry) => entry.session_id === targetSessionId && entry.from === HUMAN_SOURCE,
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

  // 空列表整块不渲染（不占高度、不留空壳）。
  if (view.total === 0) return null;

  const label = t('chat.pending.title', { count: view.total });

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
                    onCancel={(id) => void handleCancel(id)}
                    fold={fold}
                  />
                  {/* 展开后逐条列出：仍是那些待处理条目，取消按各自的条目 id 操作。 */}
                  {open && (
                    <ul className="m-0 flex list-none flex-col gap-1.5 border-l border-line pl-2">
                      {rest.map((row) => (
                        <li key={row.entry.message_id}>
                          <PendingRow item={row.item} onCancel={(id) => void handleCancel(id)} />
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
