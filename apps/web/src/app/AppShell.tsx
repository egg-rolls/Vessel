import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageBar, type MessageBarItem } from '../components/MessageBar';
import { PaletteEntitiesProvider } from '../components/PaletteEntities';
import { useToast, useToastFeed } from '../components/ToastProvider';
import {
  pendingBarSummary,
  pendingBarTarget,
  pendingPermissionsOutsideView,
} from '../domains/chat/pending-permissions';
import { rosterAttributionIndex } from '../domains/pending/attribution';
import { useConnection } from '../gateway/ConnectionProvider';
import { useNodes } from '../gateway/NodeProvider';
import { t, useLocale } from '../i18n';
import type { PaletteItem } from '../state/palette';
import { applyTheme, useTheme } from '../state/theme';
import { resourceData } from '../state/useResource';
import { useAgentStore } from '../stores/agentStore';
import { AppBar } from './AppBar';
import { BottomNav } from './BottomNav';
import { DomainNav } from './DomainNav';
import { defaultNavCollapsed, navModeForWidth } from './layout';
import type { PrimaryDomain } from './nav';
import { routeBreadcrumb } from './nav';
import { readNavPreference, writeNavPreference } from './nav-preference';
import { buildPaletteItems } from './palette-items';
import { formatRoute } from './router';
import { ShellOverlays } from './ShellOverlays';
import { ShellRouteView } from './ShellRouteView';
import { shellNoticeItems } from './shellNoticeItems';
import { isPaletteShortcut, isSlashPaletteShortcut } from './shortcuts';
import { useDrawerA11y } from './useDrawerA11y';
import { useHashRoute } from './useHashRoute';
import { probeHubNavStatus } from './useNavStatus';
import { useOutdatedBuild } from './useOutdatedBuild';
import { paneCssVars, type SidePaneKey, usePaneResize } from './usePaneResize';
import { useRouteSubscription } from './useRouteSubscription';
import { useViewportWidth } from './useViewportWidth';

