import type { ReactNode } from 'react';
import type {
  AskUserAnswer,
  AskUserRequest,
  PermissionRequest,
  PermissionScope,
} from '../../gateway/types';
import { t } from '../../i18n';
import { AskCard } from './AskCard';
import { PermissionCard } from './PermissionCard';

/**
 * Composer 槽位的三个互斥状态（0.18）：Composer / PermissionPrompt / AskPrompt。
 *
 * 权限与 ask_user 都会阻塞对话，所以 pending 期间用同尺寸提示卡替换输入框；
 * 多个 pending 串行处理（ChatView 只把 `nextPending` 的第一条传进来），
 * 应答后请求从连接状态移除，槽位自动切到下一条或恢复 Composer。
 */
function PromptShell({
  label,
  more,
  children,
}: {
  label: string;
  /** 除当前这条外还剩多少条待处理。 */
  more: number;
  children: ReactNode;
}) {
  return (
    <footer className="composer-area prompt-area">
      <section className="prompt-slot" aria-label={t('chat.prompt.label')} aria-live="polite">
        <div className="prompt-slot-head">
          <span className="prompt-slot-kind">{label}</span>
          {more > 0 && <span className="dim">{t('chat.prompt.more', { count: more })}</span>}
          <span className="dim prompt-slot-hint">{t('chat.prompt.blocking')}</span>
        </div>
        {children}
      </section>
    </footer>
  );
}

/** 权限请求：替换输入框，保留允许（once/session/always）与拒绝。 */
export function PermissionPrompt({
  request,
  more = 0,
  busy = false,
  onDecide,
}: {
  request: PermissionRequest;
  more?: number;
  busy?: boolean;
  onDecide: (decision: 'allow' | 'deny', scope: PermissionScope) => void;
}) {
  return (
    <PromptShell label={t('chat.prompt.permission')} more={more}>
      <PermissionCard request={request} busy={busy} onDecide={onDecide} />
    </PromptShell>
  );
}

/** ask_user：替换输入框，保留提交与取消（取消即提交空答案）。 */
export function AskPrompt({
  request,
  more = 0,
  busy = false,
  onSubmit,
  onCancel,
}: {
  request: AskUserRequest;
  more?: number;
  busy?: boolean;
  onSubmit: (answers: AskUserAnswer[]) => void;
  onCancel: () => void;
}) {
  return (
    <PromptShell label={t('chat.prompt.question')} more={more}>
      <AskCard request={request} busy={busy} onSubmit={onSubmit} onCancel={onCancel} />
    </PromptShell>
  );
}
