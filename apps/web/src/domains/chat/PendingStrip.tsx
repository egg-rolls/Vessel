/**
 * 待处理条带：聊天输入区上方的一条摘要，**不进入时间线**。
 *
 * 它回答的是「我这一轮还压着几条输入」，不是队列编辑器：
 * - **数据只取本会话自己的排队提交**（`useChatTranscript.visibleQueued`，那里已经按
 *   `item.sessionId === selectedId` 过滤过）。**不再读 `agents.inbox`**：inbox 是 agent
 *   维度、条目里没有 session_id —— 既会把「父 agent 发给子成员的消息」（例如任务书）
 *   串进这条带子，也没法在切会话时按会话过滤，于是旧数据会一直留在屏幕上。换了数据源
 *   之后，「串进子成员收件箱」和「切会话残留」两个问题一起消失，不需要额外的过滤魔法。
 * - 默认隐藏：没有待处理项时整块不渲染，不占位；
 * - 显示 `待处理 · N` + 前 3 张卡，其余折叠成「还有 N 条」；
 * - 卡片**直接复用时间线里那张排队卡**（`QueuedNotice`，与 `TranscriptWindow` 同源），
 *   不复制样式、不自己拼卡片；行首只加一个身份前缀（人发的显示 i18n 的 `human`）。
 *   以后的取消 / 重试都走那张卡自带的 actions 槽位，不在这里另造按钮。
 * - 取消排队接的是既有 `submitApi.handleCancelQueued`（真取消）；已取消的项不再是
 *   「待处理」，直接从条带里消失（时间线里那张卡会以「已取消」留在原处）。
 *
 * **没有置顶，也别加回来**：条带的写入口只有「取消排队」。原先的「置顶并打断当前运行」
 * 按钮、确认框、`agents.send{message_id, interrupt}` 复用与 footer「优先级仅在本次运行期
 * 有效；重启后按到达顺序」都已删除 —— 置顶没了，那句话就是假承诺；`chat.pending.pin*`
 * 文案同步删除（后端 RPC 不动，只是前端不再有入口）。
 *
 * 宽度与消息列表同宽同内边距：它渲染在 `.content-stage` 里（与转录区同一个容器），
 * 外层用 `.conversation-scroll` 同款内衬，内层用同款 `--chat-content-w` 列宽 + 居中。
 */
import { useMemo, useState } from 'react';
import { t } from '../../i18n';
import { type PendingStripEntry, type PendingStripGroup, pendingStripView } from './pending-strip';
import { QueuedNotice, type QueuedSubmission } from './StreamItems';

/**
 * 条带里唯一的来源标识。当前只显示本会话的用户排队项，所以固定是「人」；
 * 文案走 i18n（`chat.pending.identity.human`），不在 JSX 里硬编码。
 */
const HUMAN_SOURCE = 'human';

/** 排队提交 → 条带条目：`run_id` 就是条目的稳定 key。 */
function toEntry(item: QueuedSubmission): PendingStripEntry {
  return {
    message_id: item.runId,
    from: HUMAN_SOURCE,
    summary: item.input,
    // 已受理未执行的 run = 「已排进队列」，与 inbox 的 held 同档（见 pending-strip.ts）。
    status: 'held',
    ts: item.submittedAt,
  };
}

/**
 * 一行待处理项：身份前缀（`human`）+ 时间线同款排队卡。
 *
 * 卡片本身由 `QueuedNotice` 提供（含「取消排队」控件），这里只负责布局与身份前缀：
 * 不复制样式、不在卡外再拼一层卡片。同源折叠组只有**组头**带 `fold`（「N 条」开合），
 * 展开后的每一条都各自是一张完整的卡 —— 折叠只影响展示。
 */
function PendingRow({
  item,
  onCancel,
  fold,
}: {
  item: QueuedSubmission;
  onCancel: (runId: string) => void;
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
  byRunId: ReadonlyMap<string, QueuedSubmission>,
): { entry: PendingStripEntry; item: QueuedSubmission }[] {
  return group.entries.flatMap((entry) => {
    const item = byRunId.get(entry.message_id);
    return item === undefined ? [] : [{ entry, item }];
  });
}

export function PendingStrip({
  queued,
  onCancel,
}: {
  /** 本会话的排队提交（`transcriptApi.visibleQueued`：已按会话过滤，别的会话的项进不来）。 */
  queued: readonly QueuedSubmission[];
  /** 取消排队：直接接 `submitApi.handleCancelQueued`（真取消，不是本地隐藏）。 */
  onCancel: (runId: string) => void;
}) {
  /** 同源折叠组的展开状态（只影响展示：组内条目各自仍是真实的排队提交）。 */
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());

  // 已取消的排队项不再是「待处理」：条带里直接消失（时间线那张卡会以「已取消」留在原处）。
  const pending = useMemo(() => queued.filter((item) => !item.cancelled), [queued]);
  const entries = useMemo(() => pending.map(toEntry), [pending]);
  /** message_id（= run_id）→ 原排队项：卡片要吃 `QueuedSubmission`，不能只给条目。 */
  const byRunId = useMemo(() => new Map(pending.map((item) => [item.runId, item])), [pending]);
  const view = useMemo(() => pendingStripView(entries), [entries]);

  /** 折叠组开合：纯本地状态，不触发任何 RPC。 */
  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

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
              const [head, ...rest] = rowsOf(group, byRunId);
              if (head === undefined) return null;
              const folded = group.entries.length > 1;
              const open = folded && expandedGroups.has(group.key);
              const fold = folded
                ? { count: group.entries.length, open, onToggle: () => toggleGroup(group.key) }
                : undefined;
              return (
                <li key={group.key} className="flex flex-col gap-1.5">
                  <PendingRow item={head.item} onCancel={onCancel} fold={fold} />
                  {/* 展开后逐条列出：仍是原来那些排队项，取消按各自的 run_id 操作。 */}
                  {open && (
                    <ul className="m-0 flex list-none flex-col gap-1.5 border-l border-line pl-2">
                      {rest.map((row) => (
                        <li key={row.entry.message_id}>
                          <PendingRow item={row.item} onCancel={onCancel} />
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
