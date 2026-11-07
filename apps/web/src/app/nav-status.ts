/**
 * Status 导航组的状态点推导（纯函数，便于单测）。
 *
 * - Gateway 的「live」状态来自 WebSocket 连接状态；
 * - Hub 状态来自 Hub 页直连的快照（`gateway/platform/hub-storage`），不再从
 *   `config.get.hub` 推导；未配置时 muted，未访问过 Hub 页时按「未知」处理；
 * - 版本来自 `config.get` 的 additive `version` 字段，旧 gateway 缺失时显示 `—`。
 *
 * 需要 React 绑定时用 `useNavStatus.ts`，本文件不 import provider。
 */

import type { ConnectionState } from '../gateway/client';
import type { HubNavStatus } from '../gateway/platform/hub-storage';
import type { PluginListItem } from '../gateway/types';

export type NavStatusTone = 'ok' | 'warn' | 'danger' | 'muted';

export interface NavStatusMeta {
  tone: NavStatusTone;
  /** 状态文案的 i18n key；导航点使用它作为 aria-label / tooltip。 */
  labelKey: string;
  /** 进程版本；缺失时由调用方显示 `—`。 */
  version?: string;
}

export function gatewayNavStatus(
  connectionState: ConnectionState,
  hasToken: boolean,
): NavStatusMeta {
  if (!hasToken) return { tone: 'muted', labelKey: 'nav.status.offline' };
  if (connectionState === 'open') return { tone: 'ok', labelKey: 'nav.status.online' };
  if (connectionState === 'connecting' || connectionState === 'reconnecting') {
    return { tone: 'warn', labelKey: 'nav.status.connecting' };
  }
  if (connectionState === 'closed' || connectionState === 'error') {
    return { tone: 'danger', labelKey: 'nav.status.error' };
  }
  return { tone: 'muted', labelKey: 'nav.status.unknown' };
}

/** Hub 状态点：只反映浏览器 → Hub 的直连状态，不借用 gateway 连接。 */
export function hubNavStatus(status: HubNavStatus): NavStatusMeta {
  switch (status) {
    case 'unconfigured':
      return { tone: 'muted', labelKey: 'nav.status.hubNotConfigured' };
    case 'loading':
      return { tone: 'warn', labelKey: 'nav.status.connecting' };
    case 'connected':
    case 'empty':
      return { tone: 'ok', labelKey: 'nav.status.hubConnected' };
    case 'unauthorized':
      return { tone: 'danger', labelKey: 'nav.status.hubUnauthorized' };
    case 'incompatible':
      return { tone: 'danger', labelKey: 'nav.status.hubIncompatible' };
    case 'network':
      return { tone: 'warn', labelKey: 'nav.status.hubNetwork' };
    default:
      return { tone: 'muted', labelKey: 'nav.status.unknown' };
  }
}

/**
 * 插件宿主状态点：版本取 `plugins.list` 里 marketplace 条目的 `version`。
 * 缺失条目 / 未启用 / 未知状态一律 muted；unhealthy / invalid 才算 danger。
 */
export function pluginHostNavStatus(marketplace: PluginListItem | undefined): NavStatusMeta {
  const base = marketplace?.version !== undefined ? { version: marketplace.version } : {};
  if (!marketplace) {
    return { tone: 'muted', labelKey: 'nav.status.unknown', ...base };
  }
  if (!marketplace.enabled) {
    return { tone: 'muted', labelKey: 'pluginHost.enabled.off', ...base };
  }
  switch (marketplace.status) {
    case 'active':
      return { tone: 'ok', labelKey: 'pluginHost.status.active', ...base };
    case 'unhealthy':
    case 'invalid':
      return { tone: 'danger', labelKey: `pluginHost.status.${marketplace.status}`, ...base };
    case 'disabled':
      return { tone: 'muted', labelKey: 'pluginHost.status.disabled', ...base };
    case 'inactive':
      return { tone: 'muted', labelKey: 'pluginHost.status.inactive', ...base };
    default:
      return { tone: 'muted', labelKey: 'nav.status.unknown', ...base };
  }
}

export interface NavStatuses {
  hub: NavStatusMeta;
  gateway: NavStatusMeta;
  pluginHost: NavStatusMeta;
}
