/** 主导航分组：可折叠 header + NavItem 列表。 */
import { cn } from '../components/ui/cn';
import { NavItem } from './NavItem';
import type { NavGroupModel } from './nav-model';
import type { Route } from './router';

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
  const showItems = collapsed || !group.collapsible || expanded;

  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      {!collapsed && (
        <button
          type="button"
          className="flex w-full items-center gap-2 overflow-hidden rounded-sm bg-transparent px-3 pt-1 pb-0.5 text-left font-mono text-2xs tracking-[var(--tracking-wide)] text-faint uppercase transition-colors hover:bg-transparent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          aria-expanded={expanded}
          aria-label={group.title}
          onClick={onToggle}
        >
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {group.title}
          </span>
          <span aria-hidden="true" className="flex-none text-2xs">
            {expanded ? '▾' : '▸'}
          </span>
        </button>
      )}
      {showItems &&
        group.items.map((item) => (
          <NavItem key={item.id} item={item} collapsed={collapsed} onNavigate={onNavigate} />
        ))}
    </div>
  );
}
