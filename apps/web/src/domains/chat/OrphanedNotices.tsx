/**
 * 已失效交互（run 已结束 / 进程重启）的非阻塞提示。
 *
 * 只读：不渲染 allow / deny / submit，也不复用 permission-card / ask-card，
 * 避免用户点击后必然收到 `run_ended`。
 */
import type { OrphanedInteraction } from '../../gateway/interaction-hydration';
import { t } from '../../i18n';

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

export function OrphanedNoticeRow({
  item,
  onDismiss,
}: {
  item: OrphanedInteraction;
  onDismiss: (requestId: string) => void;
}) {
  return (
    <div className="orphan-notice">
      <span className="orphan-notice-text">{t('interaction.orphaned')}</span>
      <span className="orphan-notice-meta mono">
        {item.kind === 'permission'
          ? t('interaction.orphaned.metaTool', { tool: item.tool ?? 'tool' })
          : t('interaction.orphaned.metaAsk')}
        {' · '}
        {t('pending.run', { id: shortId(item.runId) })}
      </span>
      <button
        type="button"
        className="link-btn orphan-notice-close"
        onClick={() => onDismiss(item.requestId)}
      >
        {t('common.close')}
      </button>
    </div>
  );
}

export function OrphanedNotices({
  items,
  onDismiss,
}: {
  items: readonly OrphanedInteraction[];
  onDismiss: (requestId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="orphan-notices" role="status" aria-label={t('interaction.orphaned.listLabel')}>
      {items.map((item) => (
        <OrphanedNoticeRow key={item.requestId} item={item} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
