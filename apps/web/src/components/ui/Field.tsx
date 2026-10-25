import {
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from './cn';

/** 与 legacy `.input` 同视觉：sunken 底 + inset 阴影 + focus ring。 */
const CONTROL_CLASS =
  'w-full min-w-0 rounded-sm bg-sunken px-2.75 py-2 text-md text-ink shadow-elev-inset transition-colors placeholder:text-faint focus:outline-none focus:shadow-focus pointer-coarse:min-h-touch disabled:cursor-not-allowed disabled:opacity-45';

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

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, className, 'aria-invalid': ariaInvalid, ...props },
  ref,
) {
  return (
    <select
      {...props}
      ref={ref}
      aria-invalid={invalid ? true : ariaInvalid}
      className={cn(CONTROL_CLASS, invalid && INVALID_CLASS, className)}
    />
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
