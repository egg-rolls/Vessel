import { cva } from 'class-variance-authority';
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';
import { cn } from './cn';

/**
 * 按钮变体名：**运行时数组 = 唯一事实源**。
 *
 * 类型由数组派生（`ButtonVariant`），设计实验室 / 文档 / 示例直接 `map` 这个数组，
 * 不再各自手抄一份清单。加一种变体 = 往这里加一个值 + 给下面的
 * `BUTTON_VARIANT_CLASS` 加同名键；只加一边编译器会立刻报错（见该常量的 `satisfies`）。
 */
export const BUTTON_VARIANTS = [
  'plain',
  'primary',
  'danger',
  'dangerGhost',
  'link',
  'chip',
] as const;

export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];

/** 按钮尺寸名（运行时数组，规则同上）。 */
export const BUTTON_SIZES = ['normal', 'small'] as const;

export type ButtonSize = (typeof BUTTON_SIZES)[number];

/**
 * 变体 → class。`satisfies Record<ButtonVariant, string>` 把「运行时数组」与
 * 「cva 的 `variant` 键集合」**双向钉住**：
 *
 * - 数组里有、这里漏写 → 缺属性报错（`Property 'x' is missing …`）；
 * - 这里写了、数组里没有（往 cva 加了键却忘了进数组）→ 对象字面量多余属性报错
 *   （`Object literal may only specify known properties …`）。
 *
 * 两个方向都是编译错误，所以变体清单不可能静默漂移。
 */
const BUTTON_VARIANT_CLASS = {
  plain: 'bg-sunken text-ink tint-hover tint-press',
  primary: 'bg-accent text-surface hover:bg-accent-ink active:bg-accent-ink',
  danger: 'bg-danger text-surface tint-hover tint-press',
  dangerGhost: 'bg-transparent text-danger hover:bg-danger-soft',
  link: 'bg-transparent p-0 text-accent underline underline-offset-2 hover:text-accent-ink',
  chip: 'rounded-full bg-transparent text-muted hover:bg-hover hover:text-ink aria-pressed:bg-accent-soft aria-pressed:text-accent-ink',
} satisfies Record<ButtonVariant, string>;

/** 尺寸 → class（同样的 `satisfies` 守卫，钉住 `BUTTON_SIZES`）。 */
const BUTTON_SIZE_CLASS = {
  // 默认内边距在 base：`link` / `chip` variant 可以整体覆盖。
  normal: '',
  small: 'px-2.5 py-1 text-xs',
} satisfies Record<ButtonSize, string>;

const button = cva(
  // L2 基础：形状、排版、focus、触控目标与 disabled 只在这里定义一次。
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-3 py-2 text-sm tracking-wide transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface pointer-coarse:min-h-touch forced-colors:border disabled:opacity-45 disabled:cursor-not-allowed',
  {
    variants: {
      variant: BUTTON_VARIANT_CLASS,
      size: BUTTON_SIZE_CLASS,
    },
    defaultVariants: { variant: 'plain', size: 'normal' },
  },
);

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style' | 'type'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: 'button' | 'submit' | 'reset';
  children?: ReactNode;
}

/** 暴露 ref：Tooltip 通过 cloneElement 挂在触发元素上并读取锚点位置。 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, type = 'button', className, children, ...props },
  ref,
) {
  return (
    <button {...props} ref={ref} type={type} className={cn(button({ variant, size }), className)}>
      {children}
    </button>
  );
});
