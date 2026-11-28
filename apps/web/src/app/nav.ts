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
  { id: 'pending' },
  { id: 'agents' },
  { id: 'teams' },
  { id: 'kanban' },
  { id: 'nodes' },
  { id: 'runs' },
  { id: 'tools' },
  { id: 'mcp' },
  { id: 'channels' },
  { id: 'hub' },
  { id: 'gateway' },
  { id: 'pluginHost' },
  { id: 'capabilities' },
  { id: 'settings' },
  { id: 'visual' },
  { id: 'designLab' },
];

/**
 * 桌面侧栏分组；只影响导航展示，不改变路由。
 * 会话组 = 沟通协作（会话 / 收件箱 / 团队）；事项组 = 待我行动（待批 / 看板），
 * 紧随会话之后（用户裁定，sidebar-restructure 设计 §4）。编排组只剩 Agents → Nodes。
 */
export const NAV_GROUPS: readonly {
  id: string;
  domains: readonly PrimaryDomain[];
}[] = [
  { id: 'chat', domains: ['chat', 'teams'] },
  { id: 'items', domains: ['pending', 'kanban'] },
  { id: 'network', domains: ['agents', 'nodes'] },
  { id: 'runs', domains: ['runs'] },
  { id: 'integrations', domains: ['capabilities', 'tools', 'mcp', 'channels'] },
  { id: 'core', domains: ['hub', 'gateway', 'pluginHost'] },
  // 裁定③④⑤：settings 分组三个导航点全部移除——设置入口 = 右上角齿轮 / Ctrl+, /
  // AccountMenu / 命令面板 / 移动端 More；visual 由路由别名进弹窗（S2）。
  // designLab 恢复整页（q-design-lab-restore）：入口 = 命令面板 + 移动端 More，
  // 侧栏不加组（沿用 settings 组移除裁定）；DOMAINS 保留 visual id 供图标/文案复用。
];

/** 主导航项的默认落点（不改路由；供 NavModel / 命令面板 / 移动端共用）。 */
export function primaryRoute(domain: PrimaryDomain): Route {
  switch (domain) {
    case 'chat':
      return { domain: 'chat' };
    case 'pending':
      return { domain: 'pending' };
    case 'hub':
      return { domain: 'hub' };
    case 'gateway':
      return { domain: 'gateway' };
    case 'pluginHost':
      return { domain: 'pluginHost' };
    case 'nodes':
      return { domain: 'nodes' };
    case 'teams':
      return { domain: 'teams' };
    case 'kanban':
      return { domain: 'kanban' };
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
    case 'capabilities':
      return { domain: 'capabilities' };
    case 'visual':
      // S6：legacy 导航 id → 设置弹窗视觉分类（与 parseRoute 别名一致）。
      return { domain: 'settings', category: 'visual' };
    case 'designLab':
      // q-design-lab-restore：恢复整页（与 parseRoute 一致）。
      return { domain: 'designLab' };
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

/**
 * 面包屑分段（q-breadcrumb-clickable）：每段自带导航目标，全段可点击。
 * `route` = 壳层路由；`hash` = 直接 hash 导航（agent 深链不在壳层 Route 里）。
 * 末段 = 当前页（route 即当前路由，点击导航自身，保留深链参数）。
 */
export interface BreadcrumbSegment {
  label: string;
  route?: Route;
  hash?: string;
}

/**
 * 顶栏路径分段（不放 gateway/token 表单）。
 *
 * `nodeNames`（nodeKey → 展示名，`useNodeNames()` 的结果）缺省 = 空表：节点详情
 * 面包屑退 nodeKey 原文（不丢深链语义，URL hash 不变）。拿到名字时显示名字而非
 * UUID（问题3：详情页标题早有名字，顶栏却直显 node id）。
 *
 * 父级段导航到所属列表（保留 tab 等视图参数），末段导航当前路由自身。
 */
export function routeBreadcrumbSegments(
  route: Route,
  nodeNames?: ReadonlyMap<string, string>,
): BreadcrumbSegment[] {
  switch (route.domain) {
    case 'chat':
      return route.sessionId
        ? [
            { label: t('breadcrumb.chat'), route: { domain: 'chat' } },
            { label: t('breadcrumb.chat.conversation'), route },
          ]
        : [{ label: t('breadcrumb.chat'), route }];
    case 'pending':
      return [{ label: t('breadcrumb.pending'), route }];
    case 'runs': {
      const list: Route = { domain: 'runs', tab: route.tab };
      const tab =
        route.tab === 'durable' ? t('breadcrumb.runs.durable') : t('breadcrumb.runs.live');
      const segments: BreadcrumbSegment[] = [
        { label: t('breadcrumb.runs'), route: list },
        { label: tab, route: route.runId ? list : route },
      ];
      if (route.runId) segments.push({ label: t('breadcrumb.runs.details'), route });
      return segments;
    }
    case 'hub':
      return [{ label: t('breadcrumb.hub'), route }];
    case 'gateway':
      return [{ label: t('breadcrumb.gateway'), route }];
    case 'pluginHost':
      return [{ label: t('breadcrumb.pluginHost'), route }];
    case 'nodes':
      return route.nodeKey
        ? [
            { label: t('breadcrumb.nodes'), route: { domain: 'nodes' } },
            { label: nodeNames?.get(route.nodeKey) ?? route.nodeKey, route },
          ]
        : [{ label: t('breadcrumb.nodes'), route }];
    case 'teams':
      if (!('teamId' in route)) return [{ label: t('breadcrumb.teams'), route }];
      return [
        { label: t('breadcrumb.teams'), route: { domain: 'teams' } },
        { label: route.agentId ? t('breadcrumb.teams.agent') : route.teamId, route },
      ];
    case 'agents':
      return [{ label: t('breadcrumb.agents'), route }];
    case 'tools':
      return [{ label: t('breadcrumb.tools'), route }];
    case 'mcp':
      return [{ label: t('breadcrumb.mcp'), route }];
    case 'channels':
      return [{ label: t('breadcrumb.channels'), route }];
    case 'kanban':
      return [{ label: t('breadcrumb.kanban'), route }];
    case 'observe':
      return [
        { label: t('breadcrumb.observe'), route: { domain: 'observe', tab: 'metrics' } },
        { label: t(`breadcrumb.observe.${route.tab}`), route },
      ];
    case 'plugins':
      return [{ label: t('breadcrumb.plugins'), route }];
    case 'capabilities':
      return [{ label: t('breadcrumb.capabilities'), route }];
    case 'designLab':
      return [{ label: t('breadcrumb.designLab'), route }];
    case 'settings':
      return [{ label: t('breadcrumb.settings'), route }];
  }
}

/** 扁平文案（AppShell 导航播报用）：分段 label 以「›」连接，与旧口径一致。 */
export function routeBreadcrumb(route: Route, nodeNames?: ReadonlyMap<string, string>): string {
  return routeBreadcrumbSegments(route, nodeNames)
    .map((segment) => segment.label)
    .join(' › ');
}
