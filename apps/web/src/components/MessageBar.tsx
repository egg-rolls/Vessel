import { type ReactNode, useEffect, useRef } from 'react';
import { t } from '../i18n';
import { Button } from './ui/Button';
import { cn } from './ui/cn';

export interface MessageBarAction {
  label: string;
  onClick: () => void;
}

export interface MessageBarItem {
  id: string;
  tone: 'neutral' | 'info' | 'success' | 'warn' | 'error';
  text: string;
  /** 0..n 个可交互动作（跳转 / retry / reload）。 */
  actions?: readonly MessageBarAction[];
  /** 关闭按钮；缺省不显示。 */
  onDismiss?: () => void;
}

/**
 * tone 只表达“这件事有多需要被看见”，不决定结构：
 * 软色底 + 同色文字 + 同色圆点，错误档保留最高权重。
 */
const TONE_CLASS: Record<MessageBarItem['tone'], string> = {
  neutral: 'bg-sunken text-muted',
  info: 'bg-info-soft text-info',
  success: 'bg-success-soft text-success',
  warn: 'bg-warn-soft text-warn',
  error: 'bg-danger-soft text-danger',
};

/**
 * AppBar 中心唯一的 transient 提示轨（0.37，0.38 视觉重构）。
 *
 * - 单行胶囊：tone 圆点 + 文本；文本截断但 `title` 保留全文。
 * - actions 常显、可 Tab，与文本之间用发丝分隔线隔开；关闭按钮有真实命中面积。
 * - 错误 chip `role="alert"`，其余由容器 `role="status"` 统一播报。
 * - 新 item 到达时把轨道滚到末尾；reduced-motion 下不做平滑滚动。
 * - 空 items 渲染 `null`，中心区域保持空白。
 */
export function MessageBar({ items }: { items: readonly MessageBarItem[] }): ReactNode {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const lastId = items[items.length - 1]?.id;

  useEffect(() => {
    if (lastId === undefined) return;
    const track = trackRef.current;
    if (!track) return;
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    track.scrollTo({
      left: track.scrollWidth,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }, [lastId]);

  if (items.length === 0) return null;

  return (
    <div
      ref={trackRef}
      className="message-bar-scroll flex min-w-0 items-center justify-start gap-2 overflow-x-auto py-1"
      role="status"
      aria-live="polite"
    >
      {items.map((item) => (
        <div
          key={item.id}
          role={item.tone === 'error' ? 'alert' : undefined}
          className={cn(
            'message-chip flex flex-none items-center gap-1.5 rounded-full px-2.5 py-1 text-sm leading-tight pointer-coarse:min-h-touch',
            TONE_CLASS[item.tone],
          )}
        >
          <span className="size-1.5 flex-none rounded-full bg-current" aria-hidden="true" />
          <span
            className="max-w-search overflow-hidden text-ellipsis whitespace-nowrap max-compact:max-w-40"
            title={item.text}
          >
            {item.text}
          </span>
          {item.actions && item.actions.length > 0 && (
            <>
              <span className="h-3 w-px flex-none bg-line-strong" aria-hidden="true" />
              {item.actions.map((action) => (
                <Button
                  key={action.label}
                  variant="link"
                  size="small"
                  className="shrink-0 px-0.5 py-0 text-sm font-medium text-inherit decoration-1 underline-offset-2 hover:text-inherit"
                  onClick={action.onClick}
                >
                  {action.label}
                </Button>
              ))}
            </>
          )}
          {item.onDismiss && (
            <button
              type="button"
              className="-mr-0.5 flex size-5 flex-none items-center justify-center rounded-full bg-transparent text-base leading-none opacity-60 transition duration-150 hover:bg-hover hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface pointer-coarse:size-control"
              aria-label={t('common.closeNotice')}
              onClick={item.onDismiss}
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
