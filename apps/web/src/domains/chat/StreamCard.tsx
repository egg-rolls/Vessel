/**
 * 时间线消息卡的唯一表示层（纯展示，无数据获取）。
 *
 * 统一目标：运行态（事件流）与终止态（sessions.get 回填）用同一张卡 —— 标题 +
 * 单行 ellipsis 摘要 + 可选状态色调 + 可展开体。以前运行态是卡片、终止态是一个
 * pre 看板，run 一结束样式就跳。
 *
 * 交互约定：
 * - 卡头只有**一个结构**：`title` / `meta` / `summary` / chevron 四个槽，两种形态（有展开体 /
 *   无展开体）共用同一个 `header` 节点。以前「纯行头」是一份平行 DOM（`div.event-block-summary`），
 *   CSS 少一条就把长行撑出横向滚动条（9598c095 的回归），所以不再留第二个卡头的入口；
 * - **能不能展开只看有没有 `children`**：有 ⇒ `<details>` + chevron（点击整行 / Enter / Space，
 *   原生可访问）；没有 ⇒ 纯行头（不渲染 chevron，也没有可点的空展开区）。
 *   需要「折叠一行、展开看全文」的卡（agent 消息 / 环境信息）必须给 children，
 *   否则 summary 被 ellipsis 吃掉的那一段永远读不到；
 * - 默认开合由调用方给 defaultOpen（= ui.expandCards || verbosity === 'debug'）；
 * - 用户手动开合优先于默认值，且只活在这张卡的生命周期里（不写 localStorage，
 *   卸载即丢）—— 设置变化不打断用户正在看的那张卡；
 * - summary 里不得再放可点元素（按钮 / 链接）：可操作控件放 actions 插槽
 *   （始终可见，不受折叠影响），长内容放 children；
 * - 卡片 key 由调用方给且稳定（callId / seq / 下标），运行中到终态不重挂。
 * - 动画：入场（`entering`，只动透明度）与展开 / 收起（`<details>` 的尺寸过渡）都来自
 *   `styles/motion.css`（`.motion-appear` / `.motion-disclosure`）；本组件只负责挂 class，
 *   不要在这里写 keyframes 或 transition。入场靠稳定 key + 首次挂载，重渲染不重播。
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
  /** 卡头左侧主体（工具名 / 事件标签 / 发送方 / 作用域）。 */
  title: ReactNode;
  /** 标题后的轻量标记（状态徽标、耗时、条数、run id）。 */
  meta?: ReactNode;
  /** 折叠态的单行摘要（长内容在这里被 ellipsis 截断）。 */
  summary?: ReactNode;
  /** 状态色调；neutral = 默认灰（agent 消息卡 / 环境信息卡都是 neutral）。 */
  tone?: StreamCardTone;
  /** 默认是否展开（用户手动开合后以手动状态为准）。 */
  defaultOpen: boolean;
  /** 始终可见的附加区（失败摘要、取消排队等可操作控件放这里，不进 summary）。 */
  actions?: ReactNode;
  /** 卡片组的可访问名（`<details>` 本身没有名字，读屏只念“group”）。 */
  ariaLabel?: string;
  className?: string;
  /**
   * 本卡是**首次挂载**（事件流里新追加的一项）：入场只播一次
   * （`.motion-appear`，只动透明度，keyframes 见 styles/motion.css）。
   * 判据由调用方给（会话页：首屏那批不算追加），本组件不自己判断。
   */
  entering?: boolean;
  /**
   * 展开体。**它的有无就是「能不能展开」**：给了 = 可展开（chevron + 点击整行），
   * 没给 = 纯行头。不要为了「只有一个可展开卡」再加开关位。
   */
  children?: ReactNode;
}

export function StreamCard({
  title,
  meta,
  summary,
  tone = 'neutral',
  defaultOpen,
  actions,
  ariaLabel,
  className,
  entering = false,
  children,
}: StreamCardProps) {
  // 单一判定：有展开体才渲染 `<details>` / chevron，避免「有 chevron 但展开是空的」。
  const expandable = children !== undefined;
  const [open, setOpen] = useState(defaultOpen);
  const [touched, setTouched] = useState(false);

  // 默认值变化（设置里改了 expandCards / 切到 debug）只在用户还没手动操作时跟随。
  useEffect(() => {
    if (!touched) setOpen(defaultOpen);
  }, [defaultOpen, touched]);

  // 入场（只播一次）与展开 / 收起过渡各挂一个动画 class，keyframes 与契约在
  // styles/motion.css：可展开的卡自己不用写 transition，`<details>` 的语义（键盘、
  // 可达名、收起后内容不可聚焦）由浏览器提供，这里只补尺寸过渡。
  const classes = [
    'event-block',
    'stream-card',
    TONE_CLASS[tone],
    className ?? '',
    entering ? 'motion-appear' : '',
    expandable ? 'motion-disclosure' : '',
  ]
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
