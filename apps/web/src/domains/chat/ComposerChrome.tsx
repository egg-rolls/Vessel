/**
 * 输入框卡片的三层骨架里被两页共用的三块（引用区 / 字段容器 / 工具栏）。
 *
 * 会话 `Composer` 与团队 `TeamComposer` 都只从这里取组件，样式与无障碍语义
 * 只有一份；两页的差异（草稿、mention、发送禁用条件）留在各自的 composer 里。
 */
import {
  type ComposerAttachment,
  ComposerAttachments,
  ComposerContextMeter,
  ComposerToolbar,
  contextPercent,
} from '@vessel-agent/plugin-ui';
import type { MouseEvent, ReactNode } from 'react';
import { Button, cn, Icon } from '../../components/ui';
import { formatTokenCount } from '../../format';
import type { MessageRef } from '../../gateway/types';
import { t } from '../../i18n';
import {
  COMPOSER_TOOLBAR_HOST_ACTIONS,
  type ComposerToolbarHostActions,
  composerToolbarLabel,
  useComposerToolbarActions,
} from './composer-toolbar';
import { refDisplayName, refKindLabel } from './MessageRefs';

/** 上下文用量：与会话头同一份数据（`context_used` / `context_max`）。 */
export interface ComposerContextUsage {
  used: number;
  max?: number;
}

/** 引用种类 → chip 前的短标记（视觉用；读屏文案另走 `note`）。 */
function refKindMarker(kind: MessageRef['kind']): string {
  if (kind === 'image') return 'img';
  if (kind === 'document') return 'doc';
  return 'file';
}

/**
 * `Message.refs`（只有路径）→ 引用区条目。
 *
 * 与原 `MessageRefs` 同一份信息：`id` = `<path>#<第几次>`（同一路径可以引用两次，
 * 删除要回写到那一条的下标），标签 = `name ?? basename(path)`，全路径进 `description`。
 */
export function refsToAttachments(refs: readonly MessageRef[]): ComposerAttachment[] {
  // id 带「同一路径的第几次」：同一路径可以引用两次，删除必须回写到那一条的下标，
  // 只靠 path 反查会永远删到第一条（渲染侧的 key 也是同一口径，见 MessageRefs）。
  const occurrence = new Map<string, number>();
  return refs.map((ref) => {
    const seen = occurrence.get(ref.path) ?? 0;
    occurrence.set(ref.path, seen + 1);
    return {
      id: `${ref.path}#${seen}`,
      label: refDisplayName(ref),
      kind: refKindMarker(ref.kind),
      note: refKindLabel(ref),
      description: ref.path,
    };
  });
}

/** chip id（`<path>#<第几次>`）→ refs 下标；解析不出时退回按 path 找第一条。 */
export function refIndexForId(refs: readonly MessageRef[], id: string): number {
  const separator = id.lastIndexOf('#');
  if (separator > 0) {
    const index = Number(id.slice(separator + 1));
    const target = refs[index];
    if (Number.isInteger(index) && target !== undefined && target.path === id.slice(0, separator)) {
      return index;
    }
  }
  return refs.findIndex((ref) => ref.path === id);
}

/**
 * 顶部引用区（唯一实现）：受控 `items` + `onRemove`，空数组不渲染（不占高）。
 * 会话页喂 `refsToAttachments(MessageRef[])`，团队页把 @ 提及 chip 也并进同一行。
 */
export function ComposerRefsArea({
  items,
  onRemove,
  removeLabel,
  className,
}: {
  items: readonly ComposerAttachment[];
  onRemove?: (id: string) => void;
  /** 删除键文案；缺省用通用「移除 {name}」。 */
  removeLabel?: (item: ComposerAttachment) => string;
  className?: string;
}) {
  return (
    <ComposerAttachments
      items={items}
      onRemove={onRemove}
      label={t('composer.refs.label')}
      removeLabel={removeLabel ?? ((item) => t('composer.refs.remove', { name: item.label }))}
      className={className}
    />
  );
}

/**
 * 发送键左侧的上下文用量：圆环（比例）+ 原生 title（`59% / 592K of 1M`）。
 *
 * 比例 / 已用 / 上限都走紧凑格式（`formatTokenCount`：`592K` / `1.2K` / `3.4M`），
 * 百分比取整且与圆环共用 `contextPercent` 的同一份规则。
 * 用量未知（没有数据 / 非当前会话）时返回 null —— 不占位、不显示假数。
 */
