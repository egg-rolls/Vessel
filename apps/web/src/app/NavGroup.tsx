/**
 * 主导航分组：可折叠 header + NavItem 列表。
 * 分区收展走 motion.css 的 `.motion-panel`（grid 0fr↔1fr，时长覆写为
 * --motion-base = 200ms）；内容常驻挂载，收起终态 inert + aria-hidden。
 * rail / collapsed 模式不渲染组头、图标项恒显，分区开合概念不适用。
 */
import type { CSSProperties } from 'react';
import { CountBadge } from '../components/ui';
import { cn } from '../components/ui/cn';
import { t } from '../i18n';
import { NavItem } from './NavItem';
import type { NavGroupModel } from './nav-model';
import type { Route } from './router';

/** 分区收展 200ms（用户裁定）：覆写 .motion-panel 缺省的 --motion-slow，不写裸毫秒。 */
const PANEL_STYLE = { '--motion-panel-duration': 'var(--motion-base)' } as CSSProperties;

export function NavGroup({
  group,
  collapsed,
  expanded,
  onToggle,
  onNavigate,
  className,
}: {
  group: NavGroupModel;
  collapsed: boolean;
  expanded: boolean;
  onToggle: () => void;
  onNavigate: (route: Route) => void;
  className?: string;
}) {
  const animated = !collapsed && group.collapsible;
  const items = group.items.map((item) => (
    <NavItem key={item.id} item={item} collapsed={collapsed} onNavigate={onNavigate} />
  ));

  // 收起态信息保真（设计 §5.5 / D5）：聚合计数徽标 + active 圆点**仅组收起时**上组头，
  // 展开时项级徽标已可见，不重复。待批积压不可见是不可接受的回归。
  const headerCollapsed = !collapsed && !expanded;
  const groupCount = headerCollapsed ? group.count : undefined;
  const hasActive = headerCollapsed && group.items.some((item) => item.active);
  const countText =
    groupCount !== undefined && groupCount > 0 ? t('nav.count', { count: groupCount }) : undefined;
  // 徽标 / 圆点都进组头可达名（沿用 NavItem 的 t('nav.count') 模式）。
  const headerLabel = [group.title, countText, hasActive ? t('nav.group.current') : undefined]
    .filter((part): part is string => part !== undefined)
    .join(' · ');

  return (
    <div className={cn('flex flex-col', className)}>
      {!collapsed && (
        <button
          type="button"
          className="flex w-full items-center gap-2 overflow-hidden rounded-sm bg-transparent px-3 pt-1 pb-0.5 text-left font-mono text-2xs tracking-[var(--tracking-wide)] text-faint uppercase transition-colors hover:bg-transparent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          aria-expanded={expanded}
          aria-label={headerLabel}
          onClick={onToggle}
        >
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {group.title}
          </span>
          {hasActive && (
            <span aria-hidden="true" className="size-1.5 flex-none rounded-full bg-accent" />
          )}
          {groupCount !== undefined && (
            <CountBadge count={groupCount} label={countText} tone="muted" />
          )}
          <span aria-hidden="true" className="flex-none text-2xs">
            {expanded ? '▾' : '▸'}
          </span>
        </button>
      )}
      {animated ? (
        <div
          className="motion-panel"
          style={PANEL_STYLE}
          data-motion-open={expanded ? '' : undefined}
        >
          {/* 收起即 inert（不等 transitionend）：inert 不影响高度过渡，无竞态；
              Tab 不落入隐藏项，读屏不播报。动画 class 不管可访问性（契约②）。 */}
          <div
            className="motion-panel-inner"
            inert={!expanded ? true : undefined}
            aria-hidden={!expanded ? true : undefined}
          >
            <div className="flex flex-col gap-0.5 pt-0.5">{items}</div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">{items}</div>
      )}
    </div>
  );
}
