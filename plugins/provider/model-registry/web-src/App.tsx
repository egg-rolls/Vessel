import {
  applyHostContext,
  type HostContext,
  PluginRpcClient,
  readHostContext,
  watchHostContext,
} from '@vessel-agent/plugin-ui';
import { useEffect, useMemo, useState } from 'react';
import { CredentialsView } from './CredentialsView';
import { type MessageKey, translator } from './i18n';
import { VendorsView } from './VendorsView';

export type PluginView = 'vendors' | 'credentials';

const TITLE_KEYS: Record<PluginView, MessageKey> = {
  vendors: 'vendors.title',
  credentials: 'credentials.title',
};

export function App({ view }: { view: PluginView }) {
  const [host, setHost] = useState<HostContext>(() => readHostContext());
  const [refreshKey, setRefreshKey] = useState(0);
  const client = useMemo(() => new PluginRpcClient(), []);
  const t = useMemo(() => translator(host.lang), [host.lang]);

  useEffect(() => {
    applyHostContext(host);
  }, [host]);

  useEffect(() => watchHostContext(setHost), []);

  useEffect(() => {
    document.title = t(TITLE_KEYS[view]);
  }, [t, view]);

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

  if (view === 'credentials')
    return <CredentialsView client={client} refreshKey={refreshKey} t={t} />;
  return <VendorsView client={client} refreshKey={refreshKey} t={t} />;
}