export function ComposerUsageMeter({ usage }: { usage?: ComposerContextUsage }) {
  if (usage === undefined) return null;
  const used = formatTokenCount(usage.used);
  const percent = contextPercent(usage.used, usage.max);
  const max = usage.max === undefined ? undefined : formatTokenCount(usage.max);
  // 比例未知（没有 max）就只说已用，绝不补一个猜出来的百分比。
  const title =
    percent !== undefined && max !== undefined
      ? t('chat.context.percentOf', { percent, used, max })
      : t('chat.context.tokens', { used });
  return <ComposerContextMeter used={usage.used} max={usage.max} title={title} text={used} />;
}

/**
 * 发送键的唯一外观（会话 / 团队同一套）：圆形灰底图标按钮，图标用主题色。
 *
 * 三态都是同一个圆，只有图标「认不认得出主题色」在变 —— 空草稿时（最常见的
 * 静止态）仍然是要的灰底圆形按钮，不是半透明残影：
 *
 * - 静止（可发送）：`bg-sunken`（与输入区同一个「凹陷」语义色）+ `border-line-strong`
 *   细描边把圆勾出来 + `text-accent` 图标。
 * - 禁用（空草稿 / 未连接 / 发送中）：灰底与描边原地不动，图标转 `faint`（去掉主题色），
 *   并 `disabled:opacity-100` 抵掉 L2 的透明度衰减 —— 禁用态是「灰色图标 + 灰底圆」，
 *   不是「整块半透明」，形状与底色始终可辨；`enabled:hover:` 也保证它不假装可点。
 * - hover（仅可用态）：主题响应 —— 底转 `accent-soft`、图标转 `accent-ink`；press 仍由
 *   `Button` 的 tint 叠色承担，与其它按钮同一套 hover / press 语言。
 * - 可访问名走 `aria-label` + `title`（图标本身 `aria-hidden`），焦点环沿用
 *   `Button` 的 `focus-visible:ring-*`，键盘可达性与其它按钮一致。
 */
const composerSendClass =
  'size-control flex-none rounded-full border border-line-strong p-0 bg-sunken text-accent pointer-coarse:min-w-touch enabled:hover:bg-accent-soft enabled:hover:text-accent-ink disabled:text-faint disabled:opacity-100';

/** 圆形发送键：图标按钮 + 主题色图标，两个 composer 共用这一份。 */
export function ComposerSendButton({
  label,
  disabled = false,
  onClick,
}: {
  /** 已翻译的可访问名（发送 / 发送中）。 */
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="plain"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={composerSendClass}
    >
      <Icon name="send" />
    </Button>
  );
}

/**
 * 底部横向工具栏：左侧扩展槽（插件贡献的按钮 + 宿主自绘控件），右侧
 * 上下文用量 + 主按钮（发送 / 配置连接）。
 *
 * 它只负责「一行控件」，视觉上**没有自己的背景**：底色由外层
 * {@link ComposerField} 承担（`.composer-toolbar { background: transparent }`），
 * 与输入框透出同一块凹槽。容器已经用 `gap` 接管了它与输入框之间的间距，
 * 所以这里把插件 UI 自带的 `mt-1.5` 抵成 `mt-0` —— 间距只有一个来源。
 *
 * 键盘：工具按钮是有序的 tab stop，Enter / Space 触发；输入框的
 * Enter / Ctrl+Enter 发送路径完全留在各自 composer 里，不受工具栏影响。
 */
export function ComposerToolbarBar({
  contextUsage,
  primary,
  hostActions = COMPOSER_TOOLBAR_HOST_ACTIONS,
  children,
  className,
}: {
  contextUsage?: ComposerContextUsage;
  /** 右侧主按钮（发送 / 配置连接），由页面传入。 */
  primary: ReactNode;
  /** 插件条目 id → 宿主回调；没有回调的条目会被丢弃。 */
  hostActions?: ComposerToolbarHostActions;
  /** 扩展槽里宿主自绘的控件。 */
  children?: ReactNode;
  className?: string;
}) {
  const actions = useComposerToolbarActions(hostActions);
  return (
    <ComposerToolbar
      label={composerToolbarLabel()}
      actions={actions}
      meta={<ComposerUsageMeter usage={contextUsage} />}
      primary={primary}
      className={cn('composer-toolbar mt-0', className)}
    >
      {children}
    </ComposerToolbar>
  );
}

/**
 * 「点空白 → 进输入框」的交互元素判据：目标落在这些里面就**一律不接管**。
 *
 * 判据只看事件目标，不给工具栏 / 卡片套 `preventDefault` 或 `stopPropagation`，
 * 所以按钮自己的点击、tab 顺序、Enter / Space 触发都还是原样。
 */
const COMPOSER_INTERACTIVE_SELECTOR =
  'button, [role="button"], [role="option"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="tab"], a[href], input, select, textarea, [contenteditable="true"]';

