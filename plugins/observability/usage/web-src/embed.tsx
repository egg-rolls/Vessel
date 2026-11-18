/**
 * Embed 档入口（plugin-embed 契约 §10）：具名导出 UsageView / LogsView。
 *
 * 数据走 host.rpc（裸名 summary / logs / leaderboard，宿主补 plugin.usage.
 * 前缀并做白名单复核），复用与 iframe 档同一份展示组件；不用 iframe 桥
 * （PluginRpcClient）。主题 / 语言走 host.theme，刷新信号走 host.events
 * （permissions.events 子集）。同一份 web-src 继续出 iframe 产物（main.tsx）。
 */
import type { PluginMountProps, VesselPluginHost } from '@vessel-agent/plugin-sdk';
import { useEffect, useMemo, useState } from 'react';
import './embed.css';
import { translator } from './i18n';
import { LogsView as LogsScreen } from './LogsView';
import type { RpcCaller } from './shared';
import { UsageView as UsageScreen } from './UsageView';

/** host.rpc → 视图的最小调用面（白名单复核在 SDK 宿主对象内）。 */
function hostCaller(host: VesselPluginHost): RpcCaller {
  return {
    call: <T,>(method: string, params?: unknown): Promise<T> => host.rpc<T>(method, params),
  };
}

/** 主题 / 语言快照：订阅宿主变化，暗色与切换语言自动生效。 */
function useHostTheme(host: VesselPluginHost): { mode: 'light' | 'dark'; lang: string } {
  const [theme, setTheme] = useState(() => host.theme.get());
  useEffect(() => host.theme.subscribe(setTheme), [host]);
  return theme;
}

/**
 * 刷新信号：用量相关事件（manifest permissions.events 子集）到达时去抖
 * bump refreshKey，与 iframe 档 App 的 250ms 合批同口径。
 */
function useRefreshKey(host: VesselPluginHost): number {
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => setRefreshKey((value) => value + 1), 250);
    };
    // 白名单 fail-closed：catalog 不可用时 events 白名单为空，subscribe 会拒绝。
    // 降级为「无自动刷新」（rpc 数据仍可用），不让刷新信号 crash 整个视图。
    const offs: Array<() => void> = [];
    for (const type of ['llm.response', 'run.completed']) {
      try {
        offs.push(host.events.subscribe(type, bump));
      } catch {
        // 未授权 / 白名单未就绪：跳过该订阅
      }
    }
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const off of offs) off();
    };
  }, [host]);
  return refreshKey;
}

export function UsageView({ host }: PluginMountProps) {
  const theme = useHostTheme(host);
  const t = useMemo(() => translator(theme.lang), [theme.lang]);
  const client = useMemo(() => hostCaller(host), [host]);
  const refreshKey = useRefreshKey(host);
  return <UsageScreen client={client} refreshKey={refreshKey} t={t} />;
}

export function LogsView({ host }: PluginMountProps) {
  const theme = useHostTheme(host);
  const t = useMemo(() => translator(theme.lang), [theme.lang]);
  const client = useMemo(() => hostCaller(host), [host]);
  const refreshKey = useRefreshKey(host);
  return <LogsScreen client={client} refreshKey={refreshKey} t={t} />;
}
