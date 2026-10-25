/**
 * 已失效交互（run 已结束 / 进程重启）的非阻塞提示。
 *
 * 只读：不渲染 allow / deny / submit，也不复用 permission-card / ask-card，
 * 避免用户点击后必然收到 `run_ended`。
 */
import { Button } from '../../components/ui';
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
      <span className="text-faint">{t('interaction.orphaned')}</span>
      <span className="font-mono text-xs text-faint">
        {item.kind === 'permission'
          ? t('interaction.orphaned.metaTool', { tool: item.tool ?? 'tool' })
          : t('interaction.orphaned.metaAsk')}
        {' · '}
        {t('pending.run', { id: shortId(item.runId) })}
      </span>
      <Button
        type="button"
        variant="link"
        className="ml-auto"
        onClick={() => onDismiss(item.requestId)}
      >
        {t('common.close')}
      </Button>
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
    <div
      className="flex flex-col gap-1 w-full max-w-[var(--dock-width)] mx-auto mb-2"
      role="status"
      aria-label={t('interaction.orphaned.listLabel')}
    >
      {items.map((item) => (
        <OrphanedNoticeRow key={item.requestId} item={item} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
