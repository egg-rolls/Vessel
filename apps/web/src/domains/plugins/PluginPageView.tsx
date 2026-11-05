/**
 * plugin 页面宿主（CONTRACT-0.43 §2.1 / §7）：`#/plugins/<id>/<entry>`。
 *
 * 页面来源只有 `plugins.list` 的 contributions；未安装 / 禁用 / 旧 gateway
 * 时显示空态，不猜测目录。
 */

import { PageScaffold } from '@vessel-agent/plugin-ui';
import type { Route } from '../../app/router';
import { EmptyState, ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t, useLocale } from '../../i18n';
import { PluginFrame } from './PluginFrame';
import { usePluginContributions } from './usePluginContributions';

type PluginsRoute = Extract<Route, { domain: 'plugins' }>;

const EMPTY_METHODS: ReadonlySet<string> = new Set();

export function PluginPageView({ route }: { route: PluginsRoute }) {
  useLocale();
  const { hasToken } = useConnection();
  const { plugins, pages, methodsByPlugin, state, reload } = usePluginContributions();

  const pluginId = route.pluginId ?? '';
  const plugin = plugins.find((item) => item.name === pluginId && item.enabled);
  const page = pages.find(
    (item) =>
      item.pluginId === pluginId && (route.entry === undefined || item.entry === route.entry),
  );

  const body = (() => {
    if (!hasToken) {
      return (
        <NotEnabledState
          title={t('plugins.page.notConnected')}
          reason={t('plugins.page.notConnectedReason')}
        />
      );
    }
    if (pluginId === '') {
      return <EmptyState title={t('plugins.page.notFound')} />;
    }
    if (state.status === 'loading' && plugins.length === 0) {
      return <LoadingState label={t('plugins.page.loading')} />;
    }
    if (state.status === 'error' && plugins.length === 0) {
      return <ErrorState message={state.error} onRetry={reload} />;
    }
    if (plugin === undefined || page === undefined) {
      return <EmptyState title={t('plugins.page.notFound')} />;
    }
    return (
      <PluginFrame
        pluginId={plugin.name}
        entry={page.entry}
        title={page.title}
        methods={methodsByPlugin.get(plugin.name) ?? EMPTY_METHODS}
        className="flex-1 min-h-0"
      />
    );
  })();

  // 有可用插件页面时，整块内容区交给 iframe：宿主不加 padding / max-width /
  // PageHeader，插件自己决定布局与滚动。空态 / 错误态才用带 padding 的容器。
  if (plugin !== undefined && page !== undefined) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden focus:outline-none">
        <PluginFrame
          pluginId={plugin.name}
          entry={page.entry}
          title={page.title}
          methods={methodsByPlugin.get(plugin.name) ?? EMPTY_METHODS}
          className="min-h-0 w-full flex-1"
        />
      </div>
    );
  }

  // 空态才解释「为什么没有页面」；加载 / 错误态由 body 自己说明。
  const loadingOrError =
    (state.status === 'loading' || state.status === 'error') && plugins.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain">
      <PageScaffold
        title={page?.title ?? t('nav.domain.plugins')}
        subtitle={hasToken && !loadingOrError ? t('plugins.page.notFoundReason') : undefined}
      >
        {body}
      </PageScaffold>
    </div>
  );
}
