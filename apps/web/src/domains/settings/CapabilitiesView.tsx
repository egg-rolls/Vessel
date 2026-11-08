import { TableToolbar } from '@vessel-agent/plugin-ui';
import { useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { SegmentedTabs } from '../../components/Tabs';
import { Badge, DataTable, SearchInput, Section, Stat } from '../../components/ui';
import { fetchPluginCatalog } from '../../domains/plugins/plugin-catalog';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t, useLocale } from '../../i18n';
import {
  CAPABILITY_TABS,
  type CapabilityTab,
  type CatalogPluginRow,
  capabilityCounts,
  capabilityTabLabel,
  catalogRowsFromItems,
  catalogRowsFromManifest,
  filterCapabilities,
  groupMethodsByPermission,
} from '../../state/capabilities';
import { resourceData, useResource } from '../../state/useResource';
import { useConfigStoreApi } from '../../stores/useConfigStoreApi';

export function CapabilitiesView() {
  useLocale();
  const { client, connectionState, hasToken, epoch } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const [tab, setTab] = useState<CapabilityTab>('methods');
  const [query, setQuery] = useState('');

  const { capabilities, reloadCapabilities } = useConfigStoreApi({
    config: false,
    capabilities: true,
  });
  // CONTRACT-0.47 §5：插件 tab / 计数以 catalog 为主数据源；
  // catalog 不可用时回退 `manifest.plugins`（同一运行时源），不扫盘。
  const catalog = useResource({
    load: () => fetchPluginCatalog(client),
    enabled: hasToken && connectionState === 'open',
    deps: [epoch, connectionState],
  });

  useRefreshSignal(reloadCapabilities);
  useRefreshSignal(catalog.reload);
  const manifest = resourceData(capabilities);
  const catalogItems = catalog.state.status === 'success' ? catalog.state.data : undefined;
  const catalogUnavailable = catalog.state.status === 'success' && catalogItems === null;
  const pluginRows = useMemo<CatalogPluginRow[]>(() => {
    if (Array.isArray(catalogItems)) return catalogRowsFromItems(catalogItems);
    return manifest ? catalogRowsFromManifest(manifest.plugins) : [];
  }, [catalogItems, manifest]);
  const counts = useMemo(
    () => (manifest ? capabilityCounts(manifest, pluginRows) : null),
    [manifest, pluginRows],
  );
  const result = useMemo(
    () => (manifest ? filterCapabilities(manifest, pluginRows, { tab, query }) : null),
    [manifest, pluginRows, tab, query],
  );
  const methodGroups = useMemo(
    () => (result ? groupMethodsByPermission(result.methods) : []),
    [result],
  );

  if (!hasToken) {
    return (
      <NotEnabledState title={t('common.notConnected')} reason={t('capabilities.noTokenReason')} />
    );
  }
  if (capabilities.status === 'idle' || (capabilities.status === 'loading' && !manifest)) {
    return <LoadingState label={t('capabilities.loading')} />;
  }
  if (!manifest) {
    return (
      <ErrorState
        message={
          capabilities.status === 'error' ? capabilities.error : t('capabilities.noManifest')
        }
        onRetry={reloadCapabilities}
      />
    );
  }

  const tabs = CAPABILITY_TABS.map((entry) => ({
    id: entry.id,
    label: counts ? capabilityTabLabel(entry.id, counts) : t(entry.labelKey),
  }));

  return (
    <div className="flex flex-col gap-6">
      {!connected && <StaleNotice message={t('capabilities.stale')} onRetry={reloadCapabilities} />}
      {capabilities.status === 'error' && (
        <StaleNotice
          message={t('common.staleData', { detail: capabilities.error })}
          onRetry={reloadCapabilities}
        />
      )}
      {catalogUnavailable && (
        <StaleNotice message={t('capabilities.catalogUnavailable')} onRetry={catalog.reload} />
      )}
      <div className="flex flex-col gap-3">
        {counts && (
          <div className="flex flex-wrap gap-2.5">
            <Stat
              className="min-w-40 flex-1"
              value={counts.methods}
              label={t('capabilities.methodsCount', {
                read: counts.read,
                write: counts.write,
                admin: counts.admin,
              })}
            />
            <Stat
              className="min-w-40 flex-1"
              value={counts.tools}
              label={t('capabilities.tools')}
            />
            <Stat
              className="min-w-40 flex-1"
              value={`${counts.enabledPlugins}/${counts.plugins}`}
              label={t('capabilities.pluginsEnabled')}
            />
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SegmentedTabs
            label={t('capabilities.tabsLabel')}
            tabs={tabs}
            value={tab}
            onChange={setTab}
          />
          <span className="font-mono text-md text-muted">
            v{manifest.version} · schema {manifest.config_schema_version}
          </span>
        </div>
        <TableToolbar label={t('capabilities.searchLabel')}>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t(`capabilities.search.${tab}`)}
            ariaLabel={t('capabilities.searchLabel')}
            className="grow basis-60 max-w-search"
          />
          <Badge>
            {tab === 'methods'
              ? result?.methods.length
              : tab === 'tools'
                ? result?.tools.length
                : result?.plugins.length}
          </Badge>
        </TableToolbar>
      </div>

      {tab === 'methods' &&
        (methodGroups.length === 0 ? (
          <p className="text-md text-muted">{t('capabilities.noMatchMethods')}</p>
        ) : (
          methodGroups.map((group) => (
            <Section
              key={group.permission}
              titleAs="h3"
              title={
                <>
                  {t('capabilities.methodsTitle', { permission: group.permission })}{' '}
                  <Badge>{group.methods.length}</Badge>
                </>
              }
            >
              <DataTable
                columns={[
                  {
                    key: 'method',
                    header: t('capabilities.col.method'),
                    cellClassName: 'font-mono',
                    cell: (method) => method.name,
                  },
                  {
                    key: 'permission',
                    header: t('capabilities.col.permission'),
                    cell: () => (
                      <span className={`perm-badge perm-${group.permission}`}>
                        {group.permission}
                      </span>
                    ),
                  },
                ]}
                rows={group.methods}
                rowKey={(method) => method.name}
              />
            </Section>
          ))
        ))}

      {tab === 'tools' && (
        <Section
          title={
            <>
              {t('capabilities.toolsTitle')} <Badge>{result?.tools.length ?? 0}</Badge>
            </>
          }
        >
          {result && result.tools.length === 0 ? (
            <p className="text-md text-muted">{t('capabilities.noMatchTools')}</p>
          ) : (
            <ul className="plain-list">
              {result?.tools.map((tool) => (
                <li key={tool.name}>
                  <span className="font-mono">{tool.name}</span>
                  {tool.description && <span className="text-muted"> — {tool.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {tab === 'plugins' && (
        <Section
          title={
            <>
              {t('capabilities.pluginsTitle')} <Badge>{result?.plugins.length ?? 0}</Badge>
            </>
          }
          description={t('capabilities.pluginsDescription')}
        >
          {result && result.plugins.length === 0 ? (
            <p className="text-md text-muted">{t('capabilities.noMatchPlugins')}</p>
          ) : (
            <DataTable
              columns={[
                {
                  key: 'plugin',
                  header: t('capabilities.col.plugin'),
                  cell: (plugin) => (
                    <>
                      <span className="font-mono">{plugin.name}</span>
                      {plugin.version && (
                        <span className="ml-1.5 text-sm text-muted">{plugin.version}</span>
                      )}
                    </>
                  ),
                },
                {
                  key: 'scope',
                  header: t('capabilities.col.scope'),
                  hide: 'compact',
                  cell: (plugin) =>
                    plugin.scope ? <Badge>{t(`capabilities.scope.${plugin.scope}`)}</Badge> : '—',
                },
                {
                  key: 'mode',
                  header: t('capabilities.col.mode'),
                  hide: 'wide',
                  cell: (plugin) =>
                    plugin.mode ? (
                      <Badge tone={plugin.mode === 'in-process' ? 'neutral' : 'info'}>
                        {t(`capabilities.mode.${plugin.mode}`)}
                      </Badge>
                    ) : (
                      '—'
                    ),
                },
                {
                  key: 'state',
                  header: t('capabilities.col.state'),
                  cell: (plugin) => (
                    <Badge tone={plugin.enabled ? 'success' : 'neutral'}>
                      {t(plugin.enabled ? 'capabilities.enabled' : 'capabilities.disabled')}
                    </Badge>
                  ),
                },
                {
                  key: 'restart',
                  header: t('capabilities.col.restart'),
                  hide: 'compact',
                  cell: (plugin) =>
                    plugin.restartRequired ? (
                      <Badge tone="warn">{t('capabilities.restartRequired')}</Badge>
                    ) : (
                      '—'
                    ),
                },
              ]}
              rows={result?.plugins ?? []}
              rowKey={(plugin) => plugin.id}
            />
          )}
        </Section>
      )}
    </div>
  );
}
