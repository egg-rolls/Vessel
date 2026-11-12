/**
 * 菜单按钮（app/NavGroup + app/NavItem）：分组头 + 六种状态点（四档语义 + 网关的 ok / warn）
 * + 折叠态（只有图标，靠 Tooltip 带出文案）。
 *
 * 状态文案全部来自 NavStatusMeta.labelKey，颜色由 NavItem 自己的 data-tone 决定 ——
 * 这里不复制任何一份状态表。
 */
import { NavGroup } from '../../../../app/NavGroup';
import { NavItem } from '../../../../app/NavItem';
import type { NavGroupModel, NavItemModel } from '../../../../app/nav-model';
import type { Route } from '../../../../app/router';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'NavItem',
  descriptionKey: 'designLab.preview.navItem.desc',
  group: 'nav',
  order: 10,
};

const HUBS: Route = { domain: 'hub' };
const GATEWAY: Route = { domain: 'gateway' };
const TOOLS: Route = { domain: 'tools' };

/** 四档语义里的「已连接」（accent）+ 计数徽标。 */
const CONNECTED: NavItemModel = {
  id: 'demo:hub-connected',
  title: 'hub (connected)',
  icon: 'hub',
  route: HUBS,
  active: true,
  status: { tone: 'accent', labelKey: 'nav.status.hubConnected', version: '0.50.0' },
  count: 3,
};

const ITEMS: readonly NavItemModel[] = [
  CONNECTED,
  {
    id: 'demo:hub-loading',
    title: 'hub (probing)',
    icon: 'hub',
    route: HUBS,
    active: false,
    status: { tone: 'amber', labelKey: 'nav.status.connecting' },
  },
  {
    id: 'demo:hub-unauthorized',
    title: 'hub (unauthorized)',
    icon: 'hub',
    route: HUBS,
    active: false,
    status: { tone: 'danger', labelKey: 'nav.status.hubUnauthorized' },
  },
  {
    id: 'demo:hub-unconfigured',
    title: 'hub (unconfigured)',
    icon: 'hub',
    route: HUBS,
    active: false,
    status: { tone: 'muted', labelKey: 'nav.status.hubNotConfigured' },
  },
  {
    id: 'demo:gateway-online',
    title: 'gateway (online)',
    icon: 'gateway',
    route: GATEWAY,
    active: false,
    status: { tone: 'ok', labelKey: 'nav.status.online', version: '0.50.0' },
  },
  {
    id: 'demo:gateway-connecting',
    title: 'gateway (connecting)',
    icon: 'gateway',
    route: GATEWAY,
    active: false,
    status: { tone: 'warn', labelKey: 'nav.status.connecting' },
  },
];

const PLAIN: NavItemModel = {
  id: 'demo:tools',
  title: 'tools',
  icon: 'tools',
  route: TOOLS,
  active: false,
};

/** 分组标题走 i18n，所以在渲染期构造（模块级 t() 不会跟着语言切换刷新）。 */
function groupModel(): NavGroupModel {
  return {
    id: 'design-lab-nav',
    title: t('nav.group.core'),
    icon: 'hub',
    order: 0,
    collapsible: true,
    items: [...ITEMS],
  };
}

const NOOP_NAVIGATE = (_route: Route): void => undefined;

export default function NavItemPreview() {
  return (
    <div className="flex flex-col gap-4">
      <div className="w-64 max-w-full rounded-sm bg-surface p-2">
        <NavGroup
          group={groupModel()}
          collapsed={false}
          expanded
          onToggle={() => undefined}
          onNavigate={NOOP_NAVIGATE}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-14 rounded-sm bg-surface p-2">
          <NavItem item={CONNECTED} collapsed onNavigate={NOOP_NAVIGATE} />
        </div>
        <p className="max-w-prose text-sm text-muted">{t('designLab.preview.navItem.collapsed')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-56 rounded-sm bg-surface p-1">
          <NavItem item={PLAIN} collapsed={false} onNavigate={NOOP_NAVIGATE} />
        </div>
        <p className="max-w-prose text-sm text-muted">{t('designLab.preview.navItem.plain')}</p>
      </div>
    </div>
  );
}
