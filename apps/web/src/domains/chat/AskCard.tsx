import { useState } from 'react';
import type { AskUserAnswer, AskUserQuestion, AskUserRequest } from '../../gateway/types';
import { t } from '../../i18n';

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

/** 单题草稿：已选选项 + 自定义文本。 */
export interface AskDraft {
  selected: string[];
  custom: string;
}

/** 单题答案：已选选项 + 自定义文本用 ` · ` 连接（两组件共用，避免逻辑漂移）。 */
export function buildAnswer(question: AskUserQuestion, draft: AskDraft): AskUserAnswer {
  const text = draft.custom.trim();
  return {
    header: question.header,
    question: question.question,
    answer: [...draft.selected, ...(text ? [text] : [])].join(' · '),
  };
}

function isAnswered(draft: AskDraft): boolean {
  return draft.selected.length > 0 || draft.custom.trim().length > 0;
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

  const answers: AskUserAnswer[] = request.questions.map((question, index) =>
    buildAnswer(question, {
      selected: selected[index] ?? [],
      custom: custom[index] ?? '',
    }),
  );
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

/**
 * 单题 ask 卡（0.18 S2）：同一 ask 的多个问题逐题渲染，草稿由 `AskPrompt` 持有。
 *
 * - 只渲染 `questionIndex` 指向的一题，父级用 key 保证切换问题时状态重置；
 * - `isLast` 时主按钮为“提交”，否则为“下一题”；
 * - 断线 / 提交中禁用全部动作；未答时显示提示并禁用主按钮。
 */
export function AskQuestionCard({
  request,
  questionIndex,
  selected,
  custom,
  busy = false,
  connected = true,
  canAdvance,
  isLast,
  onToggle,
  onCustom,
  onPrev,
  onNext,
  onCancel,
}: {
  request: AskUserRequest;
  questionIndex: number;
  selected: readonly string[];
  custom: string;
  busy?: boolean;
  connected?: boolean;
  canAdvance: boolean;
  isLast: boolean;
  onToggle: (option: string) => void;
  onCustom: (value: string) => void;
  onPrev?: () => void;
  onNext: () => void;
  onCancel: () => void;
}) {
  const titleId = `ask-card-${request.requestId}-${questionIndex}`;
  const question = request.questions[questionIndex];
  const disabled = busy || !connected;
  const answered = question ? isAnswered({ selected: [...selected], custom }) : true;

  return (
    <fieldset
      className="ask-card ask-card-single"
      aria-labelledby={titleId}
      data-request-id={request.requestId}
    >
      <div className="ask-card-head" id={titleId}>
        <span className="ask-card-title">{t('ask.title')}</span>
        <span className="ask-card-meta dim mono">run {truncate(request.runId, 16)}</span>
        {request.questions.length > 0 && (
          <span className="ask-card-meta dim">
            {t('ask.progress', {
              current: questionIndex + 1,
              total: request.questions.length,
            })}
          </span>
        )}
      </div>

      {question && (
        <div className="ask-list">
          <div className="ask-question" key={`${request.requestId}-${questionIndex}`}>
            <div className="ask-header">{question.header}</div>
            <div className="ask-text">{question.question}</div>
            {question.options && question.options.length > 0 && (
              <div className="ask-options">
                {question.options.map((option) => {
                  const picked = selected.includes(option);
                  return (
                    <label className={`ask-option ${picked ? 'picked' : ''}`.trim()} key={option}>
                      <input
                        type={question.multi_select ? 'checkbox' : 'radio'}
                        name={`${request.requestId}-${questionIndex}`}
                        checked={picked}
                        disabled={disabled}
                        onChange={() => onToggle(option)}
                      />
                      <span>{option}</span>
                    </label>
                  );
                })}
              </div>
            )}
            <input
              className="input"
              value={custom}
              disabled={disabled}
              onChange={(event) => onCustom(event.target.value)}
              placeholder={
                question.options
                  ? t('ask.customPlaceholder.options')
                  : t('ask.customPlaceholder.open')
              }
              aria-label={`${question.header}: ${question.question}`}
            />
          </div>
        </div>
      )}

      {!answered && (
        <p className="dim ask-answer-required" role="status">
          {t('ask.answerRequired')}
        </p>
      )}

      <div className="ask-card-actions">
        <button
          type="button"
          className="btn btn-danger-ghost"
          disabled={disabled}
          onClick={onCancel}
        >
          {t('common.cancel')}
        </button>
        {onPrev && (
          <button type="button" className="btn" disabled={disabled} onClick={onPrev}>
            {t('ask.previous')}
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canAdvance || disabled}
          onClick={onNext}
        >
          {busy ? t('permission.busy') : isLast ? t('ask.submit') : t('ask.next')}
        </button>
      </div>
    </fieldset>
  );
}
