/**
 * 输入框卡片的三层骨架里被两页共用的两块（引用区 / 底部工具栏）。
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
import type { ReactNode } from 'react';
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
 * 与原 `MessageRefs` 同一份信息：`id` 用 path（删除回写靠它反查下标），
 * 标签 = `name ?? basename(path)`，全路径进 `description`（hover title）。
 */
export function refsToAttachments(refs: readonly MessageRef[]): ComposerAttachment[] {
  return refs.map((ref) => ({
    id: ref.path,
    label: refDisplayName(ref),
    kind: refKindMarker(ref.kind),
    note: refKindLabel(ref),
    description: ref.path,
  }));
}

/** chip id（= path）→ refs 下标；同一路径重复引用时取第一条。 */
export function refIndexForId(refs: readonly MessageRef[], id: string): number {
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
 * 底部横向工具栏：左侧扩展槽（插件贡献的按钮 + 宿主自绘控件），右侧
 * 上下文用量 + 主按钮（发送 / 配置连接）。
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
      className={className}
    >
      {children}
    </ComposerToolbar>
  );
}
