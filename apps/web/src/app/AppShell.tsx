import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PaletteEntitiesProvider } from '../components/PaletteEntities';
import { PendingPermissionsBar } from '../components/PendingPermissionsBar';
import { RefreshBanner } from '../components/RefreshBanner';
import { useToast } from '../components/ToastProvider';
import { pendingPermissionsOutsideView } from '../domains/chat/pending-permissions';
import { browserSessionStorage, clearLastSession } from '../domains/chat/session-selection';
import { useConnection } from '../gateway/ConnectionProvider';
import { t, useLocale } from '../i18n';
import type { PaletteItem } from '../state/palette';
import { applyTheme, useTheme } from '../state/theme';
import { AppBar } from './AppBar';
import { BottomNav } from './BottomNav';
import { DomainNav } from './DomainNav';
import { defaultNavCollapsed, navModeForWidth } from './layout';
import { routeBreadcrumb } from './nav';
import { readNavPreference, writeNavPreference } from './nav-preference';
import { buildPaletteItems } from './palette-items';
import { formatRoute } from './router';
import { ShellBanners } from './ShellBanners';
import { ShellOverlays } from './ShellOverlays';
import { ShellRouteView } from './ShellRouteView';
import { isPaletteShortcut, isSlashPaletteShortcut } from './shortcuts';
import { tenantResetPlan } from './tenant-reset';
import { useDrawerA11y } from './useDrawerA11y';
import { useHashRoute } from './useHashRoute';
import { paneCssVars, usePaneResize } from './usePaneResize';
import { useViewportWidth } from './useViewportWidth';

