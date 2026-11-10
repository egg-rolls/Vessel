/**
 * 时间线消息卡的唯一表示层（纯展示，无数据获取）。
 *
 * 统一目标：运行态（事件流）与终止态（sessions.get 回填）用同一张卡 —— 标题 +
 * 单行 ellipsis 摘要 + 可选状态色调 + 可展开体。以前运行态是卡片、终止态是一个
 * pre 看板，run 一结束样式就跳。
 *
 * 交互约定：
 * - 默认开合由调用方给 defaultOpen（= ui.expandCards || verbosity === 'debug'）；
 * - 用户手动开合优先于默认值，且只活在这张卡的生命周期里（不写 localStorage，
 *   卸载即丢）—— 设置变化不打断用户正在看的那张卡；
 * - summary 里不得再放可点元素（按钮 / 链接）：可操作控件放 actions 插槽
 *   （始终可见，不受折叠影响），长内容放 children；
 * - 卡片 key 由调用方给且稳定（callId / seq / 下标），运行中到终态不重挂。
 */
import { type ReactNode, useEffect, useState } from 'react';
import { Icon } from '../../components/ui';
import { t } from '../../i18n';

export type StreamCardTone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger';

/** 语义底色复用 notice-block 家族；ok / danger 走同族新增类（见 chat.css）。 */
const TONE_CLASS: Record<StreamCardTone, string> = {
  neutral: '',
  info: 'notice-block info',
  ok: 'notice-block ok',
  warn: 'notice-block warn',
  danger: 'notice-block danger',
};

export interface StreamCardProps {
  /** 卡头左侧主体（工具名 / 事件标签 / 标题）。 */
  title: ReactNode;
  /** 标题后的轻量标记（状态徽标、时间戳）。 */
  meta?: ReactNode;
  /** 折叠态的单行摘要（长内容在这里被 ellipsis 截断）。 */
  summary?: ReactNode;
  /** 状态色调；neutral = 默认灰。 */
  tone?: StreamCardTone;
  /** 默认是否展开（用户手动开合后以手动状态为准）。 */
  defaultOpen: boolean;
  /** 是否可展开；false = 纯行（不渲染 chevron，summary 不可点）。 */
  expandable?: boolean;
  /** 始终可见的附加区（失败摘要、取消排队等可操作控件放这里，不进 summary）。 */
  actions?: ReactNode;
  /** 卡片组的可访问名（`<details>` 本身没有名字，读屏只念“group”）。 */
  ariaLabel?: string;
  className?: string;
  children?: ReactNode;
}

export function StreamCard({
  title,
  meta,
  summary,
  tone = 'neutral',
  defaultOpen,
  expandable = true,
  actions,
  ariaLabel,
  className,
  children,
}: StreamCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [touched, setTouched] = useState(false);

  // 默认值变化（设置里改了 expandCards / 切到 debug）只在用户还没手动操作时跟随。
  useEffect(() => {
    if (!touched) setOpen(defaultOpen);
  }, [defaultOpen, touched]);

  const classes = ['event-block', 'stream-card', TONE_CLASS[tone], className ?? '']
    .filter((part) => part.length > 0)
    .join(' ');

  const header = (
    <>
      <span className="stream-card-title">{title}</span>
      {meta !== undefined && (
        <span className="shrink-0 font-mono text-2xs tabular-nums text-faint">{meta}</span>
      )}
      {summary !== undefined && <span className="event-block-preview">{summary}</span>}
      {expandable && <StreamCardToggle />}
    </>
  );

  if (!expandable) {
    return (
      <div
        className={classes}
        {...(ariaLabel !== undefined ? { role: 'group' as const, 'aria-label': ariaLabel } : {})}
      >
        <div className="event-block-summary">{header}</div>
        {actions}
      </div>
    );
  }

  return (
    <details
      className={classes}
      aria-label={ariaLabel}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next === open) return;
        setTouched(true);
        setOpen(next);
      }}
    >
      <summary className="event-block-summary">{header}</summary>
      {actions}
      <div className="event-block-body">{children}</div>
    </details>
  );
}

/** 展开 / 收起 icon：chevron 由 details[open] 旋转；文案进 sr-only，保留可访问名。 */
function StreamCardToggle() {
  return (
    <span className="event-block-toggle">
      <span className="event-toggle-expand sr-only">{t('chat.event.expand')}</span>
      <span className="event-toggle-collapse sr-only">{t('chat.event.collapse')}</span>
      <Icon name="chevron" className="event-toggle-icon" />
    </span>
  );
}
