import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CommandPalette } from '../components/CommandPalette';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ModalShell } from '../components/Modal';
import { PaletteEntitiesProvider } from '../components/PaletteEntities';
import { PendingPermissionsBar } from '../components/PendingPermissionsBar';
import { useToast } from '../components/ToastProvider';
import { ChatView } from '../domains/chat/ChatView';
import {
  orphanedDismissIds,
  pendingPermissionsOutsideView,
} from '../domains/chat/pending-permissions';
import { browserSessionStorage, clearLastSession } from '../domains/chat/session-selection';
import { IntegrationsView } from '../domains/integrations/IntegrationsView';
import { ObserveView } from '../domains/observe/ObserveView';
import { RunsView } from '../domains/runs/RunsView';
import { SettingsView } from '../domains/settings/SettingsView';
import { useConnection } from '../gateway/ConnectionProvider';
import { t, useLocale } from '../i18n';
import type { PaletteItem } from '../state/palette';
import { AppBar } from './AppBar';
import { BottomNav } from './BottomNav';
import { DomainNav, primaryRoute } from './DomainNav';
import { defaultNavCollapsed, navModeForWidth, parseNavCollapsed } from './layout';
import { DOMAINS, domainLabel, routeBreadcrumb, settingsTabLabel } from './nav';
import { requestRefresh } from './refresh';
import { formatRoute, type Route } from './router';
import { isPaletteShortcut, isSlashPaletteShortcut } from './shortcuts';
import { tenantResetPlan } from './tenant-reset';
import { useDrawerA11y } from './useDrawerA11y';
import { useHashRoute } from './useHashRoute';
import { paneCssVars, usePaneResize } from './usePaneResize';
import { useViewportWidth } from './useViewportWidth';

type SettingsTab = Extract<Route, { domain: 'settings' }>['tab'];

const NAV_COLLAPSED_KEY = 'vessel.nav.collapsed';

function readNavPreference(): boolean | null {
  try {
    return parseNavCollapsed(localStorage.getItem(NAV_COLLAPSED_KEY));
  } catch {
    return null;
  }
}

function writeNavPreference(collapsed: boolean): void {
  try {
    localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // 隐私模式/配额满：折叠仍在本会话内生效。
  }
}

const SETTINGS_NAV: readonly { tab: SettingsTab; keywords: string[] }[] = [
  { tab: 'connection', keywords: ['gateway', 'token', 'url', 'connect'] },
  { tab: 'nodes', keywords: ['team', 'peers', 'agents', 'nodes'] },
  { tab: 'config', keywords: ['config', 'sources', 'paths'] },
  { tab: 'capabilities', keywords: ['capabilities', 'methods', 'plugins'] },
  { tab: 'tenants', keywords: ['tenant', 'quota', 'admin'] },
  { tab: 'appearance', keywords: ['theme', 'dark', 'light'] },
  { tab: 'display', keywords: ['display', 'verbosity', 'errorLevel', 'settings'] },
];

