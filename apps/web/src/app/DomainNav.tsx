import { type Ref, useState } from 'react';
import { ResizeHandle } from '../components/ResizeHandle';
import { IconButton } from '../components/Tooltip';
import { cn } from '../components/ui/cn';
import { PluginPanelList } from '../domains/plugins/PluginPanels';
import { panelsForSlot, usePluginContributions } from '../domains/plugins/usePluginContributions';
import { t, useLocale } from '../i18n';
import type { NavMode } from './layout';
import { NavGroup } from './NavGroup';
import { buildNavModel } from './nav-model';
import type { Route } from './router';
import { useNavStatus } from './useNavStatus';
import type { PaneResizeApi } from './usePaneResize';

const COLLAPSED_GROUPS_KEY = 'vessel.nav.collapsed-groups';

function readCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === 'string'));
  } catch {
    return new Set();
  }
}

function writeCollapsedGroups(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...ids]));
  } catch {
    // 隐私模式 / 配额满：本次会话内仍然生效。
  }
}

/**
 * 主导航：数据驱动的 NavModel + 单一滚动区。
 *
 * 顶部品牌 / 收起展开 / 抽屉关闭固定；分组、条目、插件面板统一放进一个
 * `overflow-y-auto` 滚动容器。分组头可折叠，默认展开并持久化折叠 key。
 */
export function DomainNav({
  route,
  navigate,
  mode,
  open = false,
  onClose,
  onToggleCollapsed,
  navRef,
  panes,
}: {
  route: Route;
  navigate: (route: Route) => void;
  mode: NavMode;
  open?: boolean;
  onClose?: () => void;
  onToggleCollapsed?: () => void;
  navRef?: Ref<HTMLElement>;
  panes: PaneResizeApi;
}) {
  useLocale();
  const statuses = useNavStatus();
  const {
    pages: pluginPages,
    navGroups: pluginNavGroups,
    panels: pluginPanels,
    methodsByPlugin,
  } = usePluginContributions();
  const [collapsedGroups, setCollapsedGroups] = useState(readCollapsedGroups);
  const navPanels = panelsForSlot(pluginPanels, 'nav');
  const groups = buildNavModel({ route, pluginPages, pluginNavGroups, statuses });

  const drawer = mode === 'drawer';
  const collapsed = mode === 'collapsed' || mode === 'rail';
  const showLabels = !collapsed;
  const showCollapseToggle = mode === 'expanded' || mode === 'collapsed';
  const collapseLabel = collapsed ? t('nav.expandNav') : t('nav.collapseNav');
  const drawerA11y = drawer ? { role: 'dialog' as const, 'aria-modal': open } : {};

  const toggleGroup = (id: string) => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeCollapsedGroups(next);
      return next;
    });
  };

  const navClass = cn(
    'flex flex-none flex-col overflow-hidden bg-surface',
    drawer
      ? 'fixed inset-y-0 left-0 z-[var(--z-drawer)] min-h-0 w-[min(86vw,var(--drawer-w))] shadow-elev-3 transition-[transform,visibility] duration-[var(--motion-ui)] ease-[var(--ease)]'
      : 'relative min-h-0',
    drawer &&
      (open ? 'visible translate-x-0 transition-[transform]' : 'invisible -translate-x-full'),
    !drawer &&
      (mode === 'collapsed'
        ? 'w-[var(--nav-w-collapsed)]'
        : mode === 'rail'
          ? 'w-[var(--nav-w-rail)]'
          : 'w-[var(--nav-w)]'),
  );

  return (
    <nav
      {...drawerA11y}
      ref={navRef}
      id="domain-nav"
      className={navClass}
      aria-label={t('nav.mainLabel')}
      inert={drawer && !open ? true : undefined}
      aria-hidden={drawer && !open ? true : undefined}
    >
      {mode !== 'rail' && (
        <div
          className={cn(
            'flex flex-none items-center gap-2 px-4 pt-3 pb-2',
            mode === 'collapsed' && 'justify-center gap-0.5 px-0',
          )}
        >
          <span className="font-serif text-xl font-semibold text-accent" aria-hidden="true">
            V
          </span>
          {showCollapseToggle && (
            <IconButton
              className={cn('size-6 text-xs', collapsed ? 'ml-0' : 'ml-auto')}
              label={collapseLabel}
              aria-label={collapseLabel}
              aria-expanded={!collapsed}
              onClick={onToggleCollapsed}
            >
              {collapsed ? '»' : '«'}
            </IconButton>
          )}
          {drawer && (
            <IconButton
              className="ml-auto"
              label={t('nav.closeNav')}
              aria-label={t('nav.closeNav')}
              onClick={onClose}
            >
              ×
            </IconButton>
          )}
        </div>
      )}
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain py-1.5',
          collapsed ? 'px-2' : 'px-2.5',
        )}
      >
        {groups.map((group, index) => (
          <NavGroup
            key={group.id}
            group={group}
            collapsed={collapsed}
            expanded={!collapsedGroups.has(group.id)}
            onToggle={() => toggleGroup(group.id)}
            onNavigate={navigate}
            {...(index > 0 ? { className: 'mt-3' } : {})}
          />
        ))}
        {/* nav 槽位：折叠 rail 放不下 iframe，只在展开 / 抽屉宽度渲染。 */}
        {showLabels && (
          <PluginPanelList
            items={navPanels}
            methodsByPlugin={methodsByPlugin}
            dense
            className="mt-2 mb-2"
          />
        )}
      </div>
      {mode === 'expanded' && !panes.disabled('nav') && (
        <ResizeHandle
          pane="nav"
          api={panes}
          label={t('resize.nav')}
          className="resize-handle resize-handle-nav"
        />
      )}
    </nav>
  );
}
