import { PluginRpcClient } from '@vessel-agent/plugin-ui';
import { useEffect, useMemo, useState } from 'react';
import { LeaderboardView } from './LeaderboardView';
import { LogsView } from './LogsView';
import { UsageView } from './UsageView';

export type PluginView = 'usage' | 'logs' | 'leaderboard';

const PAGES: readonly { id: PluginView; label: string; file: string }[] = [
  { id: 'usage', label: 'Usage', file: 'usage.html' },
  { id: 'logs', label: 'Logs', file: 'logs.html' },
  { id: 'leaderboard', label: 'Leaderboard', file: 'leaderboard.html' },
];

export function App({ view }: { view: PluginView }) {
  const client = useMemo(() => new PluginRpcClient(), []);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => () => client.dispose(), [client]);

  // The host may fire several `plugin.ready` / `plugin.changed` events in a
  // burst; coalesce them into one refetch.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = client.onRefresh(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => setRefreshKey((value) => value + 1), 250);
    });
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      off();
    };
  }, [client]);

  return (
    <div className="mx-auto flex w-full max-w-[var(--content-max)] flex-col gap-4 px-5 pt-5 pb-10">
      <nav
        aria-label="Usage plugin"
        className="flex flex-wrap gap-0.5 self-start rounded-full bg-sunken p-1"
      >
        {PAGES.map((page) => (
          <a
            key={page.id}
            href={`./${page.file}`}
            aria-current={page.id === view ? 'page' : undefined}
            className="rounded-full px-3 py-1.5 text-sm text-muted transition-colors hover:bg-hover hover:text-ink aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-ink"
          >
            {page.label}
          </a>
        ))}
      </nav>

      {view === 'logs' ? (
        <LogsView client={client} refreshKey={refreshKey} />
      ) : view === 'leaderboard' ? (
        <LeaderboardView client={client} refreshKey={refreshKey} />
      ) : (
        <UsageView client={client} refreshKey={refreshKey} />
      )}
    </div>
  );
}
