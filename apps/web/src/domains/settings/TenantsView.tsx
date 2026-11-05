import { useEffect, useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { usePaletteEntities } from '../../components/PaletteEntities';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { useToast } from '../../components/ToastProvider';
import { Button, SearchInput } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { TenantInfo } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { buildTenantPaletteActions } from '../../state/palette-actions';
import { resourceData } from '../../state/useResource';
import { useTenantStore } from '../../stores/tenantStore';
import { usePolledAction } from '../../stores/usePolledAction';
import { TenantCreateDialog, TenantEditDialog } from './TenantDialogs';
import { TenantsTable } from './TenantsTable';
import { isForbidden } from './tenantsShared';

/** Settings → Tenants：只有 tenants.list 成功（admin）才显示管理动作。 */
export function TenantsView() {
  const {
    client,
    connectionState,
    hasToken,
    features,
    epoch,
    tenantId,
    gatewayUrl,
    token,
    connect,
  } = useConnection();
  useLocale();
  const toast = useToast();
  const connected = hasToken && connectionState === 'open';
  const available = hasToken && features.includes('tenants');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<TenantInfo | null>(null);
  const [query, setQuery] = useState('');

  const tenantState = useTenantStore((state) => state.tenants);
  const loadTenants = useTenantStore((state) => state.loadTenants);
  const selectTenant = useTenantStore((state) => state.select);
  const reloadTenants = () => {
    if (available) void loadTenants(client);
  };
  usePolledAction(reloadTenants, { enabled: available, deps: [epoch] });
  useRefreshSignal(reloadTenants);
  const tenants = resourceData(tenantState);
  const filteredTenants = useMemo(() => {
    const list = tenants ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (tenant) =>
        tenant.tenant_id.toLowerCase().includes(needle) ||
        (tenant.name ?? '').toLowerCase().includes(needle),
    );
  }, [tenants, query]);

  // ConnectionProvider stays the tenant-switch authority; mirror its id here.
  useEffect(() => {
    selectTenant(tenantId);
  }, [tenantId, selectTenant]);

  const paletteActions = useMemo(
    () =>
      tenants
        ? buildTenantPaletteActions({
            tenants,
            currentTenantId: tenantId,
            switchTenant: (nextTenantId) => {
              const ok = connect({ gatewayUrl, token, tenantId: nextTenantId });
              if (ok) {
                toast.info(t('settings.tenants.switching', { tenant: nextTenantId }));
              }
            },
          })
        : [],
    [tenants, tenantId, connect, gatewayUrl, token, toast],
  );
  usePaletteEntities('settings-tenants', paletteActions);

  if (!hasToken) {
    return (
      <NotEnabledState
        title={t('common.notConnected')}
        reason={t('settings.tenants.noTokenReason')}
      />
    );
  }
  if (!features.includes('tenants')) {
    return (
      <NotEnabledState
        title={t('settings.tenants.disabledTitle')}
        reason={t('settings.tenants.disabledReason')}
        hint={t('settings.tenants.disabledHint')}
      />
    );
  }
  if (tenantState.status === 'error' && isForbidden(tenantState.code, tenantState.error)) {
    return (
      <NotEnabledState
        title={t('settings.tenants.adminTitle')}
        reason={t('settings.tenants.adminReason')}
        hint={t('settings.tenants.currentTenant', { tenant: tenantId ?? '—' })}
      />
    );
  }
  if (tenantState.status === 'idle' || (tenantState.status === 'loading' && !tenants)) {
    return <LoadingState label={t('settings.tenants.loading')} />;
  }
  if (!tenants) {
    return (
      <ErrorState
        message={tenantState.status === 'error' ? tenantState.error : t('settings.tenants.noData')}
        onRetry={reloadTenants}
      />
    );
  }

  const switchTenant = (tenant: TenantInfo) => {
    if (tenant.tenant_id === tenantId) return;
    if (!connected) {
      toast.error(t('settings.tenants.switchDisconnected'));
      return;
    }
    if (tenant.status !== 'active') {
      toast.error(t('settings.tenants.switchDisabled'));
      return;
    }
    const ok = connect({ gatewayUrl, token, tenantId: tenant.tenant_id });
    if (ok) toast.info(t('settings.tenants.switching', { tenant: tenant.tenant_id }));
  };

  const error = tenantState.status === 'error' ? tenantState.error : null;

  return (
    <div className="flex flex-col gap-4">
      {!connected && (
        <StaleNotice message={t('settings.tenants.disconnected')} onRetry={reloadTenants} />
      )}
      {error && (
        <StaleNotice message={t('common.staleData', { detail: error })} onRetry={reloadTenants} />
      )}
      <div className="net-toolbar mt-3.5">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={t('settings.tenants.searchPlaceholder')}
          ariaLabel={t('settings.tenants.searchLabel')}
          className="grow basis-60 max-w-search"
        />
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="primary"
            size="small"
            disabled={!connected}
            title={!connected ? t('common.writesDisabled') : undefined}
            onClick={() => setCreateOpen(true)}
          >
            {t('settings.tenants.new')}
          </Button>
          <Button size="small" onClick={reloadTenants}>
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {tenants.length === 0 ? (
        <EmptyState title={t('settings.tenants.empty')} />
      ) : filteredTenants.length === 0 ? (
        <EmptyState
          title={t('settings.tenants.noMatch')}
          action={<Button onClick={() => setQuery('')}>{t('common.clearSearch')}</Button>}
        />
      ) : (
        <TenantsTable
          tenants={filteredTenants}
          currentTenantId={tenantId}
          connected={connected}
          onSwitch={switchTenant}
          onEdit={setEditing}
        />
      )}

      {createOpen && (
        <TenantCreateDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            reloadTenants();
          }}
        />
      )}
      {editing && (
        <TenantEditDialog
          tenant={editing}
          onClose={() => setEditing(null)}
          onUpdated={() => {
            setEditing(null);
            reloadTenants();
          }}
        />
      )}
    </div>
  );
}
