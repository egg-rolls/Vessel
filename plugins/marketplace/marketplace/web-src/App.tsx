import {
  applyHostContext,
  type HostContext,
  PageScaffold,
  readHostContext,
  SegmentedTabs,
  type TabOption,
  watchHostCatalog,
  watchHostContext,
} from '@vessel-agent/plugin-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeError, MarketplaceApi, MarketplaceUiError } from './api';
import { mergeCatalogRows } from './catalog';
import { type JobState, JobStatus } from './components/JobStatus';
import { translator } from './i18n';
import type { CatalogItem, CatalogRow, StartJobResult, UpdatesResult } from './types';
import { InstalledView } from './views/InstalledView';
import { MarketplaceView } from './views/MarketplaceView';
import { UpdatesView } from './views/UpdatesView';

type Tab = 'browse' | 'installed' | 'updates';

const REFRESH_DEBOUNCE_MS = 250;

export function App() {
  const [host, setHost] = useState<HostContext>(() => readHostContext());
  const [tab, setTab] = useState<Tab>('browse');
  const [refreshToken, setRefreshToken] = useState(0);
  const [jobState, setJobState] = useState<JobState | null>(null);
  const [busy, setBusy] = useState(false);
  // CONTRACT-0.47 §2: the gateway pushes the catalog; `null` means it never
  // arrived (old gateway) and the plugin-owned views show an empty state.
  const [catalog, setCatalog] = useState<readonly CatalogItem[] | null>(null);
  const [updates, setUpdates] = useState<UpdatesResult | null>(null);
  const [updatesLoading, setUpdatesLoading] = useState(false);
  const [updatesError, setUpdatesError] = useState<string | null>(null);
  const updatesRequest = useRef(0);

  const api = useMemo(() => new MarketplaceApi(), []);
  const t = useMemo(() => translator(host.lang), [host.lang]);

  useEffect(() => {
    applyHostContext(host);
  }, [host]);
  useEffect(() => watchHostContext(setHost), []);
  useEffect(() => watchHostCatalog<CatalogItem>((items) => setCatalog(items)), []);
  useEffect(() => {
    document.title = t('app.title');
  }, [t]);
  useEffect(() => () => api.dispose(), [api]);

  // Host -> plugin refresh: debounce bursts of `plugin.changed` into one reload.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api.onRefresh(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => setRefreshToken((value) => value + 1), REFRESH_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api]);

  const bumpRefresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  // Registry lookup for the catalog ids. The child never scans disk; the
  // installed version lives in the catalog row.
  const loadUpdates = useCallback(async () => {
    if (catalog === null) {
      setUpdates(null);
      setUpdatesError(null);
      setUpdatesLoading(false);
      return;
    }
    const request = updatesRequest.current + 1;
    updatesRequest.current = request;
    setUpdatesLoading(true);
    setUpdatesError(null);
    // Built-ins ship with the host and are never updated by the marketplace.
    const ids = catalog
      .filter((item) => item.scope !== 'builtin' && item.kind !== 'builtin')
      .map((item) => item.id);
    try {
      const result: UpdatesResult = ids.length === 0 ? { items: [] } : await api.updates(ids);
      if (updatesRequest.current !== request) return;
      setUpdates(result);
    } catch (caught) {
      if (updatesRequest.current !== request) return;
      setUpdatesError(describeError(caught, t));
      setUpdates(null);
    } finally {
      if (updatesRequest.current === request) setUpdatesLoading(false);
    }
  }, [api, catalog, t]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refreshToken` is an explicit host-refresh trigger, not a value the effect reads.
  useEffect(() => {
    void loadUpdates();
  }, [loadUpdates, refreshToken]);

  const rows = useMemo<CatalogRow[]>(
    () => (catalog === null ? [] : mergeCatalogRows(catalog, updates)),
    [catalog, updates],
  );

  const runJob = useCallback(
    async (label: string, start: () => Promise<StartJobResult>) => {
      setBusy(true);
      setJobState({ label, status: 'running' });
      try {
        const started = await start();
        if (started.job_id === undefined || started.job_id === '') {
          throw new MarketplaceUiError('missing_job_id', 'missing job id');
        }
        await api.waitForJob(started.job_id, (job) => {
          setJobState({ label, status: 'running', job });
        });
        setJobState({ label, status: 'done' });
        setRefreshToken((value) => value + 1);
      } catch (error) {
        setJobState({ label, status: 'failed', error: describeError(error, t) });
      } finally {
        setBusy(false);
      }
    },
    [api, t],
  );

  const tabs: TabOption<Tab>[] = [
    { id: 'browse', label: t('tab.marketplace') },
    { id: 'installed', label: t('tab.installed') },
    { id: 'updates', label: t('tab.updates') },
  ];

  const heading =
    tab === 'browse'
      ? { title: t('browse.title'), subtitle: t('browse.subtitle') }
      : tab === 'installed'
        ? { title: t('installed.title'), subtitle: t('installed.subtitle') }
        : { title: t('updates.title'), subtitle: t('updates.subtitle') };

  return (
    <PageScaffold title={heading.title} subtitle={heading.subtitle}>
      <SegmentedTabs
        label={t('tabs.label')}
        tabs={tabs}
        value={tab}
        onChange={setTab}
        panelId="marketplace-panel"
        className="mt-0"
      />

      <JobStatus state={jobState} t={t} />

      <main id="marketplace-panel" role="tabpanel" aria-labelledby={`marketplace-panel-tab-${tab}`}>
        {tab === 'browse' ? (
          <MarketplaceView
            api={api}
            t={t}
            refreshToken={refreshToken}
            busy={busy}
            onJob={runJob}
            catalog={catalog}
          />
        ) : null}
        {tab === 'installed' ? (
          <InstalledView
            api={api}
            t={t}
            busy={busy}
            onJob={runJob}
            catalogAvailable={catalog !== null}
            rows={rows}
            registry={updates?.registry}
            registryError={updates?.registry_error}
            onRefresh={bumpRefresh}
            onChanged={bumpRefresh}
          />
        ) : null}
        {tab === 'updates' ? (
          <UpdatesView
            api={api}
            t={t}
            busy={busy}
            onJob={runJob}
            catalogAvailable={catalog !== null}
            rows={rows}
            updatesLoading={updatesLoading}
            updatesError={updatesError}
            registry={updates?.registry}
            registryError={updates?.registry_error}
            onRefresh={bumpRefresh}
            onChanged={bumpRefresh}
          />
        ) : null}
      </main>
    </PageScaffold>
  );
}
