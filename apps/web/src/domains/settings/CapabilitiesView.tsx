import { useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { SegmentedTabs } from '../../components/Tabs';
import { Badge, DataTable, SearchInput, Section, Stat } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t, useLocale } from '../../i18n';
import {
  CAPABILITY_TABS,
  type CapabilityTab,
  capabilityCounts,
  capabilityTabLabel,
  filterCapabilities,
  groupMethodsByPermission,
} from '../../state/capabilities';
import { resourceData, useResource } from '../../state/useResource';

export function CapabilitiesView() {
  useLocale();
  const { client, connectionState, hasToken, epoch } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const [tab, setTab] = useState<CapabilityTab>('methods');
  const [query, setQuery] = useState('');

  const resource = useResource({
    load: () => client.getCapabilities(),
    enabled: hasToken,
    deps: [epoch],
  });

  useRefreshSignal(resource.reload);
  const manifest = resourceData(resource.state);
  const counts = useMemo(() => (manifest ? capabilityCounts(manifest) : null), [manifest]);
  const result = useMemo(
    () => (manifest ? filterCapabilities(manifest, { tab, query }) : null),
    [manifest, tab, query],
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
  if (resource.state.status === 'idle' || (resource.state.status === 'loading' && !manifest)) {
    return <LoadingState label={t('capabilities.loading')} />;
  }
  if (!manifest) {
    return (
      <ErrorState
        message={
          resource.state.status === 'error' ? resource.state.error : t('capabilities.noManifest')
        }
        onRetry={resource.reload}
      />
    );
  }

  const tabs = CAPABILITY_TABS.map((entry) => ({
    id: entry.id,
    label: counts ? capabilityTabLabel(entry.id, counts) : t(entry.labelKey),
  }));

  return (
    <div className="flex flex-col gap-6">
      {!connected && <StaleNotice message={t('capabilities.stale')} onRetry={resource.reload} />}
      {resource.state.status === 'error' && (
        <StaleNotice
          message={t('common.staleData', { detail: resource.state.error })}
          onRetry={resource.reload}
        />
      )}
      <Section
        title={t('capabilities.title')}
        actions={
          <span className="font-mono text-md text-muted">
            v{manifest.version} · schema {manifest.config_schema_version}
          </span>
        }
      >
        {counts && (
          <div className="my-3 flex flex-wrap gap-2.5">
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
        <SegmentedTabs
          label={t('capabilities.tabsLabel')}
          tabs={tabs}
          value={tab}
          onChange={setTab}
        />
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
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
        </div>
      </Section>

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
        >
          {result && result.plugins.length === 0 ? (
            <p className="text-md text-muted">{t('capabilities.noMatchPlugins')}</p>
          ) : (
            <ul className="plain-list">
              {result?.plugins.map((plugin) => (
                <li key={plugin.name}>
                  <span className="font-mono">{plugin.name}</span>
                  <span className={`perm-badge ${plugin.enabled ? 'perm-read' : ''}`}>
                    {plugin.enabled ? t('capabilities.enabled') : t('capabilities.disabled')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}
