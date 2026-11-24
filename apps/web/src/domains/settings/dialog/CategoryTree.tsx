/**
 * 设置分类树（vscode-settings-design §3.4）：名称 + 命中计数；「常用」是 curated
 * 视图节点；扩展组动态追加插件子节点（S3）。compact = 顶部横向 chips（可横滑）。
 * 折叠态持久化 vessel.settings.tree.collapsed（父级负责读写）。
 */
import { CountBadge } from '../../../components/ui';
import { t } from '../../../i18n';

export interface CategoryNode {
  id: string;
  label: string;
  count?: number;
  children?: readonly CategoryNode[];
}

export interface CategoryTreeProps {
  nodes: readonly CategoryNode[];
  activeId: string;
  onSelect: (id: string) => void;
  compact?: boolean;
  collapsedIds: ReadonlySet<string>;
  onToggleCollapse: (id: string) => void;
}

export function CategoryTree({
  nodes,
  activeId,
  onSelect,
  compact = false,
  collapsedIds,
  onToggleCollapse,
}: CategoryTreeProps) {
  if (compact) {
    return (
      <div
        className="flex gap-1.5 overflow-x-auto pb-1"
        role="tablist"
        aria-label={t('settings.title')}
      >
        {nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            role="tab"
            aria-selected={activeId === node.id}
            className={`shrink-0 rounded-full px-3 py-1 text-sm transition-colors ${
              activeId === node.id ? 'bg-accent-soft text-accent-ink' : 'bg-sunken text-muted'
            }`}
            onClick={() => onSelect(node.id)}
          >
            {node.label}
            {node.count !== undefined && node.count > 0 ? ` (${node.count})` : ''}
          </button>
        ))}
      </div>
    );
  }

  return (
    <nav className="flex flex-col gap-0.5" aria-label={t('settings.title')}>
      {nodes.map((node) => {
        const collapsed = collapsedIds.has(node.id);
        const hasChildren = (node.children?.length ?? 0) > 0;
        return (
          <div key={node.id} className="flex flex-col">
            <div className="flex items-center">
              {hasChildren && (
                <button
                  type="button"
                  className="px-1 text-xs text-faint"
                  aria-expanded={!collapsed}
                  aria-label={
                    collapsed ? t('settings.dialog.expandTree') : t('settings.dialog.collapseTree')
                  }
                  onClick={() => onToggleCollapse(node.id)}
                >
                  {collapsed ? '▸' : '▾'}
                </button>
              )}
              <button
                type="button"
                className={`flex grow items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors ${
                  activeId === node.id
                    ? 'bg-accent-soft text-accent-ink'
                    : 'text-ink hover:bg-hover'
                } ${hasChildren ? '' : 'ml-4'}`}
                aria-current={activeId === node.id ? 'true' : undefined}
                onClick={() => onSelect(node.id)}
              >
                <span className="truncate">{node.label}</span>
                {node.count !== undefined && node.count > 0 && <CountBadge count={node.count} />}
              </button>
            </div>
            {hasChildren && !collapsed && (
              <div className="ml-4 flex flex-col gap-0.5 border-l border-line pl-2">
                {(node.children ?? []).map((child) => (
                  <button
                    key={child.id}
                    type="button"
                    className={`flex items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-sm transition-colors ${
                      activeId === child.id
                        ? 'bg-accent-soft text-accent-ink'
                        : 'text-muted hover:bg-hover'
                    }`}
                    aria-current={activeId === child.id ? 'true' : undefined}
                    onClick={() => onSelect(child.id)}
                  >
                    <span className="truncate">{child.label}</span>
                    {child.count !== undefined && child.count > 0 && (
                      <CountBadge count={child.count} />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
