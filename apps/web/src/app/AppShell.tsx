import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CommandPalette } from '../components/CommandPalette';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ModalShell } from '../components/Modal';
import { PaletteEntitiesProvider } from '../components/PaletteEntities';
import { AskModal, PermissionModal } from '../components/PermissionModals';
import { useToast } from '../components/ToastProvider';
import { ChatView } from '../domains/chat/ChatView';
import { IntegrationsView } from '../domains/integrations/IntegrationsView';
import { ObserveView } from '../domains/observe/ObserveView';
import { RunsView } from '../domains/runs/RunsView';
import { SettingsView } from '../domains/settings/SettingsView';
import { WorkflowsView } from '../domains/workflows/WorkflowsView';
import { useConnection, useEventSnapshot } from '../gateway/ConnectionProvider';
import type { PaletteItem } from '../state/palette';
import { AppBar } from './AppBar';
import { BottomNav } from './BottomNav';
import { DomainNav, primaryRoute } from './DomainNav';
import { requestStartWorkflow } from './intents';
import { DOMAINS, routeBreadcrumb } from './nav';
import { requestRefresh } from './refresh';
import { formatRoute, type Route } from './router';
import { isPaletteShortcut, isSlashPaletteShortcut } from './shortcuts';
import { useHashRoute } from './useHashRoute';

type SettingsTab = Extract<Route, { domain: 'settings' }>['tab'];

const SETTINGS_NAV: readonly { tab: SettingsTab; label: string; keywords: string[] }[] = [
  { tab: 'connection', label: '连接', keywords: ['gateway', 'token', 'url', 'connect'] },
  { tab: 'nodes', label: '节点', keywords: ['team', 'peers', 'agents', 'nodes'] },
  { tab: 'config', label: '配置', keywords: ['config', 'sources', 'paths'] },
  { tab: 'capabilities', label: '能力清单', keywords: ['capabilities', 'methods', 'plugins'] },
  { tab: 'tenants', label: '租户', keywords: ['tenant', 'quota', 'admin'] },
  { tab: 'appearance', label: '外观', keywords: ['theme', 'dark', 'light', '外观'] },
];

