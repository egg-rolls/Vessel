import { Button, Section } from '@vessel-agent/plugin-ui';
import { type ReactNode, useEffect, useRef } from 'react';
import type { Translator } from './i18n';

/*
 * 表面口径：一律用 plugin-ui 共享组件的默认表面（raised 卡片 / sunken 控件），
 * 与工具页 ToolsPanel / McpPanel 同款。曾套过整页 GHOST 透黑底细线覆盖——
 * 那是宿主设置弹窗 / 运行期事件日志的局部皮肤（apps/web ghost-control.ts
 * 明确「sunken 底仍是其余域的默认」），整页套用造成与工具页观感背离，已摘除。
 */

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

const MODAL_FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 轻量详情弹窗（工具页 ModalShell 的插件本地等价物）。
 * plugin-ui 没有 Modal 组件，apps/web 的 ModalShell 依赖宿主私有组件（IconButton /
 * Tooltip）与 portal，iframe 层够不着——这里只用两层都有的 utilities 落一个
 * 零依赖版本：Esc / 遮罩点击关闭、Tab 焦点圈、打开锁 body 滚动、关闭恢复触发
 * 元素焦点。面板口径逐字对齐 ModalShell（apps/web components/Modal.tsx）：
 * raised 面 + elev-4 + gap-3 + min(86dvh, --modal-max-h)；safe-area 内衬与
 * fade/rise 入场由 skills-modal-* 本地 utility 提供（embed.css / styles.css，
 * 值全走 host token，独立命名避开宿主同名 keyframes）。
 */
export function Modal({
  label,
  closeLabel,
  onClose,
  children,
}: {
  label: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = panelRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusables = (): HTMLElement[] =>
      root
        ? [...root.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE)].filter(
            (element) => element.offsetParent !== null || element === document.activeElement,
          )
        : [];
    // 没有可聚焦元素时把焦点放到面板本身（tabIndex=-1），焦点不留在遮罩外。
    (focusables()[0] ?? root)?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop mousedown closes the modal
    <div
      className="skills-modal-fade fixed inset-0 z-modal flex h-dvh w-screen items-center justify-center overflow-y-auto overscroll-contain bg-scrim skills-modal-pad"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="skills-modal-rise relative flex max-h-[min(86dvh,var(--modal-max-h))] w-full max-w-modal-lg flex-col gap-3 overflow-hidden rounded-lg border border-line bg-raised p-5 shadow-elev-4 max-compact:p-4"
      >
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain p-1 -m-1">
          {children}
        </div>
        <Button
          size="small"
          aria-label={closeLabel}
          className="absolute right-2 top-2"
          onClick={onClose}
        >
          ×
        </Button>
      </div>
    </div>
  );
}
