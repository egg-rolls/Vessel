import { useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { CopyButton } from '../../components/CopyButton';
import { JsonView } from '../../components/JsonView';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { SearchInput } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t, useLocale } from '../../i18n';
import { filterConfigEntries, flattenConfig } from '../../state/config';
import { resourceData, useResource } from '../../state/useResource';

export function ConfigView() {
  useLocale();
  const { client, connectionState, hasToken, features, epoch, tenantId } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const available = hasToken && features.includes('config');
  const [query, setQuery] = useState('');

  const resource = useResource({
    load: async () => {
      const [config, sources] = await Promise.all([client.getConfig(), client.getConfigSources()]);
      return { config, sources };
    },
    enabled: available,
    deps: [epoch],
  });
  useRefreshSignal(resource.reload);
  const data = resourceData(resource.state);
  const entries = useMemo(() => (data ? flattenConfig(data.config.config) : []), [data]);
  const filteredEntries = useMemo(() => filterConfigEntries(entries, query), [entries, query]);

  if (!hasToken) {
    return <NotEnabledState title={t('common.notConnected')} reason={t('config.noTokenReason')} />;
  }
  if (!features.includes('config')) {
    return (
      <NotEnabledState
        title={t('config.disabledTitle')}
        reason={t('config.disabledReason')}
        hint={t('config.disabledHint')}
      />
    );
  }
  if (!data) {
    return resource.state.status === 'error' ? (
      <ErrorState message={resource.state.error} onRetry={resource.reload} />
    ) : (
      <LoadingState label={t('config.loading')} />
    );
  }
  const sourceEntries = Object.entries(data.sources.sources);
  const error = resource.state.status === 'error' ? resource.state.error : null;

  return (
    <div className="settings-section">
      {!connected && <StaleNotice message={t('config.stale')} onRetry={resource.reload} />}
      {error && (
        <StaleNotice message={t('common.staleData', { detail: error })} onRetry={resource.reload} />
      )}
      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">{t('config.title')}</h2>
          <CopyButton
            text={JSON.stringify(data.config.config, null, 2)}
            label={t('config.copyJson')}
            toast={t('config.copiedJson')}
          />
          <button type="button" className="btn btn-small" onClick={resource.reload}>
            {t('common.refresh')}
          </button>
        </div>
        <dl className="diag-list">
          <dt>{t('config.schemaVersion')}</dt>
          <dd className="mono">{data.config.schema_version}</dd>
          <dt>{t('config.tenant')}</dt>
          <dd className="mono">{data.config.tenant_id || tenantId || '—'}</dd>
          <dt>{t('config.userPath')}</dt>
          <dd className="mono">{data.config.paths.user || '—'}</dd>
          <dt>{t('config.projectPath')}</dt>
          <dd className="mono">{data.config.paths.project || '—'}</dd>
          <dt>{t('config.overlayKeys')}</dt>
          <dd className="mono">
            {data.config.tenant_overlay_keys?.length
              ? data.config.tenant_overlay_keys.join(', ')
              : '—'}
          </dd>
        </dl>
        <JsonView value={data.config.config} label={t('config.redactedJson')} />
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">{t('config.itemsTitle')}</h2>
          <span className="count-pill">
            {filteredEntries.length}/{entries.length}
          </span>
        </div>
        <p className="section-desc">{t('config.itemsDesc')}</p>
        <div className="filter-bar">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('config.searchPlaceholder')}
            ariaLabel={t('config.searchLabel')}
          />
        </div>
        {entries.length === 0 ? (
          <p className="section-desc">{t('config.empty')}</p>
        ) : filteredEntries.length === 0 ? (
          <p className="section-desc">{t('config.noMatch', { query: query.trim() })}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('config.col.path')}</th>
                <th scope="col">{t('config.col.value')}</th>
                <th scope="col" className="col-optional">
                  {t('config.col.type')}
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredEntries.map((entry) => (
                <tr key={entry.path}>
                  <td className="mono">{entry.path}</td>
                  <td className="mono">{entry.value || '—'}</td>
                  <td className="col-optional dim">{entry.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2 className="section-title">{t('config.sourcesTitle')}</h2>
        {sourceEntries.length === 0 ? (
          <p className="section-desc">{t('config.noSources')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('config.col.key')}</th>
                <th scope="col">{t('config.col.source')}</th>
              </tr>
            </thead>
            <tbody>
              {sourceEntries.map(([key, source]) => (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td className="mono">{source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
