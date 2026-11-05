/**
 * 主导航模型（CONTRACT-0.43 §2.10 E6）。
 *
 * 核心 domain 与插件页面都变成 `NavGroup → NavItem` 数据项；渲染组件只消费
 * 模型，不再为每个来源写一段 JSX。匹配规则按稳定 key，不按显示名称。
 */
import type { PluginNavGroupItem, PluginPageItem } from '../domains/plugins/plugin-contributions';
import { t } from '../i18n';
import {
  domainLabel,
  isDomainActive,
  NAV_GROUPS,
  navGroupLabel,
  type PrimaryDomain,
  primaryRoute,
} from './nav';
import type { NavStatuses, NavStatusMeta } from './nav-status';
import type { Domain, Route } from './router';

export interface NavItemModel {
  id: string;
  title: string;
  icon: Domain;
  route: Route;
  active: boolean;
  status?: NavStatusMeta;
}

export interface NavGroupModel {
  id: string;
  title: string;
  icon?: Domain;
  order: number;
  collapsible: boolean;
  items: NavItemModel[];
}

/** 核心分组图标（标题仍走 i18n）。 */
const CORE_GROUP_ICONS: Record<string, Domain> = {
  chat: 'chat',
  network: 'agents',
  runs: 'runs',
  integrations: 'tools',
  core: 'hub',
  settings: 'settings',
};

function statusOf(domain: PrimaryDomain, statuses: NavStatuses): NavStatusMeta | undefined {
  if (domain === 'hub') return statuses.hub;
  if (domain === 'gateway') return statuses.gateway;
  return undefined;
}

function coreItem(domain: PrimaryDomain, route: Route, statuses: NavStatuses): NavItemModel {
  const status = statusOf(domain, statuses);
  return {
    id: `domain:${domain}`,
    title: domainLabel(domain),
    icon: domain,
    route: primaryRoute(domain),
    active: isDomainActive(route, domain),
    ...(status ? { status } : {}),
  };
}

function pageItem(page: PluginPageItem, currentRoute: Route): NavItemModel {
  return {
    id: `plugin:${page.pluginId}:${page.id}`,
    title: page.titleKey ? t(page.titleKey) : page.title,
    icon: page.icon ?? 'plugins',
    route: { domain: 'plugins', pluginId: page.pluginId, entry: page.entry },
    active:
      currentRoute.domain === 'plugins' &&
      currentRoute.pluginId === page.pluginId &&
      (currentRoute.entry === undefined || currentRoute.entry === page.entry),
  };
}

function pagesFor(pages: readonly PluginPageItem[], nav: string, route: Route): NavItemModel[] {
  return pages
    .filter((page) => page.nav === nav)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
    .map((page) => pageItem(page, route));
}

/** 插件页面按 nav key 追加；核心项保持固定顺序。 */
export function buildNavModel({
  route,
  pluginPages,
  pluginNavGroups,
  statuses,
}: {
  route: Route;
  pluginPages: readonly PluginPageItem[];
  pluginNavGroups: readonly PluginNavGroupItem[];
  statuses: NavStatuses;
}): NavGroupModel[] {
  const groups: NavGroupModel[] = [];
  const push = (group: NavGroupModel) => {
    if (group.items.length > 0) groups.push(group);
  };

  push({
    id: 'top',
    title: navGroupLabel('top'),
    icon: 'plugins',
    order: 0,
    collapsible: true,
    items: pagesFor(pluginPages, 'top', route),
  });

  NAV_GROUPS.forEach((group, index) => {
    const items = group.domains.map((domain) => coreItem(domain, route, statuses));
    // 旧 `observe` 槽位并入 orchestration 组；旧 `status` key 并入 core。
    if (group.id === 'network') items.push(...pagesFor(pluginPages, 'observe', route));
    if (group.id === 'core') items.push(...pagesFor(pluginPages, 'status', route));
    items.push(...pagesFor(pluginPages, group.id, route));
    push({
      id: group.id,
      title: navGroupLabel(group.id),
      icon: CORE_GROUP_ICONS[group.id],
      order: index + 1,
      collapsible: true,
      items,
    });
  });

  const coreCount = groups.length;
  push({
    id: 'plugins',
    title: navGroupLabel('plugins'),
    icon: 'plugins',
    order: coreCount,
    collapsible: true,
    items: pagesFor(pluginPages, 'plugins', route),
  });

  // 自定义分组：内置组之后，按 navGroups[].order 升序。
  const customGroups = [...pluginNavGroups]
    .sort((a, b) => a.order - b.order)
    .map<NavGroupModel>((group) => ({
      id: group.id,
      title: group.title,
      icon: group.icon ?? 'plugins',
      order: group.order,
      collapsible: true,
      items: pagesFor(pluginPages, group.id, route),
    }));
  for (const group of customGroups) push(group);

  return groups;
}
