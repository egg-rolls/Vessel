import { t } from '../i18n';
import type { Domain, Route } from './router';

export type PrimaryDomain = Exclude<Domain, 'plugins'>;

export interface DomainDef {
  id: Domain;
}

/**
 * 主领域；Settings 固定在底部（D1）。label 走 i18n，随 locale 变化。
 * Observe 已收敛为 Diagnostics（DECISION-044 §8），默认不出现在主导航；
 * `#/observe/*` 路由与面板保留，由 Gateway 页 / 移动端 More 提供入口。
 */
export const DOMAINS: readonly (DomainDef & { id: PrimaryDomain })[] = [
  { id: 'chat' },
  { id: 'agents' },
  { id: 'teams' },
  { id: 'nodes' },
  { id: 'tenants' },
  { id: 'runs' },
  { id: 'tools' },
  { id: 'mcp' },
  { id: 'channels' },
  { id: 'hub' },
  { id: 'gateway' },
  { id: 'capabilities' },
  { id: 'settings' },
  { id: 'visual' },
];

/**
 * 桌面侧栏分组；只影响导航展示，不改变路由。
 * Chat 组承载会话与团队；编排组只剩 Agents → Nodes。
 */
export const NAV_GROUPS: readonly {
  id: string;
  domains: readonly PrimaryDomain[];
}[] = [
  { id: 'chat', domains: ['chat', 'teams'] },
  { id: 'network', domains: ['agents', 'nodes', 'tenants'] },
  { id: 'runs', domains: ['runs'] },
  { id: 'integrations', domains: ['tools', 'mcp', 'channels'] },
  { id: 'core', domains: ['hub', 'gateway', 'capabilities'] },
  { id: 'settings', domains: ['settings', 'visual'] },
];

/** 主导航项的默认落点（不改路由；供 NavModel / 命令面板 / 移动端共用）。 */
export function primaryRoute(domain: PrimaryDomain): Route {
  switch (domain) {
    case 'chat':
      return { domain: 'chat' };
    case 'hub':
      return { domain: 'hub' };
    case 'gateway':
      return { domain: 'gateway' };
    case 'nodes':
      return { domain: 'nodes' };
    case 'teams':
      return { domain: 'teams' };
    case 'agents':
      return { domain: 'agents' };
    case 'runs':
      return { domain: 'runs', tab: 'live' };
    case 'tools':
      return { domain: 'tools' };
    case 'mcp':
      return { domain: 'mcp' };
    case 'channels':
      return { domain: 'channels' };
    case 'tenants':
      return { domain: 'tenants' };
    case 'capabilities':
      return { domain: 'capabilities' };
    case 'visual':
      return { domain: 'visual' };
    case 'settings':
      return { domain: 'settings' };
    case 'observe':
      return { domain: 'observe', tab: 'metrics' };
  }
}

export function domainLabel(domain: Domain): string {
  return t(`nav.domain.${domain}`);
}

export function navGroupLabel(groupId: string): string {
  return t(`nav.group.${groupId}`);
}

export function isDomainActive(route: Route, domain: Domain): boolean {
  return route.domain === domain;
}

/** 顶栏路径文本（不放 gateway/token 表单）。 */
export function routeBreadcrumb(route: Route): string {
  switch (route.domain) {
    case 'chat':
      return route.sessionId ? t('breadcrumb.chat.session') : t('breadcrumb.chat');
    case 'runs': {
      const tab =
        route.tab === 'durable' ? t('breadcrumb.runs.durable') : t('breadcrumb.runs.live');
      return route.runId
        ? t('breadcrumb.runs.detailRun', { tab })
        : t('breadcrumb.runs.detail', { tab });
    }
    case 'hub':
      return t('breadcrumb.hub');
    case 'gateway':
      return t('breadcrumb.gateway');
    case 'nodes':
      return route.nodeKey
        ? t('breadcrumb.nodes.detail', { node: route.nodeKey })
        : t('breadcrumb.nodes');
    case 'teams':
      if (!('teamId' in route)) return t('breadcrumb.teams');
      return route.agentId
        ? t('breadcrumb.teams.agent')
        : t('breadcrumb.teams.detail', { team: route.teamId });
    case 'agents':
      return t('breadcrumb.agents');
    case 'tools':
      return t('breadcrumb.tools');
    case 'mcp':
      return t('breadcrumb.mcp');
    case 'channels':
      return t('breadcrumb.channels');
    case 'observe':
      return t(`breadcrumb.observe.${route.tab}`);
    case 'plugins':
      return t('breadcrumb.plugins');
    case 'tenants':
      return t('breadcrumb.tenants');
    case 'capabilities':
      return t('breadcrumb.capabilities');
    case 'visual':
      return t('breadcrumb.visual');
    case 'settings':
      return t('breadcrumb.settings');
  }
}
