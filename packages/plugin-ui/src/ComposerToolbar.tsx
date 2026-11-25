import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
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
 * 声明式菜单按钮（additive，P3）：点击展开档位表，方向键移动 / Enter 执行 /
 * Esc 与点击外部关闭并把焦点还给触发按钮（与 web ActionMenu 同一套无障碍语义）。
 * 工具栏不认识具体插件：档位 / 当前值 / 说明都由宿主经 {@link ComposerToolbarMenuState} 传入。
 */
function ToolbarMenuButton({ action }: { action: ComposerToolbarAction }) {
  const menu = action.menu;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const menuEl = menuRef.current;
    const buttons = () => [
      ...(menuEl?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []),
    ];
    buttons()[0]?.focus();
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuEl?.contains(target) || anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        anchorRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
        return;
      }
      const list = buttons();
      if (list.length === 0) return;
      const index = list.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        list[(index + 1 + list.length) % list.length]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        list[(index - 1 + list.length) % list.length]?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (menu === undefined) return null;
  const currentLabel =
    menu.items.find((item) => item.value === menu.current)?.label ?? menu.current;
  const text = currentLabel !== undefined ? `${action.label}: ${currentLabel}` : action.label;

  return (
    <span ref={anchorRef} className="relative inline-flex flex-none">
      <Button
        type="button"
        variant="plain"
        size="small"
        aria-label={action.label}
        title={action.label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={action.disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {text}
      </Button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={action.label}
          className="absolute bottom-full left-0 z-20 mb-1 flex min-w-36 flex-col rounded-lg bg-raised p-1 shadow-elev-3"
        >
          {menu.items.map((item) => (
            <button
              key={item.value}
              type="button"
              role="menuitemradio"
              aria-checked={item.value === menu.current}
              disabled={item.disabled}
              className={cn(
                'rounded-md bg-transparent px-2.5 py-1.5 text-left text-sm text-ink transition-colors hover:bg-hover disabled:opacity-45',
                item.value === menu.current && 'bg-hover font-medium',
              )}
              onClick={() => {
                setOpen(false);
                menu.onSelect(item.value);
              }}
            >
              {item.label}
            </button>
          ))}
          {menu.hint !== undefined && menu.hint !== '' && (
            <p className="px-2.5 py-1 text-2xs text-faint">{menu.hint}</p>
          )}
        </div>
      )}
    </span>
  );
}
