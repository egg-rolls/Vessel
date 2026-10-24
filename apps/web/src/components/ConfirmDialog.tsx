import { type ReactNode, useId } from 'react';
import { t } from '../i18n';
import { ModalShell } from './Modal';
import { Button } from './ui';

/** 破坏性动作确认：初始焦点在「取消」，Enter 不会误触发危险动作。 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
  extra,
}: {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** 前置条件不满足（例如仍有活动 run）时禁用主按钮。 */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  extra?: ReactNode;
}) {
  const bodyId = useId();
  const resolvedConfirm = confirmLabel ?? t('common.confirm');
  const resolvedCancel = cancelLabel ?? t('common.cancel');
  return (
    <ModalShell
      label={title}
      describedBy={bodyId}
      onClose={onCancel}
      closeOnBackdrop={!busy}
      size="sm"
    >
      <h2 className="font-serif text-xl font-semibold leading-tight text-ink">{title}</h2>
      <div id={bodyId} className="flex flex-col gap-3 text-md leading-relaxed text-muted">
        {body}
      </div>
      {extra}
      <div className="mt-1 flex flex-wrap justify-end gap-3">
        <Button onClick={onCancel} disabled={busy} data-autofocus>
          {resolvedCancel}
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          onClick={onConfirm}
          disabled={busy || confirmDisabled}
        >
          {busy ? t('common.processing') : resolvedConfirm}
        </Button>
      </div>
    </ModalShell>
  );
}
