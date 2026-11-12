/**
 * Status 导航组的状态点推导（纯函数，便于单测）。
 *
 * - Gateway 的「live」状态来自 WebSocket 连接状态；
 * - Hub 状态来自浏览器 → Hub 的直连快照（`gateway/platform/hub-storage`），不再从
 *   `config.get.hub` 推导：启动探测（`useNavStatus` 的 `probeHubNavStatus`）与 Hub 页
 *   共写同一份 store；未配置时 muted，还没探到时按「未知」处理；
 * - 版本来自 `config.get` 的 additive `version` 字段，旧 gateway 缺失时显示 `—`。
 *
 * 需要 React 绑定时用 `useNavStatus.ts`，本文件不 import provider。
 */

import type { ConnectionState } from '../gateway/client';
import type { HubNavStatus } from '../gateway/platform/hub-storage';
import type { PluginListItem } from '../gateway/types';

/**
 * 导航状态点色档：`ok`（成功）/ `warn`（中性灰提醒）/ `danger`（错误）/
 * `muted`（无 / 未知）/ `accent`（主题色，Hub 连上了）/ `amber`（真琥珀，进行中）。
 *
 * 后两档是给 Hub 状态点单独加的：用户要的四档是「主题色 = 连接成功、错误色 = 出错、
 * 灰 = 没配置、黄 = 正在连接」。`ok` 与 `warn` 的既有含义（网关连接点用）不变——
 * `gatewayNavStatus` 仍然只吐 `ok` / `warn` / `danger` / `muted`。
 */
export type NavStatusTone = 'ok' | 'warn' | 'danger' | 'muted' | 'accent' | 'amber';

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

/**
 * Hub 状态点：只反映浏览器 → Hub 的直连状态，不借用 gateway 连接。
 *
 * 四档语义（用户口径）：没配置 = 灰（muted）、探测中 = 黄（amber，本仓 `--warn` 是
 * 中性灰、`--amber` 才是真黄）、连上 = 主题色（accent）、出错 = 错误色（danger，
 * `unauthorized` / `incompatible` / `network` 三类共用红色，靠文案区分）。
 */
export function hubNavStatus(status: HubNavStatus): NavStatusMeta {
  switch (status) {
    case 'unconfigured':
      return { tone: 'muted', labelKey: 'nav.status.hubNotConfigured' };
    case 'loading':
      return { tone: 'amber', labelKey: 'nav.status.connecting' };
    case 'connected':
    case 'empty':
      return { tone: 'accent', labelKey: 'nav.status.hubConnected' };
    case 'unauthorized':
      return { tone: 'danger', labelKey: 'nav.status.hubUnauthorized' };
    case 'incompatible':
      return { tone: 'danger', labelKey: 'nav.status.hubIncompatible' };
    case 'network':
      return { tone: 'danger', labelKey: 'nav.status.hubNetwork' };
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
