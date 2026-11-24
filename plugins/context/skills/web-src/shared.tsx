import { Button, Section } from '@vessel-agent/plugin-ui';
import type { Translator } from './i18n';

/**
 * 透黑底细线局部覆盖（对齐 apps/web ghost-control 的 q-ui-style 先例：
 * 摘局部声明，不动 plugin-ui 共享组件 / 共享 token）。
 * 全部是既有 utilities：细线勾形 + 透出页面黑底 + 摘掉 inset 凹槽；
 * 焦点环 / disabled 透明度 / tint-hover 仍由基类提供。
 */
export const GHOST_CONTROL_CLASS = 'border border-line-strong bg-transparent shadow-none';
export const GHOST_BUTTON_CLASS = 'border border-line-strong bg-transparent';
export const GHOST_PANEL_CLASS = 'border border-line bg-transparent';

/**
 * unknown_id 业务错（get / trust_set 对已删除 / 重命名技能的回执）。
 * 兼容两种形态：RPC 回执的 error.code，以及传输层抛出的 Error.message。
 * 命中时详情面板走「技能已不存在」优雅降级，而不是裸错误文本。
 */
export function isUnknownIdError(error: { code?: string; message?: string } | undefined): boolean {
  if (error === undefined) return false;
  return error.code === 'unknown_id' || (error.message?.includes('unknown skill id') ?? false);
}

/**
 * Minimal RPC surface the views need: the iframe tier's PluginRpcClient and
 * the embed tier's host.rpc adapter both satisfy it (one set of display
 * components, two tiers).
 */
export interface RpcCaller {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export interface ViewProps {
  client: RpcCaller;
  /** iframe tier is driven by vessel.plugin.refresh; embed tier refetches after writes. */
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
