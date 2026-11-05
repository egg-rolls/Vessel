/**
 * Status 导航组的状态点推导（纯函数，便于单测）。
 *
 * - Gateway 的「live」状态来自 WebSocket 连接状态；
 * - Hub 没有独立健康 RPC，只能从 `config.get.hub` 推导（见 DECISION-039），
 *   连接断开时按「未知」处理；
 * - 版本来自 `config.get` 的 additive `version` 字段，旧 gateway 缺失时显示 `—`。
 *
 * 需要 React 绑定时用 `useNavStatus.ts`，本文件不 import provider。
 */
import type { HubInfo } from '../domains/hub/hub-state';
import type { ConnectionState } from '../gateway/client';
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

/** Hub 状态点：gateway 不通时不谎报在线；未启用显示 muted。 */
export function hubNavStatus(
  hub: HubInfo | undefined,
  gateway: NavStatusMeta,
  hasToken: boolean,
  version?: string,
): NavStatusMeta {
  const base = version !== undefined ? { version } : {};
  if (!hasToken) return { tone: 'muted', labelKey: 'nav.status.offline', ...base };
  if (!hub) {
    // config 尚未返回：gateway 正常时 hub 仍是未知，不能提前报绿。
    return gateway.tone === 'ok'
      ? { tone: 'muted', labelKey: 'nav.status.unknown', ...base }
      : { tone: gateway.tone, labelKey: gateway.labelKey, ...base };
  }
  if (hub.state === 'not_configured') {
    return { tone: 'muted', labelKey: 'nav.status.hubNotConfigured', ...base };
  }
  if (gateway.tone !== 'ok') {
    return { tone: gateway.tone, labelKey: gateway.labelKey, ...base };
  }
  return {
    tone: 'ok',
    labelKey: hub.state === 'joined' ? 'nav.status.hubJoined' : 'nav.status.hubLocal',
    ...base,
  };
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
