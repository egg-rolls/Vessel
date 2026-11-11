import { cn } from './cn';

/**
 * 输入框卡片顶部的引用区（附件 / 文档 / @ 提及共用一套 chip）。
 *
 * 受控：`items` + `onRemove`，不做任何本地状态，也不碰上传。空数组时不渲染，
 * 因此「没有引用」不占高度。条目类型由宿主决定（文件、图片、`@agent` 都行）。
 */
export interface ComposerAttachment {
  /** 稳定 id（宿主生成；用作 key 与删除回调参数）。 */
  id: string;
  /** 可见标签（文件名、`@agent` 名等）。 */
  label: string;
  /** 类别短标记（如 `@`、`file`）；纯装饰，渲染在标签前。 */
  kind?: string;
  /** 类别读屏文案（如「图片」）；渲染成 sr-only，`kind` 只是装饰。 */
  note?: string;
  /** 补充说明（完整路径等），用作悬浮标题与读屏文案的兜底。 */
  description?: string;
}

export interface ComposerAttachmentsProps {
  items: readonly ComposerAttachment[];
  /** 缺省不渲染删除键（只读引用）。 */
  onRemove?: (id: string) => void;
  /** 区域无障碍名称；调用方传已翻译文案。 */
  label?: string;
  /** 删除键的读屏名称；缺省用条目自身的 `label`。 */
  removeLabel?: (item: ComposerAttachment) => string;
  className?: string;
}

export function ComposerAttachments({
  items,
  onRemove,
  label,
  removeLabel,
  className,
}: ComposerAttachmentsProps) {
  if (items.length === 0) return null;

  return (
    <fieldset
      className={cn('mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0', className)}
    >
      <legend className="sr-only">{label}</legend>
      {items.map((item) => (
        <span
          key={item.id}
          className="inline-flex max-w-full items-center gap-1 rounded-full bg-sunken py-px pr-1 pl-2 text-xs text-muted"
          title={item.description ?? item.kind ?? item.label}
        >
          {item.kind !== undefined && (
            <span aria-hidden="true" className="font-mono text-2xs text-faint">
              {item.kind}
            </span>
          )}
          {item.note !== undefined && <span className="sr-only">{item.note}</span>}
          <span className="truncate">{item.label}</span>
          {onRemove !== undefined && (
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent px-1 py-0.5 text-sm leading-none text-inherit"
              aria-label={removeLabel?.(item) ?? item.label}
              onClick={() => onRemove(item.id)}
            >
              ×
            </button>
          )}
        </span>
      ))}
    </fieldset>
  );
}
