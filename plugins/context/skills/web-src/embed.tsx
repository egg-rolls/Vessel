/**
 * Embed tier entry (plugin-embed contract §10): named export SkillsView.
 *
 * Data goes through host.rpc (bare names list / get / search / loads / rescan /
 * trust_set; the host prefixes plugin.skills. and re-checks the whitelist).
 * Theme / lang come from host.theme. Refresh: permissions.events is empty
 * (P1 adds no host events); the view refetches after writes / on focus.
 */

import type { PluginMountProps, VesselPluginHost } from '@vessel-agent/plugin-sdk';
import { useEffect, useMemo, useState } from 'react';
import './embed.css';
import { translator } from './i18n';
import { SkillsView as SkillsScreen } from './SkillsView';
import type { RpcCaller } from './shared';

/** host.rpc → the minimal calling surface the view needs. */
function hostCaller(host: VesselPluginHost): RpcCaller {
  return {
    call: <T,>(method: string, params?: unknown): Promise<T> => host.rpc<T>(method, params),
  };
}

/** Lang snapshot: subscribe to host changes so language switches apply live. */
function useHostLang(host: VesselPluginHost): string {
  const [theme, setTheme] = useState(() => host.theme.get());
  useEffect(() => host.theme.subscribe(setTheme), [host]);
  return theme.lang;
}

export function SkillsView({ host }: PluginMountProps) {
  const lang = useHostLang(host);
  const t = useMemo(() => translator(lang), [lang]);
  const client = useMemo(() => hostCaller(host), [host]);
  return <SkillsScreen client={client} refreshKey={0} t={t} />;
}