export function AppShell() {
  const { route, navigate } = useHashRoute();
  const toast = useToast();
  const {
    connectionState,
    hasToken,
    tenantEpoch,
    lastError,
    tokenError,
    gapNotice,
    reconnectAttempt,
    stale,
    permissions,
    asks,
    now,
    retry,
    dismissError,
    dismissGap,
    respondPermission,
    respondAsk,
  } = useConnection();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [entityMap, setEntityMap] = useState<ReadonlyMap<string, readonly PaletteItem[]>>(
    new Map(),
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const [chatSessionsOpen, setChatSessionsOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [pendingAction, setPendingAction] = useState<PaletteItem | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const firstRoute = useRef(true);
  const routeKey = formatRoute(route);
  const eventSnapshot = useEventSnapshot();
  const lastEventVersion = useRef(-1);

  const modalOpen = Boolean(permissions[0] || asks[0] || pendingAction || helpOpen);
  const tenantEpochRef = useRef(tenantEpoch);

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

  // 切 tenant：清空选择后回到 Chat 空态（事件缓冲已在 ConnectionProvider 重置）。
  useEffect(() => {
    if (tenantEpoch === tenantEpochRef.current) return;
    tenantEpochRef.current = tenantEpoch;
    setChatSessionsOpen(false);
    setPendingAction(null);
    navigate({ domain: 'chat' });
    toast.info('已切换租户；当前选择与事件缓冲已清空');
  }, [tenantEpoch, navigate, toast]);

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
    setAnnouncement(`已打开 ${routeBreadcrumb(route)}`);
    if (route.domain !== 'chat') setChatSessionsOpen(false);
  }, [routeKey]);

  // 运行终态播报（只播报 completed/failed/cancelled，不播报 token/流式内容）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: version 是合批键；entries 只在 version 变化时读取
  useEffect(() => {
    if (eventSnapshot.version === lastEventVersion.current) return;
    lastEventVersion.current = eventSnapshot.version;
    const recent = eventSnapshot.entries.slice(-20);
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
  }, [eventSnapshot.version]);

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

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      ...DOMAINS.map((domain) => ({
        id: `nav-${domain.id}`,
        group: 'navigation' as const,
        label: `打开${domain.label}`,
        keywords: [domain.id, domain.label],
        hint: '导航',
        run: () => navigate(primaryRoute(domain.id)),
      })),
      {
        id: 'nav-settings',
        group: 'navigation',
        label: '打开设置',
        keywords: ['settings', '设置'],
        hint: '导航',
        run: () => navigate({ domain: 'settings', tab: 'connection' }),
      },
      ...SETTINGS_NAV.map((entry) => ({
        id: `nav-settings-${entry.tab}`,
        group: 'navigation' as const,
        label: `设置 › ${entry.label}`,
        keywords: ['settings', entry.tab, ...entry.keywords],
        hint: '设置',
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
        id: 'action-start-workflow',
        group: 'action',
        label: '启动 workflow',
        keywords: ['workflow', 'start', '工作流'],
        hint: '动作',
        run: () => {
          navigate({ domain: 'workflows' });
          requestStartWorkflow();
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
  }, [connectionState, hasToken, navigate, retry, toast]);

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // 破坏性动作离开面板后仍需二次确认；非破坏动作直接执行。
  const runPaletteItem = useCallback((item: PaletteItem) => {
    if (item.danger || item.confirm) {
      setPendingAction(item);
      return;
    }
    item.run();
  }, []);

  const openSessions = useCallback(() => setChatSessionsOpen(true), []);
  const closeSessions = useCallback(() => setChatSessionsOpen(false), []);

  return (
    <PaletteEntitiesProvider register={registerEntities}>
      <div className="app-shell">
        <a className="skip-link" href="#main">
          跳到主内容
        </a>
        <AppBar
          route={route}
          navigate={navigate}
          onOpenPalette={() => {
            setPaletteQuery('');
            setPaletteOpen(true);
          }}
          {...(route.domain === 'chat'
            ? { onToggleSessions: openSessions, sessionsOpen: chatSessionsOpen }
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

        <div className="shell-body">
          <DomainNav route={route} navigate={navigate} />
          <main id="main" ref={mainRef} className="main-content" tabIndex={-1}>
            {route.domain === 'chat' && (
              <ChatView
                route={route}
                navigate={navigate}
                sessionsOpen={chatSessionsOpen}
                onCloseSessions={closeSessions}
              />
            )}
            {route.domain === 'runs' && <RunsView route={route} navigate={navigate} />}
            {route.domain === 'workflows' && <WorkflowsView route={route} navigate={navigate} />}
            {route.domain === 'integrations' && (
              <IntegrationsView route={route} navigate={navigate} />
            )}
            {route.domain === 'observe' && <ObserveView route={route} navigate={navigate} />}
            {route.domain === 'settings' && <SettingsView route={route} navigate={navigate} />}
          </main>
        </div>

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

        {asks[0] ? (
          <AskModal
            key={asks[0].requestId}
            request={asks[0]}
            pendingCount={asks.length}
            now={now}
            onSubmit={(answers) => void respondAsk(asks[0]?.requestId ?? '', answers)}
            onCancel={() => void respondAsk(asks[0]?.requestId ?? '', [])}
          />
        ) : permissions[0] ? (
          <PermissionModal
            request={permissions[0]}
            pendingCount={permissions.length}
            now={now}
            onDecide={(decision, remember) =>
              void respondPermission(permissions[0]?.requestId ?? '', decision, remember)
            }
          />
        ) : null}
      </div>
    </PaletteEntitiesProvider>
  );
}
