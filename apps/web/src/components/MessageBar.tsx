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

const TONE_CLASS: Record<MessageBarItem['tone'], string> = {
  neutral: 'bg-sunken text-muted',
  info: 'bg-info-soft text-info',
  success: 'bg-success-soft text-success',
  warn: 'bg-warn-soft text-warn',
  error: 'bg-danger-soft text-danger',
};

/**
 * AppBar 中心唯一的 transient 提示轨（0.37）。
 *
 * - 单行 chip，文本截断但 `title` 保留全文；actions 常显、可 Tab。
 * - 错误 chip 用 `role="alert"`，其余由容器 `role="status"` 统一播报。
 * - 新 toast 到达时把轨道滚到末尾；用户手动横向滚动不会被拉回。
 * - 空 items 渲染 `null`，中心区域保持空白。
 */
export function MessageBar({ items }: { items: readonly MessageBarItem[] }): ReactNode {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const lastId = items[items.length - 1]?.id;

  useEffect(() => {
    if (lastId === undefined) return;
    const track = trackRef.current;
    if (!track) return;
    track.scrollTo({ left: track.scrollWidth });
  }, [lastId]);

  if (items.length === 0) return null;

  return (
    <div
      ref={trackRef}
      className="message-bar-scroll flex min-w-0 items-center gap-2 overflow-x-auto"
      role="status"
      aria-live="polite"
    >
      {items.map((item) => (
        <div
          key={item.id}
          role={item.tone === 'error' ? 'alert' : undefined}
          className={cn(
            'flex flex-none items-center gap-2 rounded-full border border-line px-2.5 py-0.5 text-xs',
            TONE_CLASS[item.tone],
          )}
        >
          <span
            className="max-w-search overflow-hidden text-ellipsis whitespace-nowrap"
            title={item.text}
          >
            {item.text}
          </span>
          {item.actions?.map((action) => (
            <Button
              key={action.label}
              variant="link"
              size="small"
              className="shrink-0 px-0 py-0 text-inherit hover:text-inherit"
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
          {item.onDismiss && (
            <button
              type="button"
              className="shrink-0 rounded-xs px-0.5 text-sm leading-none opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={t('common.closeNotice')}
              onClick={item.onDismiss}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
