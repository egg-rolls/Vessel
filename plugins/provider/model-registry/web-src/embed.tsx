/**
 * Embed 档入口（plugin-embed 契约 §10）：具名导出 CredentialsView / ModelsView。
 *
 * 数据走 host.rpc（裸名 list / model_set / …，宿主补 plugin.model-registry.
 * 前缀并做白名单复核），复用与 iframe 档同一份展示组件。主题 / 语言走 host.theme。
 * 刷新信号：permissions.events 为空（registry 热应用没有现成事件名，不新增），
 * 写后由视图自行读回快照 + 手动刷新；iframe 档另有 vessel.plugin.refresh 桥。
 */
import type { PluginMountProps, VesselPluginHost } from '@vessel-agent/plugin-sdk';
import { useEffect, useMemo, useState } from 'react';
import { CredentialsView as CredentialsScreen } from './CredentialsView';
import './embed.css';
import { translator } from './i18n';
import { ModelsView as ModelsScreen } from './ModelsView';
import type { RpcCaller } from './shared';

/** host.rpc → 视图的最小调用面（白名单复核在 SDK 宿主对象内）。 */
function hostCaller(host: VesselPluginHost): RpcCaller {
  return {
    call: <T,>(method: string, params?: unknown): Promise<T> => host.rpc<T>(method, params),
  };
}

/** 语言快照：订阅宿主变化，切换语言自动生效。 */
function useHostLang(host: VesselPluginHost): string {
  const [theme, setTheme] = useState(() => host.theme.get());
  useEffect(() => host.theme.subscribe(setTheme), [host]);
  return theme.lang;
}

export function ModelsView({ host }: PluginMountProps) {
  const lang = useHostLang(host);
  const t = useMemo(() => translator(lang), [lang]);
  const client = useMemo(() => hostCaller(host), [host]);
  return <ModelsScreen client={client} refreshKey={0} t={t} />;
}

export function CredentialsView({ host }: PluginMountProps) {
  const lang = useHostLang(host);
  const t = useMemo(() => translator(lang), [lang]);
  const client = useMemo(() => hostCaller(host), [host]);
  return <CredentialsScreen client={client} refreshKey={0} t={t} />;
}
