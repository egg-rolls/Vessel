import { Badge, Button, DataTable, type DataTableColumn } from '@vessel-agent/plugin-ui';
import { SCOPE_MESSAGE_KEY, type Translator } from '../i18n';
import type { CatalogRow } from '../types';

/** Shared table for "My plugins" and "Updates"; rows come from the catalog. */
export function InstalledTable({
  items,
  t,
  busy,
  pendingId,
  onToggle,
  onUpdate,
  onRemove,
}: {
  items: readonly CatalogRow[];
  t: Translator;
  busy: boolean;
  /** Row whose `plugins[].enabled` write is in flight. */
  pendingId: string | null;
  onToggle: (item: CatalogRow) => void;
  onUpdate: (item: CatalogRow) => void;
  onRemove: (item: CatalogRow) => void;
}) {
  const columns: DataTableColumn<CatalogRow>[] = [
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
          {t(SCOPE_MESSAGE_KEY[item.scope])}
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
      cell: (item) => {
        const pending = pendingId === item.id;
        // Built-ins ship with the host; they are never installed or updated by
        // the marketplace (CONTRACT-0.47 §4).
        const readOnly = item.scope === 'builtin' || item.kind === 'builtin';
        return (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {item.restartRequired ? (
              <span className="text-xs text-muted">{t('badge.restartRequired')}</span>
            ) : null}
            <Button
              size="small"
              variant={item.enabled ? 'plain' : 'primary'}
              disabled={busy || pending || !item.supportsToggle}
              onClick={() => onToggle(item)}
            >
              {pending
                ? t('button.applying')
                : item.enabled
                  ? t('button.disable')
                  : t('button.enable')}
            </Button>
            {readOnly ? null : (
              <>
                {item.update_available === true ? (
                  <Button
                    size="small"
                    variant="primary"
                    disabled={busy || pending}
                    onClick={() => onUpdate(item)}
                  >
                    {t('button.update')}
                  </Button>
                ) : null}
                <Button
                  size="small"
                  variant="dangerGhost"
                  disabled={busy || pending}
                  onClick={() => onRemove(item)}
                >
                  {t('button.remove')}
                </Button>
              </>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="overflow-hidden rounded-md shadow-elev-1">
      <DataTable columns={columns} rows={items} rowKey={(item) => item.id} />
    </div>
  );
}
