/**
 * plugin-embed 契约 §8：内嵌档页面挂载（embedded）。
 *
 * effect 内异步加载（semver 核对 → import(url?v=hash) → 具名导出）；loading
 * 占位与就绪内容共用同一容器尺寸（不顶动布局）。就绪后渲染作用域根
 * `<div data-vessel-plugin={id} data-mount="page">`，内层 PluginErrorBoundary
 * （key = id:hash:attempt）+ Suspense 包组件。css 用 <link> 注入、卸载移除。
 *
 * 热更新：ui_bundle_hash 变化 → 旧模块 dispose() + 订阅回收 → 重新 import；
 * boundary key 变化重挂载。旧 ESM 模块无法从模块表卸载（泄漏有限次可接受）。
 * 「改用隔离模式」是本地切换：渲染 PluginFrame（iframe entry 必填，§2）。
 */
import type { PluginModule } from '@vessel-agent/plugin-sdk';
import { Suspense, useEffect, useRef, useState } from 'react';
import { ErrorState, LoadingState } from '../../components/States';
import { Button, cn } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { PluginListItem } from '../../gateway/types';
import { t } from '../../i18n';
import { disposeEmbedModule, type EmbedLoadResult, loadPluginEmbed } from './embed-loader';
import { disposePluginHost, usePluginHost, usePluginSurface } from './host-factory';
import { PluginErrorBoundary } from './PluginErrorBoundary';
import { PluginFrame } from './PluginFrame';
import { type PluginPageItem, pluginEmbedAssetUrl } from './plugin-contributions';

type EmbedState = EmbedLoadResult | { status: 'loading' };

export function PluginEmbed({
  plugin,
  page,
  methods,
  className,
  context,
}: {
  plugin: PluginListItem;
  page: PluginPageItem;
  /** 允许调用的 RPC 裸名（contributions.rpc ∪ commands）。 */
  methods: ReadonlySet<string>;
  className?: string;
  context?: { run?: string; session?: string };
}) {
  const pluginId = plugin.name;
  const embed = plugin.ui_embed;
  const hash = plugin.ui_bundle_hash ?? '';
  const component = page.component ?? '';
  const { nodeUrl } = useConnection();
  const { surface, ready: surfaceReady } = usePluginSurface(pluginId, methods);
  const host = usePluginHost(pluginId, surface);

  const [state, setState] = useState<EmbedState>({ status: 'loading' });
  const [isolated, setIsolated] = useState(false);
  /** 渲染错误重试：bump → boundary key 变化 → 重置 state 重挂载。 */
  const [attempt, setAttempt] = useState(0);
  /** 加载失败重试：bump → 重跑 load effect（import 失败不进模块缓存）。 */
  const [loadKey, setLoadKey] = useState(0);
  const moduleRef = useRef<PluginModule | null>(null);

  const embedEntry = embed?.entry;
  const embedCss = embed?.css;
  const runtimeReact = embed?.runtime.react;
  const runtimeSdk = embed?.runtime.sdk;
  const moduleUrl =
    embedEntry !== undefined ? pluginEmbedAssetUrl(nodeUrl, pluginId, embedEntry) : null;

  // 加载 / 热更新 / 卸载。deps 全是原始值：plugins.list 对账重建对象身份时
  // 内容未变不触发重载；hash 变化才 dispose 旧模块并重新 import。
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadKey 是加载失败重试的显式触发器
  useEffect(() => {
    if (
      embedEntry === undefined ||
      runtimeReact === undefined ||
      runtimeSdk === undefined ||
      hash === '' ||
      component === '' ||
      moduleUrl === null
    ) {
      return;
    }
    let active = true;
    setState({ status: 'loading' });
    void loadPluginEmbed({
      url: moduleUrl,
      hash,
      component,
      runtime: { react: runtimeReact, sdk: runtimeSdk },
    }).then((result) => {
      if (!active) return;
      if (result.status === 'ready') moduleRef.current = result.module;
      setState(result);
    });
    return () => {
      active = false;
      disposeEmbedModule(moduleRef.current);
      moduleRef.current = null;
      disposePluginHost(pluginId);
    };
  }, [embedEntry, runtimeReact, runtimeSdk, hash, component, moduleUrl, pluginId, loadKey]);

  // css 注入（?v=hash 与入口同口径）；卸载 / 哈希变化移除。
  useEffect(() => {
    if (embedCss === undefined || hash === '') return;
    const cssUrl = pluginEmbedAssetUrl(nodeUrl, pluginId, embedCss);
    if (cssUrl === null) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${cssUrl}?v=${hash}`;
    document.head.appendChild(link);
    return () => {
      link.remove();
    };
  }, [embedCss, hash, nodeUrl, pluginId]);

  // fail-closed：字段缺失（旧 gateway / 形状不符）或本地切换 → iframe 档。
  if (isolated || embed === undefined || hash === '' || component === '') {
    return (
      <PluginFrame
        pluginId={pluginId}
        entry={page.entry}
        title={page.title}
        methods={methods}
        context={context}
        className={className}
      />
    );
  }

  // 组件挂载必须等授权面（catalog）落定：否则插件首次 events.subscribe 会撞上
  // 尚未就绪的白名单。模块已加载但 surface 未就绪时继续占位。
  const ready = state.status === 'ready' && surfaceReady ? state : null;
  const waitingSurface = state.status === 'ready' && !surfaceReady;
  const isolateAction = (
    <Button onClick={() => setIsolated(true)}>{t('plugins.embed.useIsolated')}</Button>
  );

  return (
    <div className={cn('relative min-h-0', className)}>
      {(state.status === 'loading' || waitingSurface) && (
        <LoadingState label={t('plugins.embed.loading')} rows={3} />
      )}
      {state.status === 'incompatible' && (
        <ErrorState
          title={t('plugins.embed.incompatibleTitle')}
          message={t('plugins.embed.incompatibleBody', { detail: state.detail })}
          action={isolateAction}
        />
      )}
      {state.status === 'failed' && (
        <ErrorState
          title={t('plugins.embed.failedTitle')}
          message={t('plugins.embed.failedBody', { detail: state.detail })}
          onRetry={() => setLoadKey((value) => value + 1)}
          action={isolateAction}
        />
      )}
      {ready !== null && (
        <div
          data-vessel-plugin={pluginId}
          data-mount="page"
          className="h-full min-h-0 overflow-auto"
        >
          <PluginErrorBoundary
            key={`${pluginId}:${hash}:${attempt}`}
            pluginId={pluginId}
            pluginName={plugin.name}
            onRetry={() => setAttempt((value) => value + 1)}
            onIsolate={() => setIsolated(true)}
          >
            <Suspense fallback={<LoadingState label={t('plugins.embed.loading')} rows={3} />}>
              <ready.component
                host={host}
                mount="page"
                context={{ pageId: page.id, run: context?.run, session: context?.session }}
              />
            </Suspense>
          </PluginErrorBoundary>
        </div>
      )}
    </div>
  );
}