export function AppShell() {
  const locale = useLocale();
  const { theme } = useTheme();
  const { route, navigate } = useHashRoute();
  // 路由级订阅：Chat 会话页只回放本会话，Team / Runs 只收失效信号（契约 §4.1）。
  useRouteSubscription(route);
  const toast = useToast();
  const toastFeed = useToastFeed();
  const outdated = useOutdatedBuild();
  const {
    connectionState,
    hasToken,
    eventStore,
    lastError,
    tokenError,
    reconnectAttempt,
    stale,
    permissions,
    asks,
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
  // 归属解析要 roster（历史脏数据的上溯兑底）：外壳拿一次，顶部条 / 待批页共用同一份
  // store（`useAgentStore`），不为这条提示多开一路 RPC。
  const rosterState = useAgentStore((state) => state.roster);
  const loadRoster = useAgentStore((state) => state.loadRoster);
  const { nodes, teamControl } = useNodes();
  const rosters = useMemo(() => resourceData(rosterState) ?? [], [rosterState]);
  const attribution = useMemo(() => rosterAttributionIndex(rosters), [rosters]);
  // roster 只在 idle 时补一次：各域视图（chat / teams / agents / runs）自己也会加载，
  // 外壳这一步只为「待批页 / 非 chat 页」兜住归属解析所需的名单。
  useEffect(() => {
    if (rosterState.status !== 'idle' || nodes.length === 0) return;
    void loadRoster(nodes, teamControl);
  }, [rosterState.status, nodes, teamControl, loadRoster]);
  const otherPending = useMemo(
    () => pendingPermissionsOutsideView(permissions, route),
    [permissions, route],
  );
  const otherAsks = useMemo(() => pendingPermissionsOutsideView(asks, route), [asks, route]);
  // 侧栏「待批」计数：只数 ask（权限通道仍独立走自己的入口）。
  const navCounts = useMemo<Partial<Record<PrimaryDomain, number>>>(
    () => ({ pending: asks.length }),
    [asks],
  );
  // compact bar 只跳会话；应答仍在目标会话的 Composer 槽位完成。
  const openPendingSession = useCallback(
    (sessionId: string) => navigate({ domain: 'chat', sessionId }),
    [navigate],
  );
  // 成员 bridge 的请求跳待批页（它们在会话页有守卫，进不去）。
  const openPendingPage = useCallback(
    (sessionId?: string) =>
      navigate({ domain: 'pending', ...(sessionId !== undefined ? { sessionId } : {}) }),
    [navigate],
  );

  // 0.37：外壳只把持久提示与 toast feed 组合成 items，渲染固定在 AppBar 中心。
  const shellItems = shellNoticeItems({
    lastError,
    tokenError,
    stale,
    connectionState,
    reconnectAttempt,
    onDismissError: dismissError,
    onRetry: retry,
    onOpenConnection: () => navigate({ domain: 'gateway' }),
  });

  const pendingSummary = pendingBarSummary(otherPending, otherAsks, attribution);
  // 跳转落点由归属解析给出：普通请求 → 会话页；成员 bridge → 待批页；解析不出 → 不给跳转。
  // 落点先算成 {label, run}：闭包里不再依赖 `pendingTarget` 的类型收窄（会话 id 也一并定下来，
  // 免得上面那条「agent 落点可以没有 sessionId」的差异漏到 onClick 里）。
  const pendingJump = ((): { label: string; run: () => void } | null => {
    const target = pendingBarTarget(pendingSummary);
    if (target === null) return null;
    if (target.domain === 'pending') {
      const sessionId = target.sessionId;
      return {
        label: t('pending.bar.goPending'),
        run: () => openPendingPage(sessionId),
      };
    }
    const sessionId = target.sessionId;
    return { label: t('permission.goTo'), run: () => openPendingSession(sessionId) };
  })();
  const pendingItem: MessageBarItem | null = pendingSummary.earliest
    ? {
        id: 'pending-requests',
        tone: 'info',
        text: pendingJump
          ? t('pending.bar.summary', { count: pendingSummary.count })
          : `${t('pending.bar.summary', { count: pendingSummary.count })} · ${t('pending.bar.unresolved')}`,
        ...(pendingJump
          ? { actions: [{ label: pendingJump.label, onClick: pendingJump.run }] }
          : {}),
      }
    : null;

  const buildItem: MessageBarItem | null = outdated
    ? {
        id: 'web-build-outdated',
        tone: 'warn',
        text: t('webBuild.outdated'),
        actions: [{ label: t('webBuild.reload'), onClick: () => window.location.reload() }],
      }
    : null;

  const messageItems: MessageBarItem[] = [
    ...shellItems,
    ...(pendingItem ? [pendingItem] : []),
    ...(buildItem ? [buildItem] : []),
    ...toastFeed.items.map((item) => ({
      id: `toast-${item.id}`,
      tone: item.kind,
      text: item.message,
      onDismiss: () => toastFeed.dismiss(item.id),
    })),
  ];

  const viewportWidth = useViewportWidth();
  // 每页的左列各是一个 pane：会话页是 sessions，团队页是 teamList。
  // chat 的显示宽度 / 居中手柄范围按当前页那条左列推算（两者可被拖成不同宽度）。
  const sidePane: SidePaneKey = route.domain === 'teams' ? 'teamList' : 'sessions';
  const panes = usePaneResize(sidePane);
  const navMode = navModeForWidth(viewportWidth, navCollapsed);
  const navDrawerRef = useDrawerA11y({
    open: navDrawerOpen,
    onClose: () => setNavDrawerOpen(false),
    enabled: navMode === 'drawer',
    returnFocusId: 'nav-toggle',
  });
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

  // Hub 状态点：打开 WebUI 就探一次（有已存 URL / 回环默认 Hub 才真发请求），之后只随
  // gateway 会话重建（epoch 变化）再探一次 —— 不轮询，失败也不自己重试。Hub 页自己会连
  // （`useHubDirectory`），停在 Hub 页上不重复探；探测复用的是同一个 `HubSession`。
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch / 当前路由只是「再探一次」的触发器
  useEffect(() => {
    if (route.domain === 'hub') return;
    void probeHubNavStatus();
  }, [epoch]);

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
        <AppBar
          route={route}
          navigate={navigate}
          center={<MessageBar items={messageItems} />}
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
            counts={navCounts}
          />
          <main
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
