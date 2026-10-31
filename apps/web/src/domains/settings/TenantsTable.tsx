import { StatusChip } from '../../components/StatusChip';
import { Badge, Button, DataTable } from '../../components/ui';
import type { TenantInfo } from '../../gateway/types';
import { t } from '../../i18n';
import { formatQuota } from './tenantsShared';

export function TenantsTable({
  tenants,
  currentTenantId,
  connected,
  onSwitch,
  onEdit,
}: {
  tenants: TenantInfo[];
  currentTenantId: string | null;
  connected: boolean;
  onSwitch: (tenant: TenantInfo) => void;
  onEdit: (tenant: TenantInfo) => void;
}) {
  return (
    <DataTable
      activeKey={currentTenantId ?? undefined}
      columns={[
        {
          key: 'tenant',
          header: t('settings.tenants.col.tenant'),
          cellClassName: 'font-mono',
          cell: (tenant) => (
            <>
              {tenant.tenant_id}
              {tenant.tenant_id === currentTenantId && (
                <Badge className="ml-1.5">{t('settings.tenants.current')}</Badge>
              )}
            </>
          ),
        },
        {
          key: 'name',
          header: t('settings.tenants.col.name'),
          cell: (tenant) => tenant.name ?? '—',
        },
        {
          key: 'status',
          header: t('settings.tenants.col.status'),
          cell: (tenant) => (
            <StatusChip
              status={tenant.status === 'active' ? 'running' : 'disabled'}
              label={t(
                tenant.status === 'active'
                  ? 'settings.tenants.enabled'
                  : 'settings.tenants.disabled',
              )}
            />
          ),
        },
        {
          key: 'created',
          header: t('settings.tenants.col.created'),
          hide: 'compact',
          cellClassName: 'font-mono',
          cell: (tenant) =>
            tenant.created_at ? new Date(tenant.created_at).toLocaleString() : '—',
        },
        {
          key: 'quota',
          header: t('settings.tenants.col.quota'),
          hide: 'compact',
          cellClassName: 'font-mono text-muted',
          cell: (tenant) => formatQuota(tenant.quota),
        },
        {
          key: 'usage',
          header: t('settings.tenants.col.usage'),
          hide: 'compact',
          cellClassName: 'font-mono text-muted',
          cell: (tenant) => formatQuota(tenant.usage),
        },
        {
          key: 'actions',
          header: t('settings.tenants.col.actions'),
          cell: (tenant) => {
            const active = tenant.tenant_id === currentTenantId;
            return (
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="small"
                  disabled={!connected || tenant.status !== 'active' || active}
                  title={!connected ? t('common.writesDisabled') : undefined}
                  onClick={() => onSwitch(tenant)}
                >
                  {active
                    ? t('settings.tenants.currentTenantAction')
                    : t('settings.tenants.switch')}
                </Button>
                <Button size="small" disabled={!connected} onClick={() => onEdit(tenant)}>
                  {t('common.edit')}
                </Button>
              </div>
            );
          },
        },
      ]}
      rows={tenants}
      rowKey={(tenant) => tenant.tenant_id}
    />
  );
}
