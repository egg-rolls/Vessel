/**
 * 待处理条带（只读）：聊天输入区上方的一条摘要，**不进入时间线**。
 *
 * 它回答的是「还有多少消息在等」，不是队列编辑器：
 * - 默认隐藏：没有待处理项时整条不渲染，不占位；
 * - 显示 `待处理 · N` + 前 3 条摘要，其余折叠；
 * - 点某条只 **peek 正文**（`agents.inbox` 带 `message_ids`，服务端不改状态）；
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
        {view.preview.map((entry) => (
          <li key={entry.message_id} className="flex min-w-0 flex-col gap-0.5">
            <div className="flex min-w-0 flex-wrap items-baseline gap-2 text-xs">
              <span className="flex-none font-mono text-2xs text-faint">
                {entry.status === 'held' ? t('chat.pending.held') : t('chat.pending.unread')}
              </span>
              <span className="flex-none font-mono text-2xs text-accent">{entry.from}</span>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-muted hover:text-ink"
                onClick={() => void peek(entry)}
                aria-expanded={peekId === entry.message_id}
              >
                {entry.summary}
              </button>
              <Button
                variant="link"
                className="flex-none text-xs"
                onClick={() => setPinTarget(entry)}
              >
                {t('chat.pending.pin')}
              </Button>
            </div>
            {peekId === entry.message_id && (
              <p className="m-0 min-w-0 break-words whitespace-pre-wrap wrap-anywhere rounded-sm bg-raised px-2 py-1 text-xs text-muted">
                {peekText ?? t('chat.pending.peeking')}
              </p>
            )}
          </li>
        ))}
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
