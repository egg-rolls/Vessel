import { type ReactNode, useId } from 'react';
import { t } from '../i18n';
import { ModalShell } from './Modal';

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
      className="confirm-dialog"
    >
      <h2 className="modal-title">{title}</h2>
      <div id={bodyId} className="modal-body">
        {body}
      </div>
      {extra}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy} data-autofocus>
          {resolvedCancel}
        </button>
        <button
          type="button"
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          onClick={onConfirm}
          disabled={busy || confirmDisabled}
        >
          {busy ? t('common.processing') : resolvedConfirm}
        </button>
      </div>
    </ModalShell>
  );
}
