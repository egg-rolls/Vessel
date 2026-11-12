/** 主导航单项：核心 domain 与插件页面共用同一渲染。 */
import { DomainIcon } from '../components/DomainIcon';
import { Tooltip } from '../components/Tooltip';
import { CountBadge } from '../components/ui';
import { cn } from '../components/ui/cn';
import { t } from '../i18n';
import type { NavItemModel } from './nav-model';
import type { Route } from './router';

const ITEM_CLASS =
  'flex min-h-control w-full items-center rounded-sm bg-transparent text-left text-md text-muted transition-colors duration-150 hover:bg-hover hover:text-ink';
const ACTIVE_CLASS = 'bg-accent-soft text-accent-ink hover:bg-accent-soft hover:text-accent-ink';

export function NavItem({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavItemModel;
  collapsed: boolean;
  onNavigate: (route: Route) => void;
}) {
  const status = item.status;
  const statusText = status ? t(status.labelKey) : '';
  // 版本未知时**不渲染占位**：一个孤零零的 — 会被读成“坏了”，而它只表示“还没探测到”。
  const versionText = status?.version ? `v${status.version}` : undefined;
  const countText = item.count !== undefined ? t('nav.count', { count: item.count }) : undefined;
  const tooltip = [item.title, statusText, countText, versionText]
    .filter((part) => part !== undefined && part !== '')
    .join(' · ');

  const button = (
    <button
      type="button"
      className={cn(
        ITEM_CLASS,
        collapsed ? 'justify-center gap-0 px-0 py-1' : 'gap-2.5 px-3 py-1',
        item.active && ACTIVE_CLASS,
      )}
      aria-current={item.active ? 'page' : undefined}
      aria-label={item.title}
      onClick={() => onNavigate(item.route)}
    >
      <span className="inline-flex flex-none">
        <DomainIcon domain={item.icon} />
      </span>
      {!collapsed && (
        <span
          className={cn(
            'min-w-0 overflow-hidden text-ellipsis whitespace-nowrap',
            (status !== undefined || item.count !== undefined) && 'flex-1',
          )}
        >
          {item.title}
        </span>
      )}
      {!collapsed && status && (
        <>
          <span
            className="size-1.5 flex-none rounded-full bg-faint data-[tone=ok]:bg-success data-[tone=warn]:bg-warn data-[tone=warn]:pulse-soft data-[tone=accent]:bg-accent data-[tone=amber]:bg-amber data-[tone=amber]:pulse-soft data-[tone=danger]:bg-danger"
            data-tone={status.tone}
            role="img"
            aria-label={statusText}
            title={statusText}
          />
          {versionText !== undefined && (
            <span className="flex-none whitespace-nowrap font-mono text-2xs text-faint">
              {versionText}
            </span>
          )}
        </>
      )}
      {!collapsed && item.count !== undefined && (
        <CountBadge
          className="ml-auto"
          count={item.count}
          label={countText ?? item.title}
          tone={item.active ? 'accent' : 'muted'}
        />
      )}
    </button>
  );

  return collapsed ? <Tooltip label={tooltip}>{button}</Tooltip> : button;
}
