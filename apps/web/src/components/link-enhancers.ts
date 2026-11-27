/**
 * Markdown link 增强器注册表（file-ref-ux A6/A9，宿主通用接缝）。
 *
 * 插件经 `contributes.composer` link 槽按 **scheme** 声明式注册增强器；
 * Markdown 渲染 link 时查表：命中 ⇒ 插件卡片；未命中 ⇒ 通用 scheme 白名单档
 * （http/https/mailto/锚点可点击；未知 scheme 渲染为不可点击文本，名称+目标可见）。
 * 放 components 层（Markdown 消费）：不依赖 domains，注册由 domains/plugins 侧写入。
 */

import type { VesselPluginHost } from '@vessel-agent/plugin-sdk';
import { type ComponentType, useSyncExternalStore } from 'react';

export interface LinkEnhancerProps {
  href: string;
  text: string;
  host: VesselPluginHost;
}

export interface LinkEnhancerEntry {
  pluginId: string;
  component: ComponentType<LinkEnhancerProps>;
  /** 注册时构造好的宿主对象（按 pluginId 稳定）。 */
  host: VesselPluginHost;
}

const enhancers = new Map<string, LinkEnhancerEntry>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function registerLinkEnhancer(scheme: string, entry: LinkEnhancerEntry): void {
  enhancers.set(scheme, entry);
  notify();
}

export function unregisterLinkEnhancers(pluginId: string): void {
  let changed = false;
  for (const [scheme, entry] of [...enhancers]) {
    if (entry.pluginId === pluginId) {
      enhancers.delete(scheme);
      changed = true;
    }
  }
  if (changed) notify();
}

/** href 的 scheme（小写）；无 scheme = 空串。 */
export function hrefScheme(href: string): string {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href.trim());
  return match?.[1]?.toLowerCase() ?? '';
}

/** 查 href 命中的增强器（订阅注册变化）；无 ⇒ undefined（落通用白名单档）。 */
export function useLinkEnhancer(href: string): LinkEnhancerEntry | undefined {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  const scheme = hrefScheme(href);
  return scheme === '' ? undefined : enhancers.get(scheme);
}
