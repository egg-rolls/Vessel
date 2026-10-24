import { t } from '../i18n';
import type { Domain, Route } from './router';

type SettingsTab = Extract<Route, { domain: 'settings' }>['tab'];

export type PrimaryDomain = Exclude<Domain, 'settings'>;

export interface DomainDef {
  id: Domain;
}

/** 主领域；Settings 固定在底部（D1）。label 走 i18n，随 locale 变化。 */
export const DOMAINS: readonly (DomainDef & { id: PrimaryDomain })[] = [
  { id: 'chat' },
  { id: 'hub' },
  { id: 'nodes' },
  { id: 'teams' },
  { id: 'agents' },
  { id: 'runs' },
  { id: 'integrations' },
  { id: 'observe' },
];

/** 桌面侧栏分组；只影响导航展示，不改变路由。 */
export const NAV_GROUPS: readonly {
  id: string;
  domains: readonly PrimaryDomain[];
}[] = [
  { id: 'chat', domains: ['chat'] },
  { id: 'network', domains: ['hub', 'nodes', 'teams', 'agents'] },
  { id: 'observe', domains: ['runs', 'observe'] },
  { id: 'integrations', domains: ['integrations'] },
];

export function domainLabel(domain: Domain): string {
  return t(`nav.domain.${domain}`);
}

export function navGroupLabel(groupId: string): string {
  return t(`nav.group.${groupId}`);
}

export function settingsTabLabel(tab: SettingsTab): string {
  return t(`settings.tab.${tab}`);
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
    case 'integrations':
      return t(`breadcrumb.integrations.${route.tab}`);
    case 'observe':
      return t(`breadcrumb.observe.${route.tab}`);
    case 'settings':
      return t('breadcrumb.settings', { tab: settingsTabLabel(route.tab) });
  }
}
