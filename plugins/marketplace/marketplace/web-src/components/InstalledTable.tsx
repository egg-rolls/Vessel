import { Badge, Button, DataTable, type DataTableColumn } from '@vessel-agent/plugin-ui';
import type { Translator } from '../i18n';
import type { InstalledItem } from '../types';

/** Shared table for "My plugins" and "Updates". */
export function InstalledTable({
  items,
  t,
  busy,
  onUpdate,
  onRemove,
}: {
  items: readonly InstalledItem[];
  t: Translator;
  busy: boolean;
  onUpdate: (item: InstalledItem) => void;
  onRemove: (item: InstalledItem) => void;
}) {
  const columns: DataTableColumn<InstalledItem>[] = [
    {
      key: 'plugin',
      header: t('th.plugin'),
      cell: (item) => (
        <div className="min-w-0">
          <div className="text-ink wrap-anywhere">{item.name || item.id}</div>
          <div className="font-mono text-xs text-muted">{item.id}</div>
        </div>
      ),
    },
    {
      key: 'version',
      header: t('th.version'),
      cell: (item) => <span className="font-mono text-sm text-ink">{item.version}</span>,
    },
    {
      key: 'scope',
      header: t('th.scope'),
      hide: 'compact',
      cell: (item) => (
        <Badge tone={item.scope === 'builtin' ? 'info' : 'neutral'}>
          {t(`scope.${item.scope}`)}
        </Badge>
      ),
    },
    {
      key: 'enabled',
      header: t('th.enabled'),
      cell: (item) => (
        <Badge tone={item.enabled ? 'success' : 'warn'}>
          {item.enabled ? t('badge.enabled') : t('badge.disabled')}
        </Badge>
      ),
    },
    {
      key: 'latest',
      header: t('th.latest'),
      hide: 'wide',
      cell: (item) => (
        <span
          className={
            item.update_available ? 'font-mono text-sm text-warn' : 'font-mono text-sm text-muted'
          }
        >
          {item.latest ?? '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('th.actions'),
      cellClassName: 'text-right',
      cell: (item) =>
        item.scope === 'builtin' ? null : (
          <div className="flex justify-end gap-2">
            {item.update_available === true ? (
              <Button size="small" variant="primary" disabled={busy} onClick={() => onUpdate(item)}>
                {t('button.update')}
              </Button>
            ) : null}
            <Button
              size="small"
              variant="dangerGhost"
              disabled={busy}
              onClick={() => onRemove(item)}
            >
              {t('button.remove')}
            </Button>
          </div>
        ),
    },
  ];

  return (
    <div className="overflow-hidden rounded-md shadow-elev-1">
      <DataTable columns={columns} rows={items} rowKey={(item) => item.id} />
    </div>
  );
}