/**
 * 点卡片 / 工具栏 / 引用区的**空白处**时，把焦点交给同一张卡片里的 textarea。
 *
 * 挂载点只有两处，都是普通冒泡监听（不阻止任何默认行为，也不加 `tabIndex` / 键处理）：
 * - {@link ComposerField} 的容器：工具栏空白与容器内衬；
 * - 两页卡片的最外层（`Composer` / `TeamComposer`）：标题行、引用区留白 —— 卡片
 *   已经把字段容器包在里面，所以同一次点击会先后命中两个挂载点，但都指向同一个
 *   textarea，`focus()` 幂等，没有第二次副作用。
 *
 * 判据（不抢按钮、不抢已聚焦控件）：
 * 1. `event.target` 的 `closest(COMPOSER_INTERACTIVE_SELECTOR)` 非空 → 直接返回。
 *    按钮 / 链接 / 下拉项 / 输入框自己的点击照常，焦点留在被点的控件上（按钮拿到
 *    自己的 `:focus-visible`，点条目照常 `onSelect`）；点空白才是「我要开始打字」。
 * 2. 空白点击的 `target` 是容器自身或非交互子元素（工具栏 `role="toolbar"` 的
 *    flex 缝隙、`gap`、容器内衬、卡片留白）→ 找 `event.currentTarget` 里的
 *    textarea 并 `focus()`。
 * 3. 输入框不存在 / 已禁用（未连接、无 token）→ 不抢焦点（禁用控件 `focus()` 也无效）。
 *
 * 键盘流不受影响：这里没有任何 `tabIndex` / `role` / 键处理，Tab 顺序与
 * 输入框的 Enter / Ctrl+Enter 发送仍由各自 composer 负责。
 */
export function focusComposerInputOnBlankClick(event: MouseEvent<HTMLElement>): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest(COMPOSER_INTERACTIVE_SELECTOR) !== null) return;
  const input = event.currentTarget.querySelector('textarea');
  if (!(input instanceof HTMLTextAreaElement) || input.disabled) return;
  input.focus();
}

/**
 * 字段容器（唯一实现）：把「输入框 + 工具栏」包成**一块**凹槽。
 *
 * 底色 = 输入框原来的底色（`--surface-sunken`），圆角 `--radius-md`，内衬
 * `8px 10px 6px` —— 容器接管了原来 textarea 的 `8px 10px` 内衬，并把工具栏的
 * `6px` 上外边距换成容器自己的 `gap: 8px`：文本框文字位置与卡片总高都不变
 * （见 `styles/domains/chat.css` 的 `.composer-field`）。
 *
 * `children` 就是输入框；textarea 与工具栏都是 `background: transparent`，所以
 * 两者读成同一块区域，而不是「卡片里一张小卡 + 一条独立工具栏」。扩展槽按钮
 * （`variant=plain`）与圆形发送键保留各自的灰底 / 描边，不从这一层被抹平。
 *
 * 焦点环由容器 `:focus-within` 出一层，标出「输入 + 工具栏」整块；textarea
 * 自己的 outline / ring 仍然去掉，避免双层。
 *
 * 指针：点容器内衬 / 工具栏空白（不是按钮）时把焦点交给 textarea，见
 * {@link focusComposerInputOnBlankClick}；按钮自己的点击不被接管。
 *
 * 会话 `Composer` 与团队 `TeamComposer` 都走这里：容器 DOM 只有一份，页面只
 * 提供输入框（行为不同）与右侧主按钮。
 */
export function ComposerField({
  children,
  contextUsage,
  primary,
  hostActions = COMPOSER_TOOLBAR_HOST_ACTIONS,
  slot,
}: {
  /** 输入框：各页自绘（Enter / IME / mention 行为留在页面里），样式共用 `.composer-input`。 */
  children: ReactNode;
  /** 发送键左侧的上下文用量；缺省（未知）时不渲染。 */
  contextUsage?: ComposerContextUsage;
  /** 右侧主按钮（发送 / 配置连接）。 */
  primary: ReactNode;
  /** 插件条目 id → 宿主回调。 */
  hostActions?: ComposerToolbarHostActions;
  /** 扩展槽里宿主自绘的控件（排在插件贡献项之后）。 */
  slot?: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 点空白聚焦 textarea 只是鼠标便捷入口（不是「可点控件」）
    // biome-ignore lint/a11y/useKeyWithClickEvents: 键盘流不变：Tab 直接到 textarea / 工具栏按钮，空白处不需要键盘等价键
    <div className="composer-field" onClick={focusComposerInputOnBlankClick}>
      {children}
      <ComposerToolbarBar contextUsage={contextUsage} primary={primary} hostActions={hostActions}>
        {slot}
      </ComposerToolbarBar>
    </div>
  );
}