export function AppShell() {
  const locale = useLocale();
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
    gapNotice,
    reconnectAttempt,
    stale,
    permissions,
    asks,
    orphaned,
    dismissOrphaned,
    retry,
    dismissError,
    dismissGap,
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
  const otherOrphans = useMemo(
    () => pendingPermissionsOutsideView(orphaned, route),
    [orphaned, route],
  );
  // compact bar 只跳会话；应答仍在目标会话的 Composer 槽位完成。
  const openPendingSession = useCallback(
    (sessionId: string) => navigate({ domain: 'chat', sessionId }),
    [navigate],
  );
  const dismissPendingOrphans = useCallback(() => {
    for (const requestId of orphanedDismissIds(otherOrphans)) dismissOrphaned(requestId);
  }, [dismissOrphaned, otherOrphans]);
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
    toast.info('已切换租户；当前选择与事件缓冲已清空');
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
      const label =
        terminal.event.type === 'run.completed'
          ? '已完成'
          : terminal.event.type === 'run.failed'
            ? '失败'
            : '已取消';
      setAnnouncement(`运行 ${terminal.event.run_id.slice(0, 12)} ${label}`);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: locale 变化需要重算面板文案
  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      ...DOMAINS.map((domain) => ({
        id: `nav-${domain.id}`,
        group: 'navigation' as const,
        label: t('nav.openNamed', { domain: domainLabel(domain.id) }),
        keywords: [domain.id, domainLabel(domain.id)],
        hint: t('nav.hintNavigation'),
        run: () => navigate(primaryRoute(domain.id)),
      })),
      {
        id: 'nav-settings',
        group: 'navigation',
        label: t('nav.openNamed', { domain: domainLabel('settings') }),
        keywords: ['settings', '设置'],
        hint: t('nav.hintNavigation'),
        run: () => navigate({ domain: 'settings', tab: 'connection' }),
      },
      ...SETTINGS_NAV.map((entry) => ({
        id: `nav-settings-${entry.tab}`,
        group: 'navigation' as const,
        label: t('breadcrumb.settings', { tab: settingsTabLabel(entry.tab) }),
        keywords: ['settings', entry.tab, ...entry.keywords],
        hint: t('nav.hintSettings'),
        run: () => navigate({ domain: 'settings', tab: entry.tab }),
      })),
      {
        id: 'action-new-session',
        group: 'action',
        label: '新建会话',
        keywords: ['new', 'session', 'chat'],
        hint: '动作',
        run: () => {
          // 先回到 Chat 再进入 new，确保已在 new 时也会生成新的草稿 id。
          navigate({ domain: 'chat' });
          window.setTimeout(() => navigate({ domain: 'chat', sessionId: 'new' }), 0);
        },
      },
      {
        id: 'action-resume-run',
        group: 'action',
        label: '恢复可恢复运行',
        keywords: ['resume', 'durable', 'interrupted', '恢复'],
        hint: '动作',
        run: () => navigate({ domain: 'runs', tab: 'durable' }),
      },
      {
        id: 'action-tenant',
        group: 'action',
        label: '切换租户',
        keywords: ['tenant', 'switch', '租户'],
        hint: '动作',
        run: () => navigate({ domain: 'settings', tab: 'tenants' }),
      },
      {
        id: 'action-connection',
        group: 'action',
        label: '连接设置',
        keywords: ['gateway', 'token', 'url', 'connect'],
        hint: '动作',
        run: () => navigate({ domain: 'settings', tab: 'connection' }),
      },
      {
        id: 'action-config',
        group: 'action',
        label: '查看配置',
        keywords: ['config', 'sources'],
        hint: '动作',
        run: () => navigate({ domain: 'settings', tab: 'config' }),
      },
      {
        id: 'action-capabilities',
        group: 'action',
        label: '查看能力清单',
        keywords: ['capabilities', 'methods'],
        hint: '动作',
        run: () => navigate({ domain: 'settings', tab: 'capabilities' }),
      },
      {
        id: 'action-refresh',
        group: 'action',
        label: '刷新当前视图',
        keywords: ['refresh', 'reload'],
        hint: '动作',
        run: () => {
          requestRefresh();
          toast.info('已请求刷新当前视图');
        },
      },
      {
        id: 'help-shortcuts',
        group: 'help',
        label: '键盘快捷键',
        keywords: ['help', 'keyboard', 'shortcut'],
        hint: '帮助',
        run: () => setHelpOpen(true),
      },
    ];
    if (hasToken) {
      items.push({
        id: 'action-retry',
        group: 'action',
        label: connectionState === 'open' ? '检查连接' : '重新连接',
        keywords: ['reconnect', 'retry'],
        hint: '动作',
        run: () => {
          retry();
          toast.info('正在重新连接 gateway');
        },
      });
    }
    return items;
  }, [connectionState, hasToken, locale, navigate, retry, toast]);

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
                title: `执行「${item.label}」？`,
                body: '该操作可能无法撤销。',
                confirmLabel: '确认执行',
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
        className={`app-shell nav-${navMode}`}
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

        {(lastError || tokenError || gapNotice || stale) && (
          <div className="banners">
            {lastError && (
              <div className="banner banner-error" role="alert">
                <span>{lastError}</span>
                <button
                  type="button"
                  className="banner-close"
                  aria-label="关闭错误提示"
                  onClick={dismissError}
                >
                  ×
                </button>
              </div>
            )}
            {tokenError && (
              <div className="banner banner-error" role="alert">
                <span>{tokenError}</span>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => navigate({ domain: 'settings', tab: 'connection' })}
                >
                  打开连接设置
                </button>
              </div>
            )}
            {gapNotice && (
              <div className="banner banner-warn" role="status">
                <span>{gapNotice}</span>
                <button
                  type="button"
                  className="banner-close"
                  aria-label="关闭提示"
                  onClick={dismissGap}
                >
                  ×
                </button>
              </div>
            )}
            {stale && (
              <div className="banner banner-stale" role="status">
                <span>
                  {connectionState === 'reconnecting'
                    ? `连接已断开，正在重连（第 ${Math.max(1, reconnectAttempt)} 次）…`
                    : '连接已断开；当前显示的数据可能已过期。'}
                </span>
                <button type="button" className="link-btn" onClick={retry}>
                  立即重试
                </button>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => navigate({ domain: 'settings', tab: 'connection' })}
                >
                  连接设置
                </button>
              </div>
            )}
          </div>
        )}

        {(otherPending.length > 0 || otherAsks.length > 0 || otherOrphans.length > 0) && (
          <PendingPermissionsBar
            requests={otherPending}
            asks={otherAsks}
            orphaned={otherOrphans}
            onOpenSession={openPendingSession}
            onDismissOrphans={dismissPendingOrphans}
          />
        )}

        <div className="shell-body">
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
            className="main-content"
            tabIndex={-1}
            inert={navMode === 'drawer' && navDrawerOpen ? true : undefined}
          >
            {route.domain === 'chat' && (
              <ChatView
                route={route}
                navigate={navigate}
                sessionsOpen={chatSessionsOpen}
                onCloseSessions={closeSessions}
                panes={panes}
              />
            )}
            {route.domain === 'runs' && <RunsView route={route} navigate={navigate} />}
            {route.domain === 'integrations' && (
              <IntegrationsView route={route} navigate={navigate} />
            )}
            {route.domain === 'observe' && <ObserveView route={route} navigate={navigate} />}
            {route.domain === 'settings' && <SettingsView route={route} navigate={navigate} />}
          </main>
        </div>

        {navMode === 'drawer' && navDrawerOpen && (
          <button
            type="button"
            className="drawer-backdrop"
            aria-label="关闭导航"
            onClick={() => setNavDrawerOpen(false)}
          />
        )}

        <BottomNav route={route} navigate={navigate} />

        <div className="sr-only" aria-live="polite">
          {announcement}
        </div>

        {paletteOpen && (
          <CommandPalette
            items={paletteItems}
            entities={entities}
            initialQuery={paletteQuery}
            onClose={closePalette}
            onExecute={runPaletteItem}
          />
        )}

        {helpOpen && (
          <ModalShell label="键盘快捷键" onClose={() => setHelpOpen(false)} className="help-dialog">
            <h2 className="modal-title">键盘快捷键</h2>
            <dl className="shortcut-list">
              <dt>
                <kbd className="kbd">Ctrl/Cmd</kbd> + <kbd className="kbd">K</kbd>
              </dt>
              <dd>打开/关闭命令面板</dd>
              <dt>
                <kbd className="kbd">/</kbd>
              </dt>
              <dd>在非输入框中打开动作模式</dd>
              <dt>
                <kbd className="kbd">↑</kbd> / <kbd className="kbd">↓</kbd>
              </dt>
              <dd>移动命令面板结果</dd>
              <dt>
                <kbd className="kbd">Enter</kbd>
              </dt>
              <dd>执行选中命令 / 发送消息</dd>
              <dt>
                <kbd className="kbd">Esc</kbd>
              </dt>
              <dd>关闭面板、抽屉或对话框</dd>
            </dl>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                data-autofocus
                onClick={() => setHelpOpen(false)}
              >
                关闭
              </button>
            </div>
          </ModalShell>
        )}

        {pendingAction?.confirm && (
          <ConfirmDialog
            title={pendingAction.confirm.title}
            body={<p>{pendingAction.confirm.body}</p>}
            confirmLabel={pendingAction.confirm.confirmLabel}
            danger
            onConfirm={() => {
              const action = pendingAction;
              setPendingAction(null);
              action.run();
            }}
            onCancel={() => setPendingAction(null)}
          />
        )}
      </div>
    </PaletteEntitiesProvider>
  );
}
