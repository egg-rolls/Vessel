/**
 * composer 内嵌扩展的宿主侧（file-ref-ux A7/A9，通用接缝）。
 *
 * `contributes.composer` 的三类贡献经此落地：
 * - refs 槽 → RichComposer 的 `atomicSchemes`（原子卡片渲染器，scheme 驱动）；
 * - drop 槽 → OS 文件 drop / 截图粘贴处理器（宿主 Composer 分流后调用）；
 * - link 槽 → 消息 Markdown link 增强器（外部 store，Markdown 渲染消费）。
 *
 * 加载机制复用 plugin-embed 既有件（loadPluginEmbed / usePluginHost /
 * usePluginSurface / disposePluginHost）：每个有 composer 贡献的插件一个
 * 隐形 bridge，模块就绪 + 授权面落定后注册；卸载 / 热更新 / 禁用 ⇒ 注销（A9）。
 * 宿主零功能名：只认 scheme / 具名导出，不认识「文件引用」。
 */

import type {
  ComposerCardProps,
  ComposerDropHandler,
  ComposerEditorPort,
  ComposerLinkCardProps,
  PluginModule,
} from '@vessel-agent/plugin-sdk';
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
// ── link 增强器：注册表在 components/link-enhancers（Markdown 消费）─────
import { registerLinkEnhancer, unregisterLinkEnhancers } from '../../components/link-enhancers';
import type { AtomicCardProps, AtomicScheme } from '../../components/ui/RichComposer';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { PluginListItem } from '../../gateway/types';
// 块 P0：插件 link 贡献同时映射进块注册表（同一张表；叶模块，无 domains 循环）。
import { registerBlockType, unregisterBlockTypes } from '../chat/block-registry';
import { disposeEmbedModule, loadPluginEmbed } from './embed-loader';
import { disposePluginHost, usePluginHost, usePluginSurface } from './host-factory';
import { type PluginComposerItem, pluginEmbedAssetUrl } from './plugin-contributions';
import { usePluginContributions } from './usePluginContributions';

// ── 注册聚合（provider）─────────────────────────────────────────────────

interface ComposerRegistration {
  schemes: AtomicScheme[];
  drops: ComposerDropHandler[];
}

export interface ComposerExtensions {
  atomicSchemes: readonly AtomicScheme[];
  dropHandlers: readonly ComposerDropHandler[];
}

const EMPTY_EXTENSIONS: ComposerExtensions = { atomicSchemes: [], dropHandlers: [] };
const ComposerExtensionsContext = createContext<ComposerExtensions>(EMPTY_EXTENSIONS);

export function useComposerExtensions(): ComposerExtensions {
  return useContext(ComposerExtensionsContext);
}

