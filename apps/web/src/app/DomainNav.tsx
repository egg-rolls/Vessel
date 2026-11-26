import { type Ref, useState } from 'react';
import { ResizeHandle } from '../components/ResizeHandle';
import { IconButton } from '../components/Tooltip';
import { cn } from '../components/ui/cn';
import { PluginPanelList } from '../domains/plugins/PluginPanels';
import { panelsForSlot, usePluginContributions } from '../domains/plugins/usePluginContributions';
import { t, useLocale } from '../i18n';
import type { NavMode } from './layout';
import { NavGroup } from './NavGroup';
import type { PrimaryDomain } from './nav';
import { buildNavModel } from './nav-model';
import type { Route } from './router';
import { useNavStatus } from './useNavStatus';
import type { PaneResizeApi } from './usePaneResize';

const EXPANDED_GROUPS_KEY = 'vessel.nav.expanded-groups';
const LEGACY_COLLAPSED_GROUPS_KEY = 'vessel.nav.collapsed-groups';

/**
 * 分区开合缓存（sidebar-restructure 设计 D1）：存**展开集**，语义反转。
 * 无值 / 非法值 → 空集 = 全收起（含 core）——插件组异步到达、自定义组随插件
 * 增删，展开集语义下新组自动收起，与「默认全收起」裁定恒一致。
 * 不做旧值迁移（老用户一次性重置）；首次写入时顺手清旧 key。
 */
function readExpandedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_GROUPS_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === 'string'));
  } catch {
    return new Set();
  }
}

function writeExpandedGroups(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(EXPANDED_GROUPS_KEY, JSON.stringify([...ids]));
    localStorage.removeItem(LEGACY_COLLAPSED_GROUPS_KEY);
  } catch {
    // 隐私模式 / 配额满：本次会话内仍然生效。
  }
}

/**
 * 主导航：数据驱动的 NavModel + 单一滚动区。
 *
 * 顶部品牌 / 收起展开 / 抽屉关闭固定；分组、条目、插件面板统一放进一个
 * `overflow-y-auto` 滚动容器。分区默认全收起，点击组头展开，开合状态持久化
 * 到展开集 key（vessel.nav.expanded-groups）；多分区可同开，不互斥。
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
  counts,
}: {
  route: Route;
  navigate: (route: Route) => void;
  mode: NavMode;
  open?: boolean;
  onClose?: () => void;
  onToggleCollapsed?: () => void;
  navRef?: Ref<HTMLElement>;
  panes: PaneResizeApi;
  /** 核心项右侧计数（待批）；由外壳注入，侧栏不自己拉 pending 数据。 */
  counts?: Partial<Record<PrimaryDomain, number>>;
}) {
  const locale = useLocale();
  const {
    plugins,
    state: pluginsState,
    pages: pluginPages,
    navGroups: pluginNavGroups,
    i18nByPlugin,
    panels: pluginPanels,
    methodsByPlugin,
  } = usePluginContributions();
  // 插件宿主的点还要「读取中 / 无条目」的区分，所以把 plugins.list 的读取态一起传下去。
  const statuses = useNavStatus(plugins, pluginsState);
  const [expandedGroups, setExpandedGroups] = useState(readExpandedGroups);
  const navPanels = panelsForSlot(pluginPanels, 'nav');
  const groups = buildNavModel({
    route,
    pluginPages,
    pluginNavGroups,
    i18nByPlugin,
    locale,
    statuses,
    ...(counts !== undefined ? { counts } : {}),
  });

  const drawer = mode === 'drawer';
  const collapsed = mode === 'collapsed' || mode === 'rail';
  const showLabels = !collapsed;
  const showCollapseToggle = mode === 'expanded' || mode === 'collapsed';
  const collapseLabel = collapsed ? t('nav.expandNav') : t('nav.collapseNav');
  const drawerA11y = drawer ? { role: 'dialog' as const, 'aria-modal': open } : {};

  // 一次只动被点的分区，不做手风琴互斥（多分区可同时展开，习惯由缓存沉淀）。
  const toggleGroup = (id: string) => {
    setExpandedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeExpandedGroups(next);
      return next;
    });
  };

  // 展开 / 收起（expanded ↔ collapsed ↔ rail）过渡 width，内容区是 flex-auto 跟随
  // 布局逐帧让位，不需要自己再加过渡。时长走 --motion-base（200ms），不写裸毫秒。
  // 两个例外必须瞬切：
  // - 拖拽手柄调宽（ResizeHandle data-dragging）：preview 每帧写 --nav-w，带过渡
  //   会落后指针 200ms，:has() 命中时关掉（键盘微调 / 双击复位仍走过渡，属预期）；
  // - prefers-reduced-motion：base.css 已全局压掉 transition-duration，这里再显式
  //   钉死一次（与 motion.css 的三族同做法）。
  // 抽屉模式走上面的 transform/translate 过渡，宽度在屏外突变，不参与 width 过渡。
  // 注意 Tailwind v4 的 translate-x-* 写独立 CSS `translate` 属性（不是 transform），
  // transition 列表必须显式含 translate，否则开合都是单帧瞬移；open 态的
  // transition-[transform,translate] 覆盖只是去掉 visibility（开抽屉要立即可见）。
  const navClass = cn(
    'flex flex-none flex-col overflow-hidden bg-surface',
    drawer
      ? 'fixed inset-y-0 left-0 z-[var(--z-drawer)] min-h-0 w-[min(86vw,var(--drawer-w))] shadow-elev-3 transition-[transform,translate,visibility] duration-[var(--motion-ui)] ease-[var(--ease)]'
      : 'relative min-h-0 transition-[width] duration-[var(--motion-base)] ease-[var(--ease)] has-[[data-dragging]]:transition-none motion-reduce:transition-none',
    drawer &&
      (open
        ? 'visible translate-x-0 transition-[transform,translate]'
        : 'invisible -translate-x-full'),
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
            expanded={expandedGroups.has(group.id)}
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
