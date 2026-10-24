import { useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { SegmentedTabs } from '../../components/Tabs';
import { SearchInput } from '../../components/ui';
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
    <div className="settings-section">
      {!connected && <StaleNotice message={t('capabilities.stale')} onRetry={resource.reload} />}
      {resource.state.status === 'error' && (
        <StaleNotice
          message={t('common.staleData', { detail: resource.state.error })}
          onRetry={resource.reload}
        />
      )}
      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">{t('capabilities.title')}</h2>
          <span className="mono dim">
            v{manifest.version} · schema {manifest.config_schema_version}
          </span>
        </div>
        {counts && (
          <div className="stats-grid">
            <div className="stat">
              <span className="stat-value">{counts.methods}</span>
              <span className="stat-label">
                {t('capabilities.methodsCount', {
                  read: counts.read,
                  write: counts.write,
                  admin: counts.admin,
                })}
              </span>
            </div>
            <div className="stat">
              <span className="stat-value">{counts.tools}</span>
              <span className="stat-label">{t('capabilities.tools')}</span>
            </div>
            <div className="stat">
              <span className="stat-value">
                {counts.enabledPlugins}/{counts.plugins}
              </span>
              <span className="stat-label">{t('capabilities.pluginsEnabled')}</span>
            </div>
          </div>
        )}
        <SegmentedTabs
          label={t('capabilities.tabsLabel')}
          tabs={tabs}
          value={tab}
          onChange={setTab}
        />
        <div className="filter-bar">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t(`capabilities.search.${tab}`)}
            ariaLabel={t('capabilities.searchLabel')}
          />
          <span className="count-pill">
            {tab === 'methods'
              ? result?.methods.length
              : tab === 'tools'
                ? result?.tools.length
                : result?.plugins.length}
          </span>
        </div>
      </section>

      {tab === 'methods' &&
        (methodGroups.length === 0 ? (
          <p className="section-desc">{t('capabilities.noMatchMethods')}</p>
        ) : (
          methodGroups.map((group) => (
            <section className="panel" key={group.permission}>
              <h3 className="section-title">
                {t('capabilities.methodsTitle', { permission: group.permission })}{' '}
                <span className="count-pill">{group.methods.length}</span>
              </h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t('capabilities.col.method')}</th>
                    <th scope="col">{t('capabilities.col.permission')}</th>
                  </tr>
                </thead>
                <tbody>
                  {group.methods.map((method) => (
                    <tr key={method.name}>
                      <td className="mono">{method.name}</td>
                      <td>
                        <span className={`perm-badge perm-${group.permission}`}>
                          {group.permission}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))
        ))}

      {tab === 'tools' && (
        <section className="panel">
          <h2 className="section-title">
            {t('capabilities.toolsTitle')}{' '}
            <span className="count-pill">{result?.tools.length ?? 0}</span>
          </h2>
          {result && result.tools.length === 0 ? (
            <p className="section-desc">{t('capabilities.noMatchTools')}</p>
          ) : (
            <ul className="plain-list">
              {result?.tools.map((tool) => (
                <li key={tool.name}>
                  <span className="mono">{tool.name}</span>
                  {tool.description && <span className="dim"> — {tool.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'plugins' && (
        <section className="panel">
          <h2 className="section-title">
            {t('capabilities.pluginsTitle')}{' '}
            <span className="count-pill">{result?.plugins.length ?? 0}</span>
          </h2>
          {result && result.plugins.length === 0 ? (
            <p className="section-desc">{t('capabilities.noMatchPlugins')}</p>
          ) : (
            <ul className="plain-list">
              {result?.plugins.map((plugin) => (
                <li key={plugin.name}>
                  <span className="mono">{plugin.name}</span>
                  <span className={`perm-badge ${plugin.enabled ? 'perm-read' : ''}`}>
                    {plugin.enabled ? t('capabilities.enabled') : t('capabilities.disabled')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
