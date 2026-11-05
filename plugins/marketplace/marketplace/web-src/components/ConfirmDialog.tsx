import { Button } from '@vessel-agent/plugin-ui';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

/**
 * Destructive / security-sensitive confirmation. Not part of plugin-ui v1
 * (Modal depends on host positioning), so the plugin owns the shell but uses
 * only token-backed utilities (`bg-scrim`, `z-modal`, `shadow-elev-4`).
 *
 * Confirming always requires the explicit checkbox, matching the trust rule:
 * an install must disclose package permissions before it can proceed.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  confirmText,
  cancelLabel,
  danger = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  confirmText: string;
  cancelLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const checkboxRef = useRef<HTMLInputElement | null>(null);
  const checkboxId = useId();

  useEffect(() => {
    if (!open) return;
    setChecked(false);
    const focusTimer = setTimeout(() => checkboxRef.current?.focus(), 0);
    return () => clearTimeout(focusTimer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center overflow-y-auto bg-scrim p-4">
      {/* Backdrop: pointer path only; Escape is the keyboard path. */}
      <button
        type="button"
        aria-label={cancelLabel}
        tabIndex={-1}
        className="absolute inset-0 h-full w-full cursor-default bg-transparent"
        onClick={onCancel}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-modal-md rounded-lg bg-raised p-5 shadow-elev-4"
      >
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        <div className="mt-3">{children}</div>
        <label
          htmlFor={checkboxId}
          className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-ink"
        >
          <input
            ref={checkboxRef}
            id={checkboxId}
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
            className="mt-0.5 size-4 flex-none accent-accent"
          />
          <span>{confirmText}</span>
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={!checked} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
