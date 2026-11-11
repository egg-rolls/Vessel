/**
 * 待处理条带（只读）：聊天输入区上方的一条摘要，**不进入时间线**。
 *
 * 它回答的是「还有多少消息在等」，不是队列编辑器：
 * - 默认隐藏：没有待处理项时整条不渲染，不占位；
 * - 显示 `待处理 · N` + 前 3 条摘要，其余折叠；
 * - 点某条只 **peek 正文**（`agents.inbox` 带 `message_ids`，服务端不改状态）；
 * - 相邻同源（同 `from` + 状态，正文互为前缀或一条包含另一条）折成一行、右侧显示
 *   「N 条」，点开可看全部条目：**只影响展示**，数据与 inbox 语义不变；
 * - 唯一的写操作是「置顶并打断当前运行」（复用 `agents.send{message_id, interrupt}`），
 *   先弹确认，因为它的真实语义是取消当前 run 并把这条排到队首；
 * - 底部写明「优先级仅在本次运行期有效；重启后按到达顺序」，避免假功能观感。
 */
import { useCallback, useMemo, useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/ToastProvider';
import { Button } from '../../components/ui';
import type { GatewayClient } from '../../gateway/client';
import type { AgentInboxEntry } from '../../gateway/types';
import { t } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { pendingStripView } from './pending-strip';

/** 服务端置顶失败的稳定 code → 本地化文案（不把 code 当正文）。 */
function pinFailureMessage(code: string | undefined): string {
  if (code === 'permission_pending') return t('chat.pending.pinFailed.permission');
  if (code === 'resume_in_progress') return t('chat.pending.pinFailed.resume');
  if (code === 'member_closed') return t('chat.pending.pinFailed.closed');
  if (code === 'member_stale') return t('chat.pending.pinFailed.stale');
  if (code === 'invalid_params') return t('chat.pending.pinFailed.rotate');
  return t('chat.pending.pinFailed.other');
}

/**
 * 单条待处理项的一行：状态 / 来源 / 摘要（点击 peek，服务端不改状态）/ 置顶。
 *
 * 同源折叠组的组头复用同一行，只把摘要点击改成展开组、并在右侧显示「N 条」；
 * 组内条目展开后仍各是一行，peek 与置顶都按**原条目**操作 —— 折叠只影响展示。
 */
function PendingRow({
  entry,
  peekId,
  peekText,
  onPeek,
  onPin,
  fold,
}: {
  entry: AgentInboxEntry;
  peekId: string | null;
  peekText: string | null;
  onPeek: (entry: AgentInboxEntry) => void;
  onPin: (entry: AgentInboxEntry) => void;
  /** 组头才传：组内条数、开合状态与切换。 */
  fold?: { count: number; open: boolean; onToggle: () => void };
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-2 text-xs">
        <span className="flex-none font-mono text-2xs text-faint">
          {entry.status === 'held' ? t('chat.pending.held') : t('chat.pending.unread')}
        </span>
        <span className="flex-none font-mono text-2xs text-accent">{entry.from}</span>
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-muted hover:text-ink"
          onClick={() => (fold ? fold.onToggle() : onPeek(entry))}
          aria-expanded={fold ? fold.open : peekId === entry.message_id}
        >
          {entry.summary}
        </button>
        {fold && (
          <button
            type="button"
            className="flex-none font-mono text-2xs text-faint hover:text-ink"
            onClick={fold.onToggle}
            aria-expanded={fold.open}
          >
            {t('chat.pending.sameSource', { count: fold.count })}
          </button>
        )}
        <Button variant="link" className="flex-none text-xs" onClick={() => onPin(entry)}>
          {t('chat.pending.pin')}
        </Button>
      </div>
      {peekId === entry.message_id && (
        <p className="m-0 min-w-0 break-words whitespace-pre-wrap wrap-anywhere rounded-sm bg-raised px-2 py-1 text-xs text-muted">
          {peekText ?? t('chat.pending.peeking')}
        </p>
      )}
    </div>
  );
}

export function PendingStrip({
  client,
  agentId,
  enabled,
  refreshKey,
}: {
  client: GatewayClient;
  /** 当前会话对应的 agent（inbox 按 agent 维度）。 */
  agentId: string | null;
  /** 有连接且已选中会话时才取数。 */
  enabled: boolean;
  /** 事件驱动的失效键（agent.message.* / run.started 的计数）。 */
  refreshKey: number;
}) {
  const toast = useToast();
  const [peekId, setPeekId] = useState<string | null>(null);
  const [peekText, setPeekText] = useState<string | null>(null);
  const [pinTarget, setPinTarget] = useState<AgentInboxEntry | null>(null);
  const [pinning, setPinning] = useState(false);
  /** 同源折叠组的展开状态（只影响展示：组内条目各自仍是真实 inbox 条目）。 */
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());

  const resource = useResource<AgentInboxEntry[]>({
    load: async () => {
      if (!agentId) return [];
      const snapshot = await client.inbox({ agent_id: agentId, include_held: true });
      return Array.isArray(snapshot?.entries) ? snapshot.entries : [];
    },
    enabled: enabled && agentId !== null,
    deps: [agentId, refreshKey],
  });
  const state = resource.state;
  const entries = resourceData(state) ?? [];
  const view = useMemo(() => pendingStripView(entries), [entries]);

  const peek = useCallback(
    async (entry: AgentInboxEntry) => {
      if (!agentId) return;
      if (peekId === entry.message_id) {
        setPeekId(null);
        setPeekText(null);
        return;
      }
      setPeekId(entry.message_id);
      setPeekText(null);
      try {
        const snapshot = await client.inbox({
          agent_id: agentId,
          include_held: true,
          message_ids: [entry.message_id],
        });
        const hit = snapshot?.entries?.find((item) => item.message_id === entry.message_id);
        setPeekText(hit?.text ?? entry.summary);
      } catch {
        setPeekText(entry.summary);
      }
    },
    [agentId, client, peekId],
  );

  const confirmPin = useCallback(async () => {
    if (!agentId || !pinTarget || pinning) return;
    setPinning(true);
    try {
      const result = await client.pinInboxMessage(agentId, pinTarget.message_id);
      if (result.ok) {
        toast.success(t('chat.pending.pinDone'));
      } else {
        toast.error(pinFailureMessage(result.code));
      }
    } catch {
      toast.error(pinFailureMessage(undefined));
    } finally {
      setPinning(false);
      setPinTarget(null);
    }
  }, [agentId, client, pinTarget, pinning, toast]);

  /** 折叠组开合：与 peek / 置顶无关，不触发任何 RPC。 */
  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (view.total === 0) return null;

  return (
    <section
      className="pending-strip mb-2 flex w-full min-w-0 flex-col gap-1.5 rounded-md bg-sunken px-3 py-2 text-sm"
      aria-label={t('chat.pending.title', { count: view.total })}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium text-ink">
          {t('chat.pending.title', { count: view.total })}
        </span>
      </div>

      <ul className="m-0 flex min-w-0 list-none flex-col gap-1 p-0">
        {view.preview.map((stripGroup) => {
          const folded = stripGroup.entries.length > 1;
          const open = folded && expandedGroups.has(stripGroup.key);
          return (
            <li key={stripGroup.key} className="flex min-w-0 flex-col gap-0.5">
              <PendingRow
                entry={stripGroup.head}
                peekId={peekId}
                peekText={peekText}
                onPeek={(entry) => void peek(entry)}
                onPin={(entry) => setPinTarget(entry)}
                fold={
                  folded
                    ? {
                        count: stripGroup.entries.length,
                        open,
                        onToggle: () => toggleGroup(stripGroup.key),
                      }
                    : undefined
                }
              />
              {/* 展开后逐条列出：仍是原来那些条目，peek / 置顶按各自 message_id 操作。 */}
              {open && (
                <ul className="m-0 ml-2 flex min-w-0 list-none flex-col gap-1 border-l border-line pl-2">
                  {stripGroup.entries.map((entry) => (
                    <li key={entry.message_id} className="min-w-0">
                      <PendingRow
                        entry={entry}
                        peekId={peekId}
                        peekText={peekText}
                        onPeek={(item) => void peek(item)}
                        onPin={(item) => setPinTarget(item)}
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
        <p className="m-0 text-2xs text-faint">{t('chat.pending.more', { count: view.hidden })}</p>
      )}
      <p className="m-0 text-2xs text-faint">{t('chat.pending.footer')}</p>

      {pinTarget && (
        <ConfirmDialog
          title={t('chat.pending.pinConfirmTitle')}
          body={t('chat.pending.pinConfirmBody')}
          confirmLabel={t('chat.pending.pinConfirmOk')}
          busy={pinning}
          onConfirm={() => void confirmPin()}
          onCancel={() => {
            if (!pinning) setPinTarget(null);
          }}
        />
      )}
    </section>
  );
}
