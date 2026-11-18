/**
 * 头部栏最右侧的账号入口：圆形头像 + 点击弹出浮层（0.6x）。
 *
 * 取代 0.56 的 `SessionChip`（「已登录为 X」+ 登出两个散件）：登录 / 登出 / 切换账号
 * 现在只有一个入口，且状态与节点信息在同一个浮层里。浮层内容见 `AccountPanel`。
 *
 * 数据两条路，**契约先行 + 降级可用**：
 * - 汇总接口（`auth.whoami`）：身份 / 团队 / 节点 / 登录策略 / auth_mode 一次拿全；
 * - 拿不到（404 / 未上线 / 连不上）⇒ 用现有事实拼：`/auth/status` 的身份 + 首个后端
 *   当唯一登录动作 + `useNodes()` 的节点列表。**不弹错**，用户看到的是内容少几块。
 *
 * 交互：点击外部关闭、Esc 关闭、焦点陷阱、`aria-haspopup="dialog"` + `aria-expanded`、
 * 方向键在行间移动、关掉后焦点回触发器（`useAccountPopover`）。
 *
 * @module web/domains/auth/AccountMenu
 */

import { useCallback, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Route } from '../../app/router';
import { useAuth } from '../../auth/AuthProvider';
import { Tooltip } from '../../components/Tooltip';
import { useConnection } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import type { ConnectionState } from '../../gateway/node';
import { t } from '../../i18n';
import { AccountAvatar } from './AccountAvatar';
import {
  type AccountIdentity,
  type AccountNodeView,
  AccountPanel,
  type NodeDotState,
} from './AccountPanel';
import { fallbackStrategy, type LoginStrategy } from './auth-summary';
import { useAccountData } from './useAccountData';
import { useAccountPopover } from './useAccountPopover';

/** 当前节点的状态点看**活连接**（不是 registry 里可能过期的 status）。 */
function liveNodeState(state: ConnectionState): NodeDotState {
  switch (state) {
    case 'open':
      return 'up';
    case 'connecting':
    case 'reconnecting':
      return 'connecting';
    case 'closed':
    case 'error':
      return 'down';
    default:
      return 'unknown';
  }
}

export function AccountMenu({ navigate }: { navigate: (route: Route) => void }) {
  const { phase, authEnabled, user, loginLabel, startPath, logout } = useAuth();
  const { mode, connectionState, selectPlatformNode } = useConnection();
  const { nodes } = useNodes();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const data = useAccountData(open);
  const { triggerRef, panelRef, position } = useAccountPopover({ open, onClose: close });
  const panelId = useId();

  const signedIn = phase === 'authenticated' && user !== null;
  // auth 没启用的部署没有登录/登出可给（旧 SessionChip 的同一判据：不造死按钮）。
  const authVisible = authEnabled || signedIn;

  const identity = useMemo<AccountIdentity>(() => {
    const summary = data.summary;
    if (summary !== null) {
      return {
        name: summary.identity.name,
        id: summary.identity.id,
        role: summary.identity.role,
        team: summary.team?.name ?? null,
        avatarUrl: summary.identity.avatarUrl,
      };
    }
    // 降级：/auth/status 的 user（username 只是显示名，id 才是身份）。
    const fallbackName = (user?.username ?? '').trim();
    return {
      name: fallbackName !== '' ? fallbackName : (user?.id ?? ''),
      id: user?.id ?? null,
      role: null,
      team: null,
      avatarUrl: null,
    };
  }, [data.summary, user]);

  /** 登录策略：权威清单（可能为空）> 取数中（null）> 降级单条。 */
  const strategies = useMemo<readonly LoginStrategy[] | null>(() => {
    if (data.status === 'ok') return data.strategies;
    if (data.status === 'idle' || data.status === 'loading') return null;
    const fallback = fallbackStrategy(loginLabel, startPath);
    return fallback === null ? [] : [fallback];
  }, [data.status, data.strategies, loginLabel, startPath]);

  const currentNode = useMemo<AccountNodeView | null>(() => {
    const live = nodes.find((node) => node.current) ?? null;
    if (live !== null) {
      return {
        id: live.nodeId ?? live.name,
        name: live.name,
        state: liveNodeState(connectionState),
      };
    }
    const summary = data.summary?.node ?? null;
    if (summary !== null) return { id: summary.id, name: summary.name, state: summary.state };
    return null;
  }, [nodes, connectionState, data.summary]);

  /** 节点切换只在平台模式成立（legacy 手填节点没有 node_id，切了也连不上）。 */
  const switchableNodes = useMemo<AccountNodeView[]>(() => {
    if (mode !== 'platform') return [];
    return nodes.map((node) => ({
      id: node.nodeId ?? node.name,
      name: node.name,
      state: node.status ?? 'unknown',
    }));
  }, [mode, nodes]);

  const runLogin = useCallback(
    (strategy: LoginStrategy) => {
      close();
      if (strategy.startPath !== null) {
        // OAuth 类：整页跳到该策略的起步地址（登录页那条路也一样）。
        window.location.assign(strategy.startPath);
        return;
      }
      // 口令策略没有独立起步地址：等价于「换账号」——先登出，登录页会接管。
      void logout();
    },
    [close, logout],
  );

  const runSignOut = useCallback(() => {
    close();
    void logout();
  }, [close, logout]);

  const runSettings = useCallback(() => {
    close();
    navigate({ domain: 'settings' });
  }, [close, navigate]);

  const selectNode = useCallback(
    (nodeId: string) => {
      close();
      selectPlatformNode(nodeId);
    },
    [close, selectPlatformNode],
  );

  const displayName = identity.name !== '' ? identity.name : null;
  const triggerLabel = signedIn
    ? t('account.trigger.signedIn', { user: displayName ?? t('account.anonymous') })
    : t('account.trigger.anonymous');

  return (
    <>
      <Tooltip label={triggerLabel}>
        <button
          ref={triggerRef}
          type="button"
          // 与头部栏其它圆形控件同尺寸 / 同交互（`size-9`、`rounded-full`、hover 叠色）。
          className="inline-flex size-9 flex-none items-center justify-center rounded-full bg-transparent text-base transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none pointer-coarse:size-touch"
          aria-label={triggerLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          <AccountAvatar
            name={identity.name}
            id={identity.id}
            avatarUrl={identity.avatarUrl}
            endpoint={signedIn}
          />
        </button>
      </Tooltip>
      {open && position !== null
        ? createPortal(
            <AccountPanel
              panelId={panelId}
              panelRef={panelRef}
              position={position}
              identity={identity}
              signedIn={signedIn}
              authVisible={authVisible}
              strategies={strategies}
              currentNode={currentNode}
              nodes={switchableNodes}
              onSelectNode={selectNode}
              onLogin={runLogin}
              onSignOut={runSignOut}
              onSettings={runSettings}
            />,
            document.body,
          )
        : null}
    </>
  );
}
