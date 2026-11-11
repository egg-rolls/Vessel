import type { ReactNode } from 'react';
import { Button } from './Button';
import { cn } from './cn';

/**
 * 输入框卡片底部的横向工具栏（会话 / 团队共用）。
 *
 * 三层结构里的最下层：左侧是扩展槽（宿主按钮 + 插件贡献的按钮），右侧依次是
 * 元信息（上下文用量）与主按钮（发送）。工具栏本身不认识插件 / i18n / 路由：
 * 贡献项由宿主映射成 {@link ComposerToolbarAction} 再传进来。
 */
export interface ComposerToolbarAction {
  /** 稳定 id（插件贡献项用 `pluginId:id`，宿主动作用自己的字面量）。 */
  id: string;
  /** 读屏名称 + 悬浮说明；必填 —— 工具栏按钮可能没有可见正文。 */
  label: string;
  /** 可见文字；缺省用 `label`。 */
  text?: string;
  /** 前置图标（可选文本，例如短标记）；纯装饰，不进无障碍名。 */
  glyph?: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface ComposerToolbarProps {
  /** 扩展槽：按给定顺序渲染的按钮；空数组时扩展槽不占位。 */
  actions?: readonly ComposerToolbarAction[];
  /** 扩展槽里的额外内容（宿主自绘控件），排在 `actions` 之后。 */
  children?: ReactNode;
  /** 右侧主按钮左侧的元信息（上下文用量等）；缺省不渲染。 */
  meta?: ReactNode;
  /** 右侧主按钮（发送 / 配置连接）；必填。 */
  primary: ReactNode;
  /** 工具栏无障碍名称；调用方传已翻译文案。 */
  label?: string;
  className?: string;
}

export function ComposerToolbar({
  actions = [],
  children,
  meta,
  primary,
  label,
  className,
}: ComposerToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      aria-orientation="horizontal"
      className={cn('mt-1.5 flex items-center gap-2', className)}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {actions.map((action) => (
          <Button
            key={action.id}
            type="button"
            variant="plain"
            size="small"
            aria-label={action.label}
            title={action.label}
            disabled={action.disabled}
            onClick={action.onSelect}
          >
            {action.glyph !== undefined && (
              <span aria-hidden="true" className="font-mono text-2xs text-faint">
                {action.glyph}
              </span>
            )}
            {action.text ?? action.label}
          </Button>
        ))}
        {children}
      </div>
      <div className="flex flex-none items-center gap-2">
        {meta}
        {primary}
      </div>
    </div>
  );
}
