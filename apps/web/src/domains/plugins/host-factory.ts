/**
 * plugin-embed 契约 §7/§8：内嵌插件的宿主适配器工厂。
 *
 * 复用既有宿主面，不另起平行系统：rpc 走 gateway client（SDK 补
 * `plugin.<id>.` 前缀）、theme 走 state/theme、toast 走 ToastProvider
 * （MessageBar 渲染）、i18n 走宿主 t、events 走 eventStore 订阅、log 走
 * 浏览器 console 诊断面（与 event-store 等同一模式）。
 *
 * 订阅按 pluginId 追踪，卸载 / 热更新切换时强制回收（disposePluginHost）。
 * 白名单（rpc 裸名 / events 模式 / permissions 声明）来自 manifest：rpc 用
 * contributions 归一化结果，events / permissions 用 plugins.catalog 的
 * manifest 透传面；catalog 不可用时 events 白名单为空（fail-closed）。
 */
import {
  createPluginHost,
  type PluginHostAdapter,
  type PluginHostTheme,
  type PluginPermissionDeclaration,
  type VesselPluginHost,
} from '@vessel-agent/plugin-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../../components/ToastProvider';
import { useConnection } from '../../gateway/ConnectionProvider';
import { stageFiles } from '../../gateway/node/attachments';
import type { PluginCatalogItem } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { resolvedTheme, useTheme } from '../../state/theme';
import { openAttachmentPreview } from '../chat/attachment-lightbox';
import { fetchPluginCatalog } from './plugin-catalog';

