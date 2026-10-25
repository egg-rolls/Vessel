import { useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { CopyButton } from '../../components/CopyButton';
import { JsonView } from '../../components/JsonView';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { Badge, Button, DataTable, KeyValueList, SearchInput, Section } from '../../components/ui';
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
    <div className="flex flex-col gap-6">
      {!connected && <StaleNotice message={t('config.stale')} onRetry={resource.reload} />}
      {error && (
        <StaleNotice message={t('common.staleData', { detail: error })} onRetry={resource.reload} />
      )}
      <Section
        title={t('config.title')}
        actions={
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <CopyButton
              text={JSON.stringify(data.config.config, null, 2)}
              label={t('config.copyJson')}
              toast={t('config.copiedJson')}
            />
            <Button size="small" onClick={resource.reload}>
              {t('common.refresh')}
            </Button>
          </div>
        }
      >
        <KeyValueList
          items={[
            {
              key: 'schema',
              label: t('config.schemaVersion'),
              value: <span className="font-mono">{data.config.schema_version}</span>,
            },
            {
              key: 'tenant',
              label: t('config.tenant'),
              value: <span className="font-mono">{data.config.tenant_id || tenantId || '—'}</span>,
            },
            {
              key: 'userPath',
              label: t('config.userPath'),
              value: <span className="font-mono">{data.config.paths.user || '—'}</span>,
            },
            {
              key: 'projectPath',
              label: t('config.projectPath'),
              value: <span className="font-mono">{data.config.paths.project || '—'}</span>,
            },
            {
              key: 'overlayKeys',
              label: t('config.overlayKeys'),
              value: (
                <span className="font-mono">
                  {data.config.tenant_overlay_keys?.length
                    ? data.config.tenant_overlay_keys.join(', ')
                    : '—'}
                </span>
              ),
            },
          ]}
        />
        <JsonView value={data.config.config} label={t('config.redactedJson')} />
      </Section>

      <Section
        title={t('config.itemsTitle')}
        description={t('config.itemsDesc')}
        actions={
          <Badge>
            {filteredEntries.length}/{entries.length}
          </Badge>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('config.searchPlaceholder')}
            ariaLabel={t('config.searchLabel')}
            className="grow basis-60 max-w-search"
          />
        </div>
        {entries.length === 0 ? (
          <p className="mt-1.5 text-md text-muted">{t('config.empty')}</p>
        ) : filteredEntries.length === 0 ? (
          <p className="mt-1.5 text-md text-muted">
            {t('config.noMatch', { query: query.trim() })}
          </p>
        ) : (
          <DataTable
            columns={[
              {
                key: 'path',
                header: t('config.col.path'),
                cellClassName: 'font-mono',
                cell: (entry) => entry.path,
              },
              {
                key: 'value',
                header: t('config.col.value'),
                cellClassName: 'font-mono',
                cell: (entry) => entry.value || '—',
              },
              {
                key: 'type',
                header: t('config.col.type'),
                hide: 'compact',
                cellClassName: 'text-muted',
                cell: (entry) => entry.type,
              },
            ]}
            rows={filteredEntries}
            rowKey={(entry) => entry.path}
          />
        )}
      </Section>

      <Section title={t('config.sourcesTitle')}>
        {sourceEntries.length === 0 ? (
          <p className="text-md text-muted">{t('config.noSources')}</p>
        ) : (
          <DataTable
            columns={[
              {
                key: 'key',
                header: t('config.col.key'),
                cellClassName: 'font-mono',
                cell: (entry) => entry[0],
              },
              {
                key: 'source',
                header: t('config.col.source'),
                cellClassName: 'font-mono',
                cell: (entry) => entry[1],
              },
            ]}
            rows={sourceEntries}
            rowKey={(entry) => entry[0]}
          />
        )}
      </Section>
    </div>
  );
}
