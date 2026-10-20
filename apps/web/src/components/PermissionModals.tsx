import { useState } from 'react';
import type { AskUserAnswer, AskUserRequest } from '../gateway/types';
import { t } from '../i18n';
import { ModalShell } from './Modal';

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

/** ask_user：选项 + 自定义文本；空回答不可提交。 */
export function AskModal({
  request,
  pendingCount,
  now,
  busy = false,
  onSubmit,
  onCancel,
}: {
  request: AskUserRequest;
  pendingCount: number;
  now: number;
  /** 应答提交中：禁用按钮，防止双击重复应答。 */
  busy?: boolean;
  onSubmit: (answers: AskUserAnswer[]) => void;
  onCancel: () => void;
}) {
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => ''));
  const [selected, setSelected] = useState<string[][]>(() => request.questions.map(() => []));
  const remaining = Math.max(0, Math.ceil((request.expiresAt - now) / 1000));

  const toggle = (index: number, option: string, multi: boolean) => {
    setSelected((prev) => {
      const next = prev.map((item) => [...item]);
      if (!multi) {
        next[index] = [option];
        return next;
      }
      const set = new Set(next[index] ?? []);
      if (set.has(option)) set.delete(option);
      else set.add(option);
      next[index] = [...set];
      return next;
    });
  };

  const answers: AskUserAnswer[] = request.questions.map((question, index) => {
    const text = (custom[index] ?? '').trim();
    const picked = selected[index] ?? [];
    return {
      header: question.header,
      question: question.question,
      answer: [...picked, ...(text ? [text] : [])].join(' · '),
    };
  });
  const complete = answers.every((answer) => answer.answer.length > 0);

  return (
    <ModalShell
      label="Agent 提问"
      describedBy={`ask-summary-${request.requestId}`}
      onClose={onCancel}
      closeOnBackdrop={false}
      className="permission-modal"
    >
      <h2 className="modal-title">Agent 提问</h2>
      <div className="permission-meta dim" id={`ask-summary-${request.requestId}`}>
        run {truncate(request.runId, 16)} · 剩余 {remaining}s
        {pendingCount > 1 ? ` · 还有 ${pendingCount - 1} 个待处理` : ''}
      </div>
      <div className="ask-list">
        {request.questions.map((question, index) => (
          <div
            className="ask-question"
            key={`${request.requestId}-${question.header}-${question.question}`}
          >
            <div className="ask-header">{question.header}</div>
            <div className="ask-text">{question.question}</div>
            {question.options && question.options.length > 0 && (
              <div className="ask-options">
                {question.options.map((option) => {
                  const picked = (selected[index] ?? []).includes(option);
                  return (
                    <label className={`ask-option ${picked ? 'picked' : ''}`.trim()} key={option}>
                      <input
                        type={question.multi_select ? 'checkbox' : 'radio'}
                        name={`ask-${request.requestId}-${index}`}
                        checked={picked}
                        onChange={() => toggle(index, option, question.multi_select === true)}
                      />
                      <span>{option}</span>
                    </label>
                  );
                })}
              </div>
            )}
            <input
              className="input"
              value={custom[index] ?? ''}
              onChange={(event) =>
                setCustom((prev) => {
                  const next = [...prev];
                  next[index] = event.target.value;
                  return next;
                })
              }
              placeholder={question.options ? '或输入自定义回答' : '输入回答'}
            />
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-danger-ghost" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!complete || busy}
          onClick={() => onSubmit(answers)}
        >
          {busy ? t('permission.busy') : '提交'}
        </button>
      </div>
    </ModalShell>
  );
}
