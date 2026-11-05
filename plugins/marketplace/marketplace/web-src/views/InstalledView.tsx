import { Button } from '@vessel-agent/plugin-ui';
import { useCallback, useEffect, useState } from 'react';
import { describeError, type MarketplaceApi } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InstalledTable } from '../components/InstalledTable';
import { RegistryBanners } from '../components/RegistryBanners';
import { RegistryErrorNote } from '../components/RegistrySetup';
import { Banner, EmptyState, ErrorState, LoadingState } from '../components/States';
import type { Translator } from '../i18n';
import type { InstalledItem, InstalledResult, StartJobResult } from '../types';

export function InstalledView({
  api,
  t,
  refreshToken,
  busy,
  onJob,
  onChanged,
}: {
  api: MarketplaceApi;
  t: Translator;
  refreshToken: number;
  busy: boolean;
  onJob: (label: string, start: () => Promise<StartJobResult>) => Promise<void>;
  onChanged: () => void;
}) {
  const [data, setData] = useState<InstalledResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<InstalledItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.installed());
    } catch (caught) {
      setError(describeError(caught, t));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refreshToken` is an explicit host-refresh trigger, not a value the effect reads.
  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const removeItem = async (item: InstalledItem) => {
    setActionError(null);
    try {
      await api.remove(item.id);
      onChanged();
    } catch (caught) {
      setActionError(describeError(caught, t));
    }
  };

  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button onClick={() => void load()} disabled={loading}>
          {t('button.refresh')}
        </Button>
      </div>

      <RegistryBanners registry={data?.registry} t={t} />
      {data?.registry_error !== undefined ? (
        <RegistryErrorNote message={data.registry_error} t={t} />
      ) : null}
      {actionError !== null ? <Banner tone="danger">{actionError}</Banner> : null}

      {loading ? (
        <LoadingState label={t('state.loading')} />
      ) : error !== null ? (
        <ErrorState message={error} retryLabel={t('button.retry')} onRetry={() => void load()} />
      ) : items.length === 0 ? (
        <EmptyState title={t('installed.empty')} detail={t('installed.emptyDetail')} />
      ) : (
        <InstalledTable
          items={items}
          t={t}
          busy={busy}
          onUpdate={(item) =>
            void onJob(`${t('button.update')} ${item.name || item.id}`, () => api.update(item.id))
          }
          onRemove={(item) => setPendingRemove(item)}
        />
      )}

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
              scope: pendingRemove.scope,
            })}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
