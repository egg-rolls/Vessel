import {
  type ButtonHTMLAttributes,
  Fragment,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  isValidElement,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

/** 输入控件：sunken 底 + inset 阴影 + focus ring。 */
const CONTROL_CLASS =
  'w-full min-w-0 rounded-sm border-0 bg-sunken px-2.75 py-2 text-md text-ink shadow-elev-inset transition-colors placeholder:text-faint focus:outline-none focus:shadow-focus pointer-coarse:min-h-touch disabled:cursor-not-allowed disabled:opacity-45 forced-colors:border';

const INVALID_CLASS = 'bg-danger-soft text-danger';

export interface FieldProps extends HTMLAttributes<HTMLDivElement> {
  label?: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
}

/** 表单字段：mono caps label + 控件 + hint / error。 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  className,
  children,
  ...props
}: FieldProps) {
  return (
    <div {...props} className={cn('flex min-w-0 flex-col gap-1.25', className)}>
      {label != null ? (
        <label
          htmlFor={htmlFor}
          className="font-mono text-2xs uppercase tracking-widest text-faint"
        >
          {label}
          {required ? (
            <span aria-hidden="true" className="text-danger">
              {' *'}
            </span>
          ) : null}
        </label>
      ) : null}
      {children}
      {hint != null ? <span className="text-xs text-faint wrap-anywhere">{hint}</span> : null}
      {error != null ? (
        <span role="alert" className="text-xs text-danger leading-snug">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, 'aria-invalid': ariaInvalid, ...props },
  ref,
) {
  return (
    <input
      {...props}
      ref={ref}
      aria-invalid={invalid ? true : ariaInvalid}
      className={cn(CONTROL_CLASS, invalid && INVALID_CLASS, className)}
    />
  );
});

/** 自定义 listbox 的选项：从 children 里的 `<option>` 解析。 */
export interface SelectOptionItem {
  key: string;
  value: string;
  label: ReactNode;
  text: string;
  disabled: boolean;
}

export interface SelectChangeEvent {
  target: { value: string; name?: string };
  currentTarget: { value: string; name?: string };
}

type OptionElementProps = {
  value?: string | number;
  disabled?: boolean;
  children?: ReactNode;
};

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return '';
}

/** 解析 `<option>` children；其他节点忽略（与原生 select 忽略非 option 内容一致）。 */
export function selectOptionsFromChildren(children: ReactNode): SelectOptionItem[] {
  const options: SelectOptionItem[] = [];

  const walk = (node: ReactNode) => {
    if (node == null || typeof node === 'boolean') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!isValidElement(node)) return;
    if (node.type === Fragment) {
      walk((node.props as { children?: ReactNode }).children);
      return;
    }
    if (node.type !== 'option') return;
    // isValidElement 的 props 是 unknown；option 的 props 形状由调用方保证。
    const props = node.props as OptionElementProps;
    const text = textOf(props.children).trim();
    const value = props.value != null ? String(props.value) : text;
    options.push({
      key: `${options.length}:${typeof node.key === 'string' ? node.key : value}`,
      value,
      label: props.children,
      text,
      disabled: Boolean(props.disabled),
    });
  };

  walk(children);
  return options;
}

