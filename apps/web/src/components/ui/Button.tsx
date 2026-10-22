import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'plain' | 'dangerGhost' | 'danger';
export type ButtonSize = 'normal' | 'small';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  plain: '',
  dangerGhost: 'btn-danger-ghost',
  danger: 'btn-danger',
};

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style' | 'type'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

export function Button({
  variant = 'plain',
  size = 'normal',
  className,
  children,
  ...props
}: ButtonProps) {
  const classes = ['btn', VARIANT_CLASS[variant], size === 'small' ? 'btn-small' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <button {...props} type="button" className={classes}>
      {children}
    </button>
  );
}
