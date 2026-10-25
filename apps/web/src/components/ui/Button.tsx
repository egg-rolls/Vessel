import { cva, type VariantProps } from 'class-variance-authority';
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';
import { cn } from './cn';

const button = cva(
  // L2 基础：形状、排版、focus、触控目标与 disabled 只在这里定义一次。
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-3 py-2 text-sm tracking-wide transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface pointer-coarse:min-h-touch forced-colors:border disabled:opacity-45 disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        plain: 'bg-sunken text-ink tint-hover tint-press',
        primary: 'bg-accent text-surface hover:bg-accent-ink active:bg-accent-ink',
        danger: 'bg-danger text-surface tint-hover tint-press',
        dangerGhost: 'bg-transparent text-danger hover:bg-danger-soft',
        link: 'bg-transparent p-0 text-accent underline underline-offset-2 hover:text-accent-ink',
        chip: 'rounded-full bg-transparent text-muted hover:bg-hover hover:text-ink aria-pressed:bg-accent-soft aria-pressed:text-accent-ink',
      },
      size: {
        // 默认内边距在 base：`link` / `chip` variant 可以整体覆盖。
        normal: '',
        small: 'px-2.5 py-1 text-xs',
      },
    },
    defaultVariants: { variant: 'plain', size: 'normal' },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof button>['variant']>;
export type ButtonSize = NonNullable<VariantProps<typeof button>['size']>;

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
