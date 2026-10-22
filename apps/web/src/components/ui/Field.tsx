import { type ReactNode, useId } from 'react';

export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

export interface FieldProps {
  label: ReactNode;
  description?: ReactNode;
  error?: string;
  children: (props: FieldControlProps) => ReactNode;
}

export function Field({ label, description, error, children }: FieldProps) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy =
    [description ? descriptionId : null, error ? errorId : null].filter(Boolean).join(' ') ||
    undefined;

  return (
    <div className="ui-field">
      <label className="ui-field-label" htmlFor={id}>
        {label}
      </label>
      {description ? (
        <span className="ui-field-desc" id={descriptionId}>
          {description}
        </span>
      ) : null}
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })}
      {error ? (
        <span className="ui-field-error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
