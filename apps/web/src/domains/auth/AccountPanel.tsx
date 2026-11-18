/**
 * 账号浮层的内容（纯展示）。
 *
 * 五块，顺序即优先级：身份 → 当前节点 → 登录方式 → 设置 → 登出。
 * 视觉按 DESIGN §2 的 L3：`bg-raised` + `shadow-elev-3` + `radius-lg`，**无描边**
 * （边界靠底色差与间距，§1.1 / §3.1）；行与行之间只留 gap，不画分隔线（§1.3）。
 * 状态点复用导航栏的四档语义（`app/nav-status.ts`）：accent=通、amber=进行中、
 * danger=失败、muted=未知 —— 颜色永远配一份文字，不单独承载信息。
 *
 * 这里**不出现任何命令行文本**（宪法十四条）：所有文案都是「发生了什么 + 能点什么」。
 *
 * @module web/domains/auth/AccountPanel
 */

import type { RefObject } from 'react';
import type { NavStatusTone } from '../../app/nav-status';
import { Badge } from '../../components/ui';
import { cn } from '../../components/ui/cn';
import { t } from '../../i18n';
import { AccountAvatar } from './AccountAvatar';
import type { LoginStrategy } from './auth-summary';
import type { PopoverPosition } from './useAccountPopover';

/** 浮层里节点的显示态：比契约多一档「正在连接」（当前节点的实时证据）。 */
export type NodeDotState = 'up' | 'connecting' | 'down' | 'unknown';

const NODE_TONE: Readonly<Record<NodeDotState, NavStatusTone>> = {
  up: 'accent',
  connecting: 'amber',
  down: 'danger',
  unknown: 'muted',
};

const NODE_STATE_KEY: Readonly<Record<NodeDotState, string>> = {
  up: 'account.node.state.up',
  connecting: 'account.node.state.connecting',
  down: 'account.node.state.down',
  unknown: 'account.node.state.unknown',
};

export interface AccountIdentity {
  /** 显示名；未登录时为空串。 */
  name: string;
  /** 身份 id（显示的 id 就是身份本身）；未知时 null。 */
  id: string | null;
  role: string | null;
  team: string | null;
  avatarUrl: string | null;
}

export interface AccountNodeView {
  id: string;
  name: string;
  state: NodeDotState;
}

/** 行样式：悬浮层里的可点行（无描边、圆角 = 外层 16 − padding 8 = 8）。 */
const ROW_CLASS =
  'flex w-full items-center gap-2 rounded-md bg-transparent px-2.5 py-2 text-left text-sm text-ink transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-raised pointer-coarse:min-h-touch';

const HEADING_CLASS = 'px-2.5 font-mono text-2xs uppercase tracking-widest text-faint select-none';

function NodeStateDot({ state }: { state: NodeDotState }) {
  return (
    <span
      className="size-1.5 flex-none rounded-full bg-faint data-[tone=accent]:bg-accent data-[tone=amber]:bg-amber data-[tone=amber]:pulse-soft data-[tone=danger]:bg-danger"
      data-tone={NODE_TONE[state]}
      // 圆点自己带文字标签：色盲 / 灰度屏也能读（DESIGN §5.3）。
      role="img"
      aria-label={t(NODE_STATE_KEY[state])}
    />
  );
}

export interface AccountPanelProps {
  panelId: string;
  panelRef: RefObject<HTMLDivElement | null>;
  position: PopoverPosition;
  identity: AccountIdentity;
  /** 有会话身份（`/auth/status` 的 authenticated）。 */
  signedIn: boolean;
  /** auth 没启用的部署连「登录」都不给：不造死按钮。 */
  authVisible: boolean;
  /**
   * 登录策略。`null` = 还不知道（首次取数中）—— 此时不渲染「没有登录方式」，
   * 免得把「没查完」说成「没有」。
   */
  strategies: readonly LoginStrategy[] | null;
  currentNode: AccountNodeView | null;
  /** 可切换的节点（含当前节点）；`<= 1` 时不出切换区。 */
  nodes: readonly AccountNodeView[];
  onSelectNode: (id: string) => void;
  onLogin: (strategy: LoginStrategy) => void;
  onSignOut: () => void;
  onSettings: () => void;
}

