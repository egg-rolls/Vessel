import type { ReactNode } from 'react';
import { Button } from './Button';
import { cn } from './cn';
import { Select } from './Field';

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
  /**
   * 声明式菜单（additive，q-thinking-plugin P3）。存在时渲染菜单按钮（点击展开
   * 档位表）而非普通按钮；通用形状，任何插件可用，工具栏零插件专属代码。
   */
  menu?: ComposerToolbarMenuState;
}

/** 菜单按钮的运行时状态（宿主经 RPC read 算出后传入）。 */
export interface ComposerToolbarMenuState {
  /** 档位表（已翻译文案；能力过滤后的可选项）。 */
  items: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>;
  /** 当前选中值（按钮文案显示它对应的档位）。 */
  current?: string;
  /** 菜单底部说明行（如「该模型仅支持开/关」）。 */
  hint?: string;
  /** 选中一档（宿主经 RPC write 落状态）。 */
  onSelect: (value: string) => void;
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
        {actions.map((action) =>
          action.menu !== undefined ? (
            <ToolbarMenuButton key={action.id} action={action} />
          ) : (
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
          ),
        )}
        {children}
      </div>
      <div className="flex flex-none items-center gap-2">
        {meta}
        {primary}
      </div>
    </div>
  );
}

/**
 * 工具栏选择器 pill 样式：与宿主模型选择 pill（memberModelPillClass + quiet 色调）
 * 同构。plugin-ui 不 import 宿主模块，这里复刻同一套设计 token；cn=twMerge 保证
 * 这些类可靠覆盖 Select 的表单触发器基类。
 */
const TOOLBAR_PILL_CLASS =
  'h-control w-auto max-w-36 flex-none justify-center gap-1 rounded-full border border-line-strong bg-sunken px-2.5 py-0 text-xs text-muted shadow-none enabled:hover:text-ink disabled:text-faint disabled:opacity-100';

/**
 * 声明式菜单按钮（additive，P3；D5 同构裁定）：复用通用 Select（combobox +
 * portal listbox）——与模型选择器同一套弹层交互 / 样式 / 无障碍语义。
 * 工具栏不认识具体插件：档位 / 当前值 / 说明都由宿主经 {@link ComposerToolbarMenuState} 传入。
 */
function ToolbarMenuButton({ action }: { action: ComposerToolbarAction }) {
  const menu = action.menu;
  if (menu === undefined) return null;
  // current 缺失（read 未回）或不在档位表（如不支持模型上的会话 override）时合成
  // 显示项，保证触发器非空；缺失态用 action.label 占位并禁用防误选。
  const current = menu.current ?? '';
  const items = menu.items.some((item) => item.value === current)
    ? menu.items
    : [
        ...menu.items,
        {
          value: current,
          label: menu.current ?? action.label,
          disabled: menu.current === undefined,
        },
      ];
  return (
    <Select
      className={TOOLBAR_PILL_CLASS}
      aria-label={action.label}
      title={action.label}
      disabled={action.disabled}
      value={current}
      popupMinWidth={144}
      onChange={(event) => menu.onSelect(event.target.value)}
      footer={menu.hint !== undefined && menu.hint !== '' ? menu.hint : undefined}
    >
      {items.map((item) => (
        <option key={item.value} value={item.value} disabled={item.disabled}>
          {item.label}
        </option>
      ))}
    </Select>
  );
}