/** 从 `from` 出发按方向找下一个可用项；全部 disabled 时返回 -1。 */
export function nextEnabledIndex(
  options: readonly SelectOptionItem[],
  from: number,
  delta: 1 | -1,
): number {
  if (options.length === 0) return -1;
  let index = from;
  for (let step = 0; step < options.length; step += 1) {
    index = (index + delta + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

/** 打开时的初始高亮：当前值 → 首个可用项。 */
export function initialEnabledIndex(options: readonly SelectOptionItem[], value: string): number {
  const selected = options.findIndex((option) => option.value === value);
  if (selected >= 0 && !options[selected]?.disabled) return selected;
  return nextEnabledIndex(options, -1, 1);
}

export interface SelectProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    | 'children'
    | 'defaultValue'
    | 'type'
    | 'value'
    | 'onChange'
    | 'onClick'
    | 'onKeyDown'
    | 'onFocus'
    | 'onBlur'
    | 'role'
  > {
  invalid?: boolean;
  required?: boolean;
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (event: SelectChangeEvent) => void;
  children?: ReactNode;
}

/** SSR 下没有 DOM，避免 useLayoutEffect 警告。 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

interface ListboxPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/**
 * 选择器：button 触发器 + portal 到 body 的自定义 listbox。
 *
 * 原生 `<select>` 的弹层由系统渲染，无法给 `<option>` 上 Linen 颜色；这里用
 * combobox + aria-activedescendant 模式，焦点始终留在触发器上，弹层不被 Modal
 * 的 overflow 裁剪。value / onChange / `<option>` children 的调用方式保持不变。
 */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    invalid,
    className,
    'aria-invalid': ariaInvalid,
    'aria-label': ariaLabel,
    children,
    value,
    defaultValue,
    onChange,
    disabled,
    required,
    id,
    name,
    ...props
  },
  ref,
) {
  const options = selectOptionsFromChildren(children);
  const [uncontrolled, setUncontrolled] = useState(() =>
    defaultValue != null ? String(defaultValue) : '',
  );
  const current = value !== undefined ? String(value) : uncontrolled;
  const selected = options.find((option) => option.value === current);

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<ListboxPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  useImperativeHandle(ref, () => triggerRef.current as HTMLButtonElement, []);

  const closeList = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setActiveIndex(-1);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const selectOption = (option: SelectOptionItem) => {
    if (option.disabled) return;
    if (value === undefined) setUncontrolled(option.value);
    setOpen(false);
    setActiveIndex(-1);
    triggerRef.current?.focus();
    if (option.value !== current) {
      onChange?.({
        target: { value: option.value, name },
        currentTarget: { value: option.value, name },
      });
    }
  };

  useIsomorphicLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const reposition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const width = Math.min(rect.width, viewportWidth - 16);
      const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
      const desired = Math.min(240, options.length * 34 + 8);
      const below = viewportHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const placeAbove = below < desired && above > below;
      const maxHeight = Math.max(96, Math.min(240, placeAbove ? above : below));
      const top = placeAbove ? Math.max(8, rect.top - 4 - maxHeight) : rect.bottom + 4;
      setPosition({ top, left, width, maxHeight });
    };
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      closeList(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, closeList]);

  const openList = () => {
    if (disabled || options.length === 0) return;
    setActiveIndex(initialEnabledIndex(options, current));
    setOpen(true);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const key = event.key;

    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        openList();
      }
      return;
    }

    if (key === 'Escape') {
      event.preventDefault();
      // Esc 先只关 listbox；阻止同时打开的 Modal 跟着关闭。
      event.stopPropagation();
      closeList(true);
      return;
    }
    if (key === 'Tab') {
      closeList(false);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) selectOption(option);
      else closeList(true);
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) =>
        nextEnabledIndex(options, index < 0 ? -1 : index, key === 'ArrowDown' ? 1 : -1),
      );
      return;
    }
    if (key === 'Home') {
      event.preventDefault();
      setActiveIndex(nextEnabledIndex(options, -1, 1));
      return;
    }
    if (key === 'End') {
      event.preventDefault();
      setActiveIndex(nextEnabledIndex(options, 0, -1));
    }
  };

  return (
    <>
      <button
        {...props}
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-invalid={invalid ? true : ariaInvalid}
        aria-required={required || undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        className={cn(
          CONTROL_CLASS,
          'flex items-center justify-between gap-2 text-left',
          invalid && INVALID_CLASS,
          className,
        )}
        onClick={() => {
          if (open) closeList(true);
          else openList();
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="truncate">{selected ? selected.label : null}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className={cn('size-3 flex-none text-faint transition-transform', open && 'rotate-180')}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" />
        </svg>
      </button>
      {open && position !== null
        ? createPortal(
            <div
              ref={popupRef}
              id={listboxId}
              role="listbox"
              aria-labelledby={id}
              aria-label={id == null ? ariaLabel : undefined}
              tabIndex={-1}
              className="fixed z-tooltip flex flex-col overflow-y-auto overscroll-contain rounded-md border border-line bg-raised p-1 shadow-elev-3"
              style={{
                top: position.top,
                left: position.left,
                width: position.width,
                maxHeight: position.maxHeight,
              }}
            >
              {options.map((option, index) => {
                const isSelected = option.value === current;
                return (
                  // biome-ignore lint/a11y/useFocusableInteractive: aria-activedescendant 模式下选项不接收焦点
                  // biome-ignore lint/a11y/useKeyWithClickEvents: 键盘交互在触发器上（combobox 模式）
                  <div
                    key={option.key}
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    className={cn(
                      'flex min-h-8 cursor-pointer items-center rounded-sm px-2.5 py-1.75 text-left text-md text-ink transition-colors pointer-coarse:min-h-touch',
                      index === activeIndex && 'bg-hover',
                      isSelected && 'bg-accent-soft text-accent-ink',
                      option.disabled && 'cursor-not-allowed opacity-45',
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerEnter={() => {
                      if (!option.disabled) setActiveIndex(index);
                    }}
                    onClick={() => selectOption(option)}
                  >
                    <span className="truncate">{option.label}</span>
                  </div>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className, 'aria-invalid': ariaInvalid, ...props },
  ref,
) {
  return (
    <textarea
      {...props}
      ref={ref}
      aria-invalid={invalid ? true : ariaInvalid}
      className={cn(CONTROL_CLASS, invalid && INVALID_CLASS, className)}
    />
  );
});
