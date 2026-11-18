import { Button, Section } from '@vessel-agent/plugin-ui';
import type { Translator } from './i18n';

/**
 * 视图需要的最小 RPC 调用面：iframe 档的 PluginRpcClient 与 embed 档的
 * host.rpc 适配器都满足它（同一份展示组件，两种档位共用）。
 */
export interface RpcCaller {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export interface ViewProps {
  client: RpcCaller;
  /** iframe 档由 vessel.plugin.refresh 驱动；embed 档无事件白名单，写后自行读回。 */
  refreshKey: number;
  t: Translator;
}

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'ready'; data: T };

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function LoadingState({ label }: { label: string }) {
  return (
    <p className="py-6 text-md text-muted" aria-live="polite">
      {label}
    </p>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return <Section title={title} description={description} />;
}

export function ErrorState({
  error,
  onRetry,
  title,
  retryLabel,
}: {
  error: Error;
  onRetry: () => void;
  title: string;
  retryLabel: string;
}) {
  return (
    <Section
      title={title}
      description={error.message}
      actions={
        <Button variant="primary" onClick={onRetry}>
          {retryLabel}
        </Button>
      }
    />
  );
}

/** 写后统一提示：saved = 生效文案（契约 §5）；error = RPC 错误原文（含引用清单）。 */
export type Notice = { kind: 'saved' } | { kind: 'error'; text: string } | null;

export function NoticeLine({ notice, t }: { notice: Notice; t: Translator }) {
  if (notice === null) return null;
  return notice.kind === 'saved' ? (
    <p role="status" className="text-sm text-success">
      {t('common.saved')}
    </p>
  ) : (
    <p role="alert" className="text-sm text-danger wrap-anywhere">
      {notice.text}
    </p>
  );
}

/** 两步删除确认（P2 SDK 无 dialog 面；inline 确认/取消，引用检查错误走 NoticeLine）。 */
export function ConfirmDelete({
  question,
  busy,
  onConfirm,
  onCancel,
  t,
}: {
  question: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  t: Translator;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-danger">{question}</span>
      <Button size="small" variant="danger" disabled={busy} onClick={onConfirm}>
        {t('common.confirmDelete')}
      </Button>
      <Button size="small" disabled={busy} onClick={onCancel}>
        {t('common.cancel')}
      </Button>
    </span>
  );
}
