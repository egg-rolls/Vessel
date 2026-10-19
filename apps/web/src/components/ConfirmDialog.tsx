import { type ReactNode, useId } from 'react';
import { ModalShell } from './Modal';

/** 破坏性动作确认：初始焦点在「取消」，Enter 不会误触发危险动作。 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = '确认',
  cancelLabel = '取消',
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
  return (
    <ModalShell
      label={title}
      describedBy={bodyId}
      onClose={onCancel}
      closeOnBackdrop={!busy}
      className="confirm-dialog"
    >
      <h2 className="modal-title">{title}</h2>
      <div id={bodyId} className="modal-body">
        {body}
      </div>
      {extra}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy} data-autofocus>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          onClick={onConfirm}
          disabled={busy || confirmDisabled}
        >
          {busy ? '处理中…' : confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}
