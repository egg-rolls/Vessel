import { Button, Section } from '@vessel-agent/plugin-ui';
import { type ReactNode, useEffect, useRef } from 'react';
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
/** Section 的 GHOST 覆盖：摘掉 bg-raised / shadow-elev-1，换透黑底细线（cn=twMerge 生效）。 */
export const GHOST_SECTION_CLASS = 'border border-line bg-transparent shadow-none';

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
 * plugin-ui 没有 Modal 组件，apps/web 的 ModalShell 依赖宿主私有组件与
 * @utility modal-fade/rise/pad，iframe / embed 两层都够不着——这里只用
 * 两层都有的 utilities 落一个零依赖版本：Esc / 遮罩点击关闭、Tab 焦点圈、
 * 打开锁 body 滚动、关闭恢复触发元素焦点。面板口径 GHOST：页面黑底 + 细线。
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
      className="fixed inset-0 z-modal flex items-center justify-center overflow-y-auto overscroll-contain bg-scrim p-4"
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
        className="relative flex max-h-[86dvh] w-full max-w-modal-lg flex-col overflow-hidden rounded-lg border border-line bg-bg shadow-elev-4"
      >
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain p-5 max-compact:p-4">
          {children}
        </div>
        <Button
          size="small"
          aria-label={closeLabel}
          className={`absolute right-2 top-2 ${GHOST_BUTTON_CLASS}`}
          onClick={onClose}
        >
          ×
        </Button>
      </div>
    </div>
  );
}
