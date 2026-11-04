import { cva } from 'class-variance-authority';
import type { ReactNode } from 'react';
import { t, useLocale } from '../../i18n';
import { cn } from './cn';

/**
 * 实体身份头部（L2）。
 *
 * 四槽位模型：**Identity / Scope / Status / Detail**。
 * 一个 UI 面只对「一个当前实体」负责，它就是 Identity；祖先最多 2 层、近的在前；
 * 状态最多 2 个 chip；其余（id / 路径 / 描述 / 计数）一律不进头部，走 Detail 入口。
 *
 * 四条不变量（也是 review 判据的执行点）：
 *   I1 一屏一个 L0：22px 只给当前实体，祖先永远更小更暗。
 *   I2 祖先 ≤2 层、近的在前。
 *   I3 祖先用纯文本，不包 Badge / 圆角容器，不用 bg-accent-soft。
 *   I4 一个事实一个渲染点：头部只放「名字 / 直接父级名 / 状态」。
 *
 * 为什么放 L2：被 teams / team / agents / nodes 四个域使用，且需要 size variant。
 * 更关键的是「当前」与 scope 的降级样式必须由这里独占 —— 否则各域会各写一套
 * （2026-11 审计已发现「当前」有三种写法，其中两种借用 bg-accent-soft，
 *  而该色在本仓是「选中/激活」的专用信号）。
 */

export interface EntityScopeItem {
  /** 祖先显示名。调用方负责回退（name || id），组件不猜。 */
  label: string;
  /** 给了才渲染成链接；默认纯文本（祖先不是导航入口，导航靠左栏列表/返回按钮）。 */
  onOpen?: () => void;
}

export interface EntityHeaderProps {
  /** Identity：唯一的名字。禁止传 description / workspace / 错误消息。 */
  title: string;
  /** 页面唯一 h1（默认）/ 面板 h2 / 列表分组 h3。 */
  titleAs?: 'h1' | 'h2' | 'h3';
  /** page = font-serif text-title(22)；panel = font-sans text-lg(16)。 */
  size?: 'page' | 'panel';
  /** Scope：≤2 项，近→远。空数组 = 顶层实体（node）。 */
  scope?: readonly EntityScopeItem[];
  /** 最近祖先就是「当前节点」→ 渲染降级的「当前」（纯文本，永不用 accent）。 */
  current?: boolean;
  /** Status：≤2 个 L2 chip（StatusChip / Badge）。组件不校验数量，review 校验。 */
  status?: ReactNode;
  /** 右侧动作。 */
  actions?: ReactNode;
  /** Detail 入口：长文本 / 路径 / id / 计数的唯一合法去处。 */
  onOpenDetails?: () => void;
  detailsLabel?: string;
  /** 经 cn() 合并；调用方只能加布局，不能改语义色。 */
  className?: string;
}

const wrapper = cva(
  'flex min-w-0 items-start justify-between gap-4 max-compact:flex-col max-compact:items-start',
);

const heading = cva('break-words font-semibold leading-tight tracking-wide text-ink', {
  variants: {
    size: {
      page: 'font-serif text-title',
      panel: 'font-sans text-lg',
    },
  },
  defaultVariants: { size: 'page' },
});

/** 单个祖先名：第一层 12.5px/muted，第二层 10px/faint。严格递减。 */
const scopeLead = 'min-w-0 max-w-80 truncate font-medium text-md text-muted';
const scopeTail = 'min-w-0 max-w-60 truncate text-2xs text-faint';

function ScopeEntry({ item, first }: { item: EntityScopeItem; first: boolean }) {
  const className = cn(first ? scopeLead : scopeTail);
  if (!item.onOpen) {
    return (
      <span className={className} title={item.label}>
        {item.label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cn(
        className,
        'cursor-pointer border-0 bg-transparent p-0 text-left underline-offset-2 hover:underline',
      )}
      onClick={item.onOpen}
      title={item.label}
    >
      {item.label}
    </button>
  );
}

export function EntityHeader({
  title,
  titleAs: TitleTag = 'h1',
  size = 'page',
  scope = [],
  current = false,
  status,
  actions,
  onOpenDetails,
  detailsLabel,
  className,
}: EntityHeaderProps) {
  useLocale();
  // I2：超出 2 层由组件截断，调用方不需要自己 slice。
  const ancestors = scope.slice(0, 2);
  const hasScope = ancestors.length > 0 || current;

  return (
    <div className={cn(wrapper(), className)}>
      <div className="min-w-0">
        <TitleTag className={cn(heading({ size }))}>{title}</TitleTag>
        {hasScope && (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-md leading-normal">
            {ancestors.length > 0 && <span className="text-faint">{t('entity.scopeIn')}</span>}
            {ancestors.map((item, index) => (
              <span
                className="flex min-w-0 items-center gap-1.5"
                // biome-ignore lint/suspicious/noArrayIndexKey: scope 最多 2 项且顺序即语义（近→远）
                key={`${item.label}-${index}`}
              >
                {index > 0 && (
                  <span aria-hidden="true" className="text-2xs text-faint">
                    ·
                  </span>
                )}
                <ScopeEntry item={item} first={index === 0} />
              </span>
            ))}
            {current && (
              // I3：纯文本，不包 chip、不用 bg-accent-soft（那是选中/激活专用）。
              <span className="text-2xs text-faint" title={t('entity.currentNode')}>
                {ancestors.length > 0 && (
                  <span aria-hidden="true" className="mr-1">
                    ·
                  </span>
                )}
                {t('entity.currentNode')}
              </span>
            )}
          </div>
        )}
        {status && (
          <div className="mt-1.5 flex flex-none flex-wrap items-center gap-1.5">{status}</div>
        )}
        {onOpenDetails && (
          <button
            type="button"
            className="mt-1.5 cursor-pointer border-0 bg-transparent p-0 text-left text-md text-accent underline-offset-2 hover:underline"
            onClick={onOpenDetails}
          >
            {detailsLabel ?? t('entity.details')}
          </button>
        )}
      </div>
      {actions && (
        <div className="flex flex-none flex-wrap items-start justify-end gap-2 max-compact:w-full">
          {actions}
        </div>
      )}
    </div>
  );
}