export function AccountPanel({
  panelId,
  panelRef,
  position,
  identity,
  signedIn,
  authVisible,
  strategies,
  currentNode,
  nodes,
  onSelectNode,
  onLogin,
  onSignOut,
  onSettings,
}: AccountPanelProps) {
  const others = nodes.filter((node) => node.id !== currentNode?.id);
  const displayName = identity.name !== '' ? identity.name : t('account.anonymous');
  return (
    <div
      ref={panelRef}
      id={panelId}
      role="dialog"
      aria-label={t('account.panel')}
      tabIndex={-1}
      className="fixed z-tooltip flex w-72 max-w-[calc(100vw-1rem)] flex-col gap-3 overflow-y-auto overscroll-contain rounded-lg bg-raised p-2 shadow-elev-3 modal-rise"
      style={{
        right: position.right,
        top: position.top,
        bottom: position.bottom,
        maxHeight: position.maxHeight,
      }}
    >
      {/* 1. 身份：显示名 + id + 角色/团队徽标 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 px-2.5 py-1">
          <AccountAvatar
            name={identity.name}
            avatarUrl={identity.avatarUrl}
            size="identity"
            muted={!signedIn}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium text-ink">{displayName}</span>
            {identity.id !== null && (
              <span className="truncate font-mono text-2xs text-faint">{identity.id}</span>
            )}
          </div>
        </div>
        {(identity.role !== null || identity.team !== null) && (
          <div className="flex flex-wrap items-center gap-1 px-2.5">
            {identity.role !== null && (
              <Badge tone="neutral">{t('account.role', { role: identity.role })}</Badge>
            )}
            {identity.team !== null && (
              <Badge tone="neutral">{t('account.team', { team: identity.team })}</Badge>
            )}
          </div>
        )}
      </div>

      {/* 2. 当前节点（名字 + 状态点）与多节点切换 */}
      <section className="flex flex-col gap-0.5" aria-label={t('account.node.title')}>
        <h3 className={HEADING_CLASS}>{t('account.node.title')}</h3>
        {currentNode === null ? (
          <p className="px-2.5 py-1 text-sm text-muted">{t('account.node.none')}</p>
        ) : (
          <div className="flex items-center gap-2 rounded-md px-2.5 py-1.5">
            <NodeStateDot state={currentNode.state} />
            <span className="min-w-0 flex-1 truncate text-sm text-ink">{currentNode.name}</span>
            <span className="flex-none text-xs text-muted">
              {t(NODE_STATE_KEY[currentNode.state])}
            </span>
          </div>
        )}
        {others.length > 0 && (
          // 用列表而不是 `role="group"` 的 div：切换项本来就是一个可枚举的集合。
          <ul
            className="m-0 flex list-none flex-col gap-0.5 p-0"
            aria-label={t('account.node.switch')}
          >
            {others.map((node) => (
              <li key={node.id} className="flex">
                <button
                  type="button"
                  className={ROW_CLASS}
                  onClick={() => {
                    onSelectNode(node.id);
                  }}
                >
                  <NodeStateDot state={node.state} />
                  <span className="min-w-0 flex-1 truncate">{node.name}</span>
                  <span className="flex-none text-xs text-muted">
                    {t(NODE_STATE_KEY[node.state])}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 3. 登录方式（已登录时 = 重新登录 / 切换账号） */}
      {authVisible && (
        <section className="flex flex-col gap-0.5" aria-label={t('account.auth.title')}>
          <h3 className={HEADING_CLASS}>
            {signedIn ? t('account.auth.relogin') : t('account.auth.title')}
          </h3>
          {strategies !== null &&
            (strategies.length === 0 ? (
              <p className="px-2.5 py-1 text-sm text-muted">{t('account.auth.empty')}</p>
            ) : (
              strategies.map((strategy) => (
                <button
                  key={strategy.id}
                  type="button"
                  className={ROW_CLASS}
                  onClick={() => {
                    onLogin(strategy);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{strategy.label}</span>
                  {strategy.startPath === null && (
                    <span className="flex-none text-2xs text-faint">
                      {t('account.auth.signOutFirst')}
                    </span>
                  )}
                </button>
              ))
            ))}
        </section>
      )}

      {/* 4/5. 设置 + 登出 */}
      <div className="flex flex-col gap-0.5">
        <button type="button" className={ROW_CLASS} onClick={onSettings}>
          <span className="min-w-0 flex-1 truncate">{t('account.settings')}</span>
        </button>
        {signedIn && (
          <button
            type="button"
            className={cn(ROW_CLASS, 'text-danger hover:bg-danger-soft')}
            onClick={onSignOut}
          >
            <span className="min-w-0 flex-1 truncate">{t('auth.logout')}</span>
          </button>
        )}
      </div>
    </div>
  );
}
