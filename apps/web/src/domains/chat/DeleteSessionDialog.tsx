import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Button } from '../../components/ui';
import type { SessionInfo } from '../../gateway/types';
import { t } from '../../i18n';
import { sessionTitle } from '../../state/sessions';
import type { DeleteCounts } from './useSessionDelete';

/**
 * 删除会话确认：展示消息数、关联 run 计数与服务端拒绝说明；
 * 活动 run 存在时禁用主按钮。
 */
export function DeleteSessionDialog({
  target,
  counts,
  error,
  connected,
  busy,
  onConfirm,
  onCancel,
  onViewRuns,
}: {
  target: SessionInfo;
  counts: DeleteCounts | null;
  error: string | null;
  connected: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onViewRuns: () => void;
}) {
  return (
    <ConfirmDialog
      title={t('chat.delete.title', { title: sessionTitle(target) })}
      body={
        <>
          <p>{t('chat.delete.body')}</p>
          <p className="text-muted">
            {t('chat.delete.counts', { messages: target.message_count })}
            {counts && !counts.loading
              ? t('chat.delete.runsCount', {
                  count: counts.live + counts.durable,
                })
              : counts?.loading
                ? t('chat.delete.counting')
                : ''}
          </p>
          {counts && counts.active > 0 && (
            <p className="text-danger" role="alert">
              {t('chat.delete.activeRuns', { count: counts.active })}
            </p>
          )}
          {counts?.error && (
            <p className="text-muted">{t('chat.delete.statsFailed', { detail: counts.error })}</p>
          )}
          <p className="text-muted">{t('chat.delete.serverReject')}</p>
          {!connected && <p className="text-danger">{t('chat.delete.disconnected')}</p>}
          {error && (
            <p className="text-danger" role="alert">
              {error}
            </p>
          )}
        </>
      }
      confirmLabel={t('chat.delete.confirm')}
      danger
      busy={busy}
      confirmDisabled={!connected || Boolean(counts?.loading) || (counts?.active ?? 0) > 0}
      onConfirm={onConfirm}
      onCancel={onCancel}
      extra={
        error ? (
          <Button type="button" variant="link" onClick={onViewRuns}>
            {t('chat.delete.viewRuns')}
          </Button>
        ) : undefined
      }
    />
  );
}
