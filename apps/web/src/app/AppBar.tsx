import type { ReactNode } from 'react';
import { Tooltip } from '../components/Tooltip';
import { AccountMenu } from '../domains/auth/AccountMenu';
import { useNodeNames } from '../domains/nodes/useNodeNames';
import { t, useLocale } from '../i18n';
import { LanguageToggle } from './LanguageToggle';
import { routeBreadcrumb } from './nav';
import type { Route } from './router';

export function AppBar({
  route,
  onOpenPalette,
  onToggleSessions,
  sessionsOpen = false,
  onToggleNav,
  navOpen = false,
  navigate,
  center,
}: {
  route: Route;
  onOpenPalette: () => void;
  onToggleSessions?: () => void;
  sessionsOpen?: boolean;
  onToggleNav?: () => void;
  navOpen?: boolean;
  navigate: (route: Route) => void;
  /** AppBar 中心插槽：外壳用它挂 MessageBar。 */
  center?: ReactNode;
}) {
  useLocale();
  // 节点展示名（问题3）：节点详情面包屑显示名字而非 node id；拿不到退 nodeKey 原文。
  const nodeNames = useNodeNames();
  const drawerToggle = onToggleSessions
    ? {
        id: 'sessions-toggle',
        controls: 'chat-sessions',
        label: sessionsOpen ? t('nav.closeSessions') : t('nav.openSessions'),
        open: sessionsOpen,
        onClick: onToggleSessions,
      }
    : onToggleNav
      ? {
          id: 'nav-toggle',
          controls: 'domain-nav',
          label: navOpen ? t('nav.closeNav') : t('nav.openNav'),
          open: navOpen,
          onClick: onToggleNav,
        }
      : null;

  return (
    <header className="flex h-[var(--appbar-h)] flex-none items-center gap-3 bg-surface px-5 max-compact:gap-2 max-compact:px-3">
      {drawerToggle && (
        <Tooltip label={drawerToggle.label}>
          <button
            id={drawerToggle.id}
            type="button"
            className="hidden size-9 flex-none items-center justify-center rounded-full bg-transparent text-base text-muted transition-colors duration-150 hover:bg-hover max-wide:inline-flex pointer-coarse:size-touch"
            aria-label={drawerToggle.label}
            aria-expanded={drawerToggle.open}
            aria-controls={drawerToggle.controls}
            onClick={drawerToggle.onClick}
          >
            <span aria-hidden="true">☰</span>
          </button>
        </Tooltip>
      )}
      <img
        src="/Vessel.svg"
        alt=""
        aria-hidden="true"
        className="h-6 w-auto flex-none max-compact:h-5"
      />
      <span
        className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-serif text-xl font-semibold text-ink"
        aria-live="polite"
      >
        {routeBreadcrumb(route, nodeNames)}
      </span>

      <div className="flex min-w-0 flex-1 justify-center px-2 max-compact:px-1">{center}</div>

      <LanguageToggle />

      <Tooltip label="Ctrl/Cmd+K">
        <button
          type="button"
          className="inline-flex min-w-45 items-center gap-2 rounded-full bg-sunken py-1.5 pl-3 pr-2 text-sm text-muted transition-colors duration-150 hover:bg-hover hover:text-ink max-compact:min-w-0 max-compact:px-2.5 pointer-coarse:min-h-touch"
          onClick={onOpenPalette}
          aria-keyshortcuts="Control+K Meta+K"
        >
          <span className="font-mono text-md" aria-hidden="true">
            ⌕
          </span>
          <span className="flex-1 text-left max-compact:hidden">{t('nav.searchOrCommand')}</span>
          <kbd className="kbd max-compact:hidden">⌘K</kbd>
        </button>
      </Tooltip>

      {/* 裁定⑤：设置入口常驻右上角，替换原 gateway 状态按钮
          （gateway 在线状态只留左侧栏 nav-status 四档点色；断连有 StaleNotice/MessageBar 兜底）。 */}
      <Tooltip label={`${t('nav.settings')} (Ctrl+,)`}>
        <button
          type="button"
          className="inline-flex size-9 flex-none items-center justify-center rounded-full bg-transparent text-base text-muted transition-colors duration-150 hover:bg-hover hover:text-ink pointer-coarse:size-touch"
          aria-label={t('nav.settings')}
          aria-keyshortcuts="Control+, Meta+,"
          onClick={() => navigate({ domain: 'settings' })}
        >
          <span aria-hidden="true">⚙</span>
        </button>
      </Tooltip>

      {/* 0.6x：最右侧的账号入口（头像浮层：身份 / 节点 / 登录方式 / 设置 / 登出）。
          取代原来的 SessionChip：登录与登出只留这一个入口。 */}
      <AccountMenu navigate={navigate} />
    </header>
  );
}
