import { Button, TableToolbar } from '@vessel-agent/plugin-ui';
import { useState } from 'react';
import { describeError, type MarketplaceApi } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InstalledTable } from '../components/InstalledTable';
import { RegistryBanners } from '../components/RegistryBanners';
import { RegistryErrorNote } from '../components/RegistrySetup';
import { Banner, EmptyState } from '../components/States';
import { SCOPE_MESSAGE_KEY, type Translator } from '../i18n';
import type { CatalogRow, RegistryMeta, StartJobResult } from '../types';

export function InstalledView({
  api,
  t,
  busy,
  onJob,
  catalogAvailable,
  rows,
  registry,
  registryError,
  onRefresh,
  onChanged,
}: {
  api: MarketplaceApi;
  t: Translator;
  busy: boolean;
  onJob: (label: string, start: () => Promise<StartJobResult>) => Promise<void>;
  catalogAvailable: boolean;
  rows: readonly CatalogRow[];
  registry?: RegistryMeta;
  registryError?: string;
  onRefresh: () => void;
  onChanged: () => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<CatalogRow | null>(null);
  const [pendingToggle, setPendingToggle] = useState<CatalogRow | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const removeItem = async (item: CatalogRow) => {
    setActionError(null);
    try {
      await api.remove(item.id);
      onChanged();
    } catch (caught) {
      setActionError(describeError(caught, t));
    }
  };

  const applyToggle = async (item: CatalogRow) => {
    setActionError(null);
    setTogglingId(item.id);
    try {
      await api.setEnabled(item.id, !item.enabled);
      onChanged();
    } catch (caught) {
      setActionError(describeError(caught, t));
    } finally {
      setTogglingId(null);
    }
  };

  // Disabling the marketplace itself unloads this page; confirm first.
  const toggleItem = (item: CatalogRow) => {
    if (item.id === 'marketplace' && item.enabled) {
      setPendingToggle(item);
      return;
    }
    void applyToggle(item);
  };

  return (
    <div className="flex flex-col gap-3">
      <TableToolbar label={t('installed.toolbar')} className="justify-end">
        <Button onClick={onRefresh}>{t('button.refresh')}</Button>
      </TableToolbar>

      <RegistryBanners registry={registry} t={t} />
      {registryError !== undefined ? <RegistryErrorNote message={registryError} t={t} /> : null}
      {actionError !== null ? <Banner tone="danger">{actionError}</Banner> : null}

      {!catalogAvailable ? (
        <EmptyState title={t('catalog.unavailable')} detail={t('catalog.unavailableDetail')} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('installed.empty')} detail={t('installed.emptyDetail')} />
      ) : (
        <InstalledTable
          items={rows}
          t={t}
          busy={busy}
          pendingId={togglingId}
          onToggle={toggleItem}
          onUpdate={(item) =>
            void onJob(`${t('button.update')} ${item.name || item.id}`, () => api.update(item.id))
          }
          onRemove={(item) => setPendingRemove(item)}
        />
      )}

      <ConfirmDialog
        open={pendingToggle !== null}
        title={t('dialog.disableMarketplace.title')}
        confirmLabel={t('dialog.disableMarketplace.confirm')}
        confirmText={t('dialog.disableMarketplace.check')}
        cancelLabel={t('button.cancel')}
        danger
        onCancel={() => setPendingToggle(null)}
        onConfirm={() => {
          if (pendingToggle === null) return;
          const item = pendingToggle;
          setPendingToggle(null);
          void applyToggle(item);
        }}
      >
        <p className="text-md text-ink wrap-anywhere">{t('dialog.disableMarketplace.body')}</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingRemove !== null}
        title={t('dialog.remove.title')}
        confirmLabel={t('dialog.remove.confirm')}
        confirmText={
          pendingRemove !== null
            ? t('dialog.remove.check', { name: pendingRemove.name || pendingRemove.id })
            : ''
        }
        cancelLabel={t('button.cancel')}
        danger
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          if (pendingRemove === null) return;
          const item = pendingRemove;
          setPendingRemove(null);
          void removeItem(item);
        }}
      >
        {pendingRemove !== null ? (
          <p className="text-md text-ink wrap-anywhere">
            {t('remove.body', {
              name: pendingRemove.name || pendingRemove.id,
              version: pendingRemove.version,
              path: pendingRemove.path,
              scope: t(SCOPE_MESSAGE_KEY[pendingRemove.scope]),
            })}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
