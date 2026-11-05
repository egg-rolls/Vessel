import {
  applyHostContext,
  type HostContext,
  PluginPage,
  PluginPageHeader,
  readHostContext,
  SegmentedTabs,
  type TabOption,
  watchHostContext,
} from '@vessel-agent/plugin-ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeError, MarketplaceApi, MarketplaceUiError } from './api';
import { type JobState, JobStatus } from './components/JobStatus';
import { translator } from './i18n';
import type { StartJobResult } from './types';
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

  const api = useMemo(() => new MarketplaceApi(), []);
  const t = useMemo(() => translator(host.lang), [host.lang]);

  useEffect(() => {
    applyHostContext(host);
  }, [host]);
  useEffect(() => watchHostContext(setHost), []);
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
    <PluginPage>
      <PluginPageHeader title={heading.title} description={heading.subtitle} />

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
          <MarketplaceView api={api} t={t} refreshToken={refreshToken} busy={busy} onJob={runJob} />
        ) : null}
        {tab === 'installed' ? (
          <InstalledView
            api={api}
            t={t}
            refreshToken={refreshToken}
            busy={busy}
            onJob={runJob}
            onChanged={bumpRefresh}
          />
        ) : null}
        {tab === 'updates' ? (
          <UpdatesView
            api={api}
            t={t}
            refreshToken={refreshToken}
            busy={busy}
            onJob={runJob}
            onChanged={bumpRefresh}
          />
        ) : null}
      </main>
    </PluginPage>
  );
}