/** 单插件 bridge：加载 embed 模块 → 注册贡献 → 卸载注销。 */
function ComposerPluginBridge({
  plugin,
  items,
  onRegister,
}: {
  plugin: PluginListItem;
  items: readonly PluginComposerItem[];
  onRegister: (pluginId: string, registration: ComposerRegistration | null) => void;
}) {
  const pluginId = plugin.name;
  const { nodeUrl } = useConnection();
  const methods = useMemo(() => {
    const names = new Set<string>();
    for (const rpc of plugin.contributions?.rpc ?? []) {
      const name = typeof rpc === 'string' ? rpc : (rpc.name ?? '');
      if (name !== '') names.add(name);
    }
    return names;
  }, [plugin]);
  const { surface, ready: surfaceReady } = usePluginSurface(pluginId, methods);
  const host = usePluginHost(pluginId, surface);

  const embed = plugin.ui_embed;
  const hash = plugin.ui_bundle_hash ?? '';
  const embedEntry = embed?.entry;
  const runtimeReact = embed?.runtime.react;
  const runtimeSdk = embed?.runtime.sdk;
  const moduleUrl =
    embedEntry !== undefined ? pluginEmbedAssetUrl(nodeUrl, pluginId, embedEntry) : null;
  const firstExport = items[0]?.component ?? items[0]?.handler ?? '';
  const [module, setModule] = useState<PluginModule | null>(null);

  useEffect(() => {
    if (
      embedEntry === undefined ||
      runtimeReact === undefined ||
      runtimeSdk === undefined ||
      hash === '' ||
      moduleUrl === null ||
      firstExport === ''
    ) {
      return;
    }
    let active = true;
    let loaded: PluginModule | null = null;
    void loadPluginEmbed({
      url: moduleUrl,
      hash,
      component: firstExport,
      runtime: { react: runtimeReact, sdk: runtimeSdk },
    }).then((result) => {
      if (!active) return;
      if (result.status === 'ready') {
        loaded = result.module;
        setModule(result.module);
      }
    });
    return () => {
      active = false;
      disposeEmbedModule(loaded);
      setModule(null);
      disposePluginHost(pluginId);
    };
  }, [embedEntry, runtimeReact, runtimeSdk, hash, moduleUrl, firstExport, pluginId]);

  useEffect(() => {
    if (module === null || !surfaceReady) return;
    const schemes: AtomicScheme[] = [];
    const drops: ComposerDropHandler[] = [];
    for (const item of items) {
      const name = item.component ?? item.handler ?? '';
      const exported = module[name];
      if (typeof exported !== 'function') continue;
      if (item.slot === 'drop') {
        drops.push(exported as ComposerDropHandler);
        continue;
      }
      if (item.scheme === undefined) continue;
      if (item.slot === 'link') {
        const LinkCard = exported as ComponentType<ComposerLinkCardProps>;
        registerLinkEnhancer(item.scheme, {
          pluginId,
          component: LinkCard,
          host,
        });
        // 块 P0：同一贡献映射进块注册表（x:<pluginId>:<scheme>，同一张表治理）。
        // 正文内渲染仍走 link-enhancers 查表（Markdown link 命中即插件卡）；这里
        // lift 恒 []（inline 块不是消息级信封，不剥正文），只登记类型身份，
        // 供热更新/禁用统一注销与后续 P1 消费。不另造第二套注册链。
        registerBlockType<{ href: string; text: string }>({
          type: `x:${pluginId}:${item.scheme}`,
          surface: 'inline',
          order: 100,
          owner: pluginId,
          lift: () => [],
          component: ({ payload }) => (
            <LinkCard href={payload.href} text={payload.text} host={host} />
          ),
        });
        continue;
      }
      // refs 槽：包一层注入 host / port（卡片组件拿到的是 sdk 契约形状）。
      const Card = exported as ComponentType<ComposerCardProps>;
      const scheme = item.scheme;
      schemes.push({
        scheme,
        render: (props: AtomicCardProps) => (
          <Card
            scheme={props.scheme}
            name={props.name}
            target={props.target}
            data={props.data}
            onRemove={props.onRemove}
            port={props.port as ComposerEditorPort | undefined}
            host={host}
          />
        ),
      });
    }
    onRegister(pluginId, { schemes, drops });
    return () => {
      onRegister(pluginId, null);
      unregisterLinkEnhancers(pluginId);
      unregisterBlockTypes(pluginId);
    };
  }, [module, surfaceReady, items, host, onRegister, pluginId]);

  return null;
}

/**
 * composer 扩展 provider：挂在 app 根（ConnectionProvider 内）。
 * 无 composer 贡献 / 旧 gateway ⇒ 空注册（输入框 = 纯文本富编辑）。
 */
export function ComposerExtensionsProvider({ children }: { children: ReactNode }) {
  const { plugins, composer } = usePluginContributions();
  const [registrations, setRegistrations] = useState<Record<string, ComposerRegistration>>({});

  const onRegister = useCallback((pluginId: string, registration: ComposerRegistration | null) => {
    setRegistrations((current) => {
      if (registration === null) {
        if (!(pluginId in current)) return current;
        const next = { ...current };
        delete next[pluginId];
        return next;
      }
      return { ...current, [pluginId]: registration };
    });
  }, []);

  const byPlugin = useMemo(() => {
    const map = new Map<string, PluginComposerItem[]>();
    for (const item of composer) {
      const list = map.get(item.pluginId);
      if (list === undefined) map.set(item.pluginId, [item]);
      else list.push(item);
    }
    return map;
  }, [composer]);

  const value = useMemo<ComposerExtensions>(() => {
    const atomicSchemes: AtomicScheme[] = [];
    const dropHandlers: ComposerDropHandler[] = [];
    for (const registration of Object.values(registrations)) {
      atomicSchemes.push(...registration.schemes);
      dropHandlers.push(...registration.drops);
    }
    return { atomicSchemes, dropHandlers };
  }, [registrations]);

  return (
    <ComposerExtensionsContext.Provider value={value}>
      {plugins
        .filter((plugin) => plugin.enabled && byPlugin.has(plugin.name))
        .map((plugin) => (
          <ComposerPluginBridge
            key={plugin.name}
            plugin={plugin}
            items={byPlugin.get(plugin.name) ?? []}
            onRegister={onRegister}
          />
        ))}
      {children}
    </ComposerExtensionsContext.Provider>
  );
}