export function AppShell() {
  const locale = useLocale();
  const { theme } = useTheme();
  const { route, navigate } = useHashRoute();
  const toast = useToast();
  const {
    connectionState,
    hasToken,
    tenantId,
    tenantEpoch,
    eventStore,
    lastError,
    tokenError,
    reconnectAttempt,
    stale,
    permissions,
    asks,
    client,
    epoch,
    retry,
    dismissError,
  } = useConnection();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [entityMap, setEntityMap] = useState<ReadonlyMap<string, readonly PaletteItem[]>>(
    new Map(),
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const [chatSessionsOpen, setChatSessionsOpen] = useState(false);
  const [navPreference] = useState<boolean | null>(() => readNavPreference());
  const hasNavPreference = useRef(navPreference !== null);
  const [navCollapsed, setNavCollapsed] = useState(
    () => navPreference ?? defaultNavCollapsed(window.innerWidth),
  );
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [pendingAction, setPendingAction] = useState<PaletteItem | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const firstRoute = useRef(true);
  const routeKey = formatRoute(route);
  const lastEventVersion = useRef(-1);

  // 当前会话的权限/提问在 ChatView 的 Composer 槽位处理；其他会话只保留顶部提示条。
  const modalOpen = Boolean(pendingAction || helpOpen);
  const otherPending = useMemo(
    () => pendingPermissionsOutsideView(permissions, route),
    [permissions, route],
  );
  const otherAsks = useMemo(() => pendingPermissionsOutsideView(asks, route), [asks, route]);
  // compact bar 只跳会话；应答仍在目标会话的 Composer 槽位完成。
  const openPendingSession = useCallback(
    (sessionId: string) => navigate({ domain: 'chat', sessionId }),
    [navigate],
  );
  const viewportWidth = useViewportWidth();
  const panes = usePaneResize();
  const navMode = navModeForWidth(viewportWidth, navCollapsed);
  const navDrawerRef = useDrawerA11y({
    open: navDrawerOpen,
    onClose: () => setNavDrawerOpen(false),
    enabled: navMode === 'drawer',
    returnFocusId: 'nav-toggle',
  });
  const tenantEpochRef = useRef(tenantEpoch);
  const tenantClearEpochRef = useRef(tenantEpoch);

  const registerEntities = useCallback((source: string, items: readonly PaletteItem[]) => {
    setEntityMap((prev) => {
      if (items.length === 0) {
        if (!prev.has(source)) return prev;
        const next = new Map(prev);
        next.delete(source);
        return next;
      }
      const next = new Map(prev);
      next.set(source, items);
      return next;
    });
  }, []);
  const entities = useMemo(() => [...entityMap.values()].flat(), [entityMap]);

  // Theme lives in uiStore; applying it here keeps the DOM in sync when the
  // preference changes at runtime.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // layout effect 先于 ChatView 的 passive 记录 effect：避免旧会话写进新 tenant key。
  useLayoutEffect(() => {
    if (tenantEpoch === tenantClearEpochRef.current) return;
    tenantClearEpochRef.current = tenantEpoch;
    // 新 tenant 不自动恢复旧选择；存储 key 本身也按 tenant 隔离。
    clearLastSession(browserSessionStorage(), tenantId);
  }, [tenantEpoch, tenantId]);

  // 切 tenant：清空选择后回到 Chat 空态（事件缓冲已在 ConnectionProvider 重置）。
  useEffect(() => {
    if (tenantEpoch === tenantEpochRef.current) return;
    tenantEpochRef.current = tenantEpoch;
    const plan = tenantResetPlan();
    if (plan.closeSessionsDrawer) setChatSessionsOpen(false);
    if (plan.clearPendingAction) setPendingAction(null);
    if (plan.closePalette) setPaletteOpen(false);
    // 旧租户的实体（会话/run/MCP）不能留在命令面板里。
    if (plan.clearPaletteEntities) setEntityMap(new Map());
    navigate(plan.route);
    toast.info(t('palette.toast.tenantSwitched'));
  }, [tenantEpoch, navigate, toast]);

  // 无显式偏好时，跨 1200 边界自动切换默认展开/折叠。
  useEffect(() => {
    if (hasNavPreference.current) return;
    setNavCollapsed(defaultNavCollapsed(viewportWidth));
  }, [viewportWidth]);

  useEffect(() => {
    if (navMode !== 'drawer') setNavDrawerOpen(false);
  }, [navMode]);

  // 路由切换：滚动回顶、焦点移到 main、播报；首次挂载不抢焦点。
  // biome-ignore lint/correctness/useExhaustiveDependencies: routeKey 是路由变化的稳定标识
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    window.scrollTo(0, 0);
    mainRef.current?.scrollTo?.(0, 0);
    mainRef.current?.focus();
    setAnnouncement(t('nav.opened', { path: routeBreadcrumb(route) }));
    setNavDrawerOpen(false);
    if (route.domain !== 'chat') setChatSessionsOpen(false);
  }, [routeKey]);

  // 运行终态播报（只播报 completed/failed/cancelled，不播报 token/流式内容）。
  // 直接订阅 store，避免每个 50ms 合批都让整个外壳重渲染。
  useEffect(() => {
    return eventStore.subscribe(() => {
      const snapshot = eventStore.getSnapshot();
      if (snapshot.version === lastEventVersion.current) return;
      lastEventVersion.current = snapshot.version;
      const recent = snapshot.entries.slice(-20);
      const terminal = [...recent]
        .reverse()
        .find(
          ({ event }) =>
            event.type === 'run.completed' ||
            event.type === 'run.failed' ||
            event.type === 'run.cancelled',
        );
      if (!terminal) return;
      const status =
        terminal.event.type === 'run.completed'
          ? t('status.completed')
          : terminal.event.type === 'run.failed'
            ? t('status.failed')
            : t('status.cancelled');
      setAnnouncement(t('app.announce.run', { id: terminal.event.run_id.slice(0, 12), status }));
    });
  }, [eventStore]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (modalOpen) return;
      if (isPaletteShortcut(event)) {
        event.preventDefault();
        setPaletteQuery('');
        setPaletteOpen((value) => !value);
        return;
      }
      if (isSlashPaletteShortcut(event)) {
        event.preventDefault();
        setPaletteQuery('>');
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalOpen]);

  const openHelp = useCallback(() => setHelpOpen(true), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: locale 变化需要重算面板文案
  const paletteItems = useMemo<PaletteItem[]>(
    () => buildPaletteItems({ hasToken, connectionState, navigate, retry, toast, openHelp }),
    [connectionState, hasToken, locale, navigate, retry, toast, openHelp],
  );

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // 破坏性动作离开面板后仍需二次确认；非破坏动作直接执行。
  const runPaletteItem = useCallback((item: PaletteItem) => {
    if (item.danger || item.confirm) {
      // 没有显式确认文案的破坏性动作也要有兜底确认，避免“点了没反应”。
      setPendingAction(
        item.confirm
          ? item
          : {
              ...item,
              confirm: {
                title: t('palette.confirm.executeTitle', { label: item.label }),
                body: t('palette.confirm.executeBody'),
                confirmLabel: t('palette.confirm.execute'),
              },
            },
      );
      return;
    }
    item.run();
  }, []);

  const openSessions = useCallback(() => {
    setNavDrawerOpen(false);
    setChatSessionsOpen(true);
  }, []);
  const closeSessions = useCallback(() => setChatSessionsOpen(false), []);
  const toggleNavDrawer = useCallback(() => {
    setChatSessionsOpen(false);
    setNavDrawerOpen((value) => !value);
  }, []);
  const toggleNavCollapsed = useCallback(() => {
    hasNavPreference.current = true;
    setNavCollapsed((value) => {
      const next = !value;
      writeNavPreference(next);
      return next;
    });
  }, []);

  return (
    <PaletteEntitiesProvider register={registerEntities}>
      <div
        className="flex h-[var(--vvh,100dvh)] min-h-0 flex-col"
        ref={panes.shellRef}
        style={paneCssVars(panes.layout)}
      >
        <button
          type="button"
          className="skip-link"
          onClick={() => {
            // 不用 href="#main"：hash 路由会把 #main 当成领域路由。
            mainRef.current?.focus();
          }}
        >
          {t('nav.jumpToMain')}
        </button>
        {/* 后台重建完成后，已打开的页面自报「该刷新了」。 */}
        <RefreshBanner />
        <AppBar
          route={route}
          navigate={navigate}
          onOpenPalette={() => {
            setPaletteQuery('');
            setPaletteOpen(true);
          }}
          {...(route.domain === 'chat'
            ? { onToggleSessions: openSessions, sessionsOpen: chatSessionsOpen }
            : navMode === 'drawer'
              ? { onToggleNav: toggleNavDrawer, navOpen: navDrawerOpen }
              : {})}
        />

        <ShellBanners
          lastError={lastError}
          tokenError={tokenError}
          stale={stale}
          connectionState={connectionState}
          reconnectAttempt={reconnectAttempt}
          onDismissError={dismissError}
          onRetry={retry}
          onOpenConnection={() => navigate({ domain: 'settings', tab: 'connection' })}
        />

        {(otherPending.length > 0 || otherAsks.length > 0) && (
          <PendingPermissionsBar
            requests={otherPending}
            asks={otherAsks}
            onOpenSession={openPendingSession}
          />
        )}

        <div className="flex min-h-0 flex-auto">
          <DomainNav
            route={route}
            navigate={navigate}
            mode={navMode}
            open={navDrawerOpen}
            onClose={() => setNavDrawerOpen(false)}
            onToggleCollapsed={toggleNavCollapsed}
            navRef={navDrawerRef}
            panes={panes}
          />
          {/* tenant 变化时整块重挂载：旧租户的 resource 缓存、会话副本与选中项全部丢弃。 */}
          <main
            key={tenantEpoch}
            id="main"
            ref={mainRef}
            className="flex min-h-0 min-w-0 flex-auto flex-col overflow-hidden focus:outline-none"
            tabIndex={-1}
            inert={navMode === 'drawer' && navDrawerOpen ? true : undefined}
          >
            <ShellRouteView
              route={route}
              navigate={navigate}
              chatSessionsOpen={chatSessionsOpen}
              onCloseSessions={closeSessions}
              panes={panes}
              client={client}
              hasToken={hasToken}
              connectionState={connectionState}
              epoch={epoch}
            />
          </main>
        </div>

        {navMode === 'drawer' && navDrawerOpen && (
          <button
            type="button"
            className="drawer-backdrop"
            aria-label={t('nav.closeNav')}
            onClick={() => setNavDrawerOpen(false)}
          />
        )}

        <BottomNav route={route} navigate={navigate} />

        <div className="sr-only" aria-live="polite">
          {announcement}
        </div>

        <ShellOverlays
          paletteOpen={paletteOpen}
          paletteItems={paletteItems}
          entities={entities}
          paletteQuery={paletteQuery}
          onClosePalette={closePalette}
          onExecutePalette={runPaletteItem}
          helpOpen={helpOpen}
          onCloseHelp={() => setHelpOpen(false)}
          pendingAction={pendingAction}
          onClearPending={() => setPendingAction(null)}
          onConfirmPending={() => {
            const action = pendingAction;
            setPendingAction(null);
            action?.run();
          }}
        />
      </div>
    </PaletteEntitiesProvider>
  );
}
