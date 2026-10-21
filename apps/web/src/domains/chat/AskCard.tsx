import { useState } from 'react';
import type { AskUserAnswer, AskUserRequest } from '../../gateway/types';
import { t } from '../../i18n';

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

/**
 * ask_user 卡片：由 AskPrompt 渲染在 Composer 槽位（替换输入框）。
 *
 * - 提交中禁用全部按钮，防止双击；
 * - 其他端应答 / run 终态由 ConnectionProvider 移除请求，卡片随之收起；
 * - 0.18 起提问没有自动超时（不再显示倒计时），提交按钮常驻；
 * - 提交走现有 `ask.respond`，不新增 RPC。
 */
export function AskCard({
  request,
  pendingCount = 1,
  busy = false,
  onSubmit,
  onCancel,
}: {
  request: AskUserRequest;
  pendingCount?: number;
  /** 保留以兼容调用方；提问已不再倒计时 / 过期。 */
  now?: number;
  busy?: boolean;
  onSubmit: (answers: AskUserAnswer[]) => void;
  onCancel: () => void;
}) {
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => ''));
  const [selected, setSelected] = useState<string[][]>(() => request.questions.map(() => []));
  const titleId = `ask-card-${request.requestId}`;

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
    <fieldset className="ask-card" aria-labelledby={titleId} data-request-id={request.requestId}>
      <div className="ask-card-head" id={titleId}>
        <span className="ask-card-title">{t('ask.title')}</span>
        <span className="ask-card-meta dim mono">run {truncate(request.runId, 16)}</span>
        {pendingCount > 1 && (
          <span className="dim">{t('ask.pendingMore', { count: pendingCount - 1 })}</span>
        )}
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
                        disabled={busy}
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
              disabled={busy}
              onChange={(event) =>
                setCustom((prev) => {
                  const next = [...prev];
                  next[index] = event.target.value;
                  return next;
                })
              }
              placeholder={
                question.options
                  ? t('ask.customPlaceholder.options')
                  : t('ask.customPlaceholder.open')
              }
            />
          </div>
        ))}
      </div>

      <div className="ask-card-actions">
        <button type="button" className="btn btn-danger-ghost" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!complete || busy}
          onClick={() => onSubmit(answers)}
        >
          {busy ? t('permission.busy') : t('ask.submit')}
        </button>
      </div>
    </fieldset>
  );
}