/** 插件的 manifest 授权面（白名单复核的数据源）。 */
export interface PluginHostSurface {
  /** contributes.rpc 裸名（commands 必有同名 rpc，归一化集合等价）。 */
  rpcMethods: readonly string[];
  /** permissions.events 模式（支持 `llm.*`）。 */
  eventPatterns: readonly string[];
  permissions: PluginPermissionDeclaration;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** catalog manifest → 授权面；catalog 缺失 / 形状不符 → events 空白名单。 */
export function surfaceFromCatalog(
  items: readonly PluginCatalogItem[] | null,
  pluginId: string,
  rpcMethods: readonly string[],
): PluginHostSurface {
  const manifest = items?.find((item) => item.id === pluginId)?.manifest;
  const permissions =
    manifest !== null && typeof manifest === 'object' && typeof manifest.permissions === 'object'
      ? (manifest.permissions as Record<string, unknown> | null)
      : null;
  const events = stringArray(permissions?.events);
  return {
    rpcMethods,
    eventPatterns: events,
    permissions: {
      fs: stringArray(permissions?.fs),
      net: stringArray(permissions?.net),
      process: permissions?.process === true,
      secrets: permissions?.secrets === true,
      events,
      rpc: stringArray(permissions?.rpc),
    },
  };
}

// ── 按 pluginId 追踪 SDK 订阅（卸载强制回收） ──────────────────────────────

const subscriptionsByPlugin = new Map<string, Set<() => void>>();

function trackSubscription(pluginId: string, unsubscribe: () => void): () => void {
  let set = subscriptionsByPlugin.get(pluginId);
  if (set === undefined) {
    set = new Set();
    subscriptionsByPlugin.set(pluginId, set);
  }
  const tracked = (): void => {
    unsubscribe();
    set.delete(tracked);
    if (set.size === 0) subscriptionsByPlugin.delete(pluginId);
  };
  set.add(tracked);
  return tracked;
}

/** 卸载 / 热更新切换前回收该 plugin 的全部 SDK 订阅。 */
export function disposePluginHost(pluginId: string): void {
  const set = subscriptionsByPlugin.get(pluginId);
  if (set === undefined) return;
  subscriptionsByPlugin.delete(pluginId);
  for (const unsubscribe of [...set]) {
    try {
      unsubscribe();
    } catch {
      // 回收失败不阻断卸载
    }
  }
}

/**
 * 构造冻宿主对象（每 pluginId 一份，白名单读 live ref，catalog 异步到达也
 * 生效）。theme / locale 变化经订阅推送；events 按 seq 增量分发。
 */
export function usePluginHost(pluginId: string, surface: PluginHostSurface): VesselPluginHost {
  const { client, eventStore } = useConnection();
  const toast = useToast();
  const locale = useLocale();
  const { theme } = useTheme();
  const [systemDark, setSystemDark] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = (): void => setSystemDark(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  const mode = resolvedTheme(theme, systemDark);

  // live ref：宿主对象按 pluginId 稳定，能力与白名单始终读当前值。
  const live = useRef({ client, eventStore, toast, mode, locale, surface });
  live.current = { client, eventStore, toast, mode, locale, surface };

  const themeListeners = useRef(new Set<(snapshot: PluginHostTheme) => void>());
  useEffect(() => {
    const snapshot: PluginHostTheme = { mode, lang: locale };
    for (const listener of [...themeListeners.current]) {
      try {
        listener(snapshot);
      } catch {
        // 插件回调异常不影响宿主其它订阅者
      }
    }
  }, [mode, locale]);

  return useMemo(() => {
    const adapter: PluginHostAdapter = {
      pluginId,
      sdkVersion: __VESSEL_PLUGIN_SDK_VERSION__,
      get rpcMethods() {
        return live.current.surface.rpcMethods;
      },
      get eventPatterns() {
        return live.current.surface.eventPatterns;
      },
      get permissions() {
        return live.current.surface.permissions;
      },
      rpc: (method, params) => live.current.client.rpc(method, params),
      attachments: {
        preview: (path) => live.current.client.previewAttachment(path),
        stage: (files) => stageFiles(live.current.client, files),
        // 宿主标准预览弹窗：共享接缝取字节 → 按 mime 分流（图片 ImageLightbox /
        // PDF 原生查看器）。字节不可用 ⇒ reject，插件侧自行 toast（fail-closed）。
        openPreview: async (path) => {
          await openAttachmentPreview(live.current.client, path);
        },
      },
      subscribeEvent: (type, cb) => {
        const store = live.current.eventStore;
        let lastSeq = store.getSnapshot().lastSeq;
        const listener = (): void => {
          const snapshot = store.getSnapshot();
          // 重连 / 代际变化会重建缓冲（seq 回退）：从头补发。
          if (snapshot.lastSeq < lastSeq) lastSeq = 0;
          const fresh: Array<{ seq: number; type: string; data: Record<string, unknown> }> = [];
          for (let index = snapshot.entries.length - 1; index >= 0; index -= 1) {
            const entry = snapshot.entries[index];
            if (entry === undefined || entry.seq <= lastSeq) break;
            fresh.push({ seq: entry.seq, type: entry.event.type, data: entry.event.data });
          }
          fresh.reverse();
          for (const event of fresh) {
            lastSeq = event.seq;
            if (event.type !== type) continue;
            try {
              cb({ type: event.type, payload: event.data });
            } catch {
              // 插件回调异常只记录，不影响事件流
            }
          }
        };
        return trackSubscription(pluginId, store.subscribe(listener));
      },
      theme: {
        get: () => ({ mode: live.current.mode, lang: live.current.locale }),
        subscribe: (cb) => {
          const listeners = themeListeners.current;
          listeners.add(cb);
          return trackSubscription(pluginId, () => {
            listeners.delete(cb);
          });
        },
      },
      toast: (msg) => {
        live.current.toast[msg.kind](msg.text);
      },
      i18n: { t: (key, vars) => t(key, vars) },
      log: (level, message, data) => {
        const prefix = `[vessel-plugin:${pluginId}]`;
        if (level === 'error') console.error(prefix, message, data);
        else if (level === 'warn') console.warn(prefix, message, data);
        else if (level === 'info') console.info(prefix, message, data);
        else console.debug(prefix, message, data);
      },
    };
    // 宿主对象按 pluginId 稳定；能力 / 白名单经 live ref 读取（ref 恒定）。
    return createPluginHost(adapter);
  }, [pluginId]);
}

/**
 * 拉取 catalog 解析授权面；失败保持 events 空白名单（fail-closed）。
 * `ready` 在 catalog 落定（成功或失败）后置位——调用方应等它就绪再挂载插件
 * 组件，否则插件首次 `events.subscribe` 会撞上尚未就绪的白名单。
 */
export function usePluginSurface(
  pluginId: string,
  rpcMethods: ReadonlySet<string>,
): { surface: PluginHostSurface; ready: boolean } {
  const { client } = useConnection();
  const [surface, setSurface] = useState<PluginHostSurface>(() =>
    surfaceFromCatalog(null, pluginId, [...rpcMethods]),
  );
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    setReady(false);
    void fetchPluginCatalog(client).then((items) => {
      if (!active) return;
      setSurface(surfaceFromCatalog(items, pluginId, [...rpcMethods]));
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, [client, pluginId, rpcMethods]);
  return { surface, ready };
}
