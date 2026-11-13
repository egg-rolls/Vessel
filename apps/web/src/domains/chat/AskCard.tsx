import { Badge, Button, cn, Input } from '../../components/ui';
import { askQuestionSettled } from '../../gateway/ask-answers';
import type { AskUserAnswer, AskUserRequest } from '../../gateway/types';
import { t } from '../../i18n';
import { useAskDrafts, useSetAskDraft } from '../pending/ask-draft-store';
import { askPendingAnswers, askPlanRows, askRowsComplete } from '../pending/ask-submit-plan';

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

/** 单题草稿：已选选项 + 自定义文本（草稿的持久化在 `domains/pending/ask-drafts.ts`）。 */
export interface AskDraft {
  readonly selected: readonly string[];
  readonly custom: string;
}

function isAnswered(draft: AskDraft): boolean {
  return draft.selected.length > 0 || draft.custom.trim().length > 0;
}

/**
 * ask 卡片：由 AskPrompt 渲染在 Composer 槽位（替换输入框）。
 *
 * - 提交中禁用全部按钮，防止双击；
 * - 其他端应答 / run 终态由 ConnectionProvider 移除请求，卡片随之收起；
 * - 0.18 起提问没有自动超时（不再显示倒计时），提交按钮常驻；
 * - 提交走现有 `ask.respond`，不新增 RPC；
 * - 0.51：草稿按 `requestId + 题号` 走 `ask-draft-store`（团队待处理条也用这张卡），
 *   切页 / 刷新回来勾选与自定义答复都还在 —— 与 Composer 槽位 / 待批页同一份草稿。
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
  const drafts = useAskDrafts();
  const setDraft = useSetAskDraft();
  const titleId = `ask-card-${request.requestId}`;

  const toggle = (index: number, option: string, multi: boolean) => {
    setDraft(request.requestId, index, (draft) => {
      if (!multi) return { ...draft, selected: [option] };
      const picked = new Set(draft.selected);
      if (picked.has(option)) picked.delete(option);
      else picked.add(option);
      return { ...draft, selected: [...picked] };
    });
  };

  // 逐题规划交给 ask-submit-plan（同一份判定待批页 / Composer 也用）：已落定的题不再
  // 进载荷 —— 分批提交时它会带着第一批的答案再发一遍，而只要那一行缺 question_id，
  // 服务端就只能把它当成一条独立的新答案写进记录。
  const rows = askPlanRows([request], drafts);
  const answers: AskUserAnswer[] = askPendingAnswers(rows);
  const complete = answers.length > 0 && askRowsComplete(rows);

  return (
    <fieldset className="ask-card" aria-labelledby={titleId} data-request-id={request.requestId}>
      <div className="ask-card-head" id={titleId}>
        <span className="ask-card-title">{t('ask.title')}</span>
        <span className="ask-card-meta font-mono text-muted tabular-nums">
          run {truncate(request.runId, 16)}
        </span>
        {request.mode === 'async' && (
          <span className="ask-card-meta font-mono text-2xs text-accent">
            {t('ask.asyncBadge')}
          </span>
        )}
        {pendingCount > 1 && (
          <span className="text-muted">{t('ask.pendingMore', { count: pendingCount - 1 })}</span>
        )}
      </div>

      <div className="ask-list flex flex-col gap-3 pr-1">
        {rows.map((row) => (
          <div
            className={cn(
              'flex flex-col gap-2 rounded-md bg-sunken p-3.5',
              row.settled && 'opacity-70',
            )}
            key={`${request.requestId}-${row.question.header}-${row.question.question}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-mono text-2xs font-semibold uppercase tracking-widest text-accent-ink">
                {row.question.header}
              </div>
              {row.settled && <Badge tone="neutral">{t('pending.item.answered')}</Badge>}
            </div>
            <div className="leading-relaxed whitespace-pre-wrap wrap-anywhere">
              {row.question.question}
            </div>
            {row.question.options && row.question.options.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {row.question.options.map((option) => {
                  const picked = row.draft.selected.includes(option);
                  return (
                    <label
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-md pointer-coarse:min-h-touch ${
                        picked
                          ? 'bg-accent-soft text-accent-ink'
                          : 'bg-raised text-ink hover:bg-hover'
                      }`}
                      key={option}
                    >
                      <input
                        className="accent-accent"
                        type={row.question.multi_select ? 'checkbox' : 'radio'}
                        name={`ask-${request.requestId}-${row.index}`}
                        checked={picked}
                        disabled={busy || row.settled}
                        onChange={() =>
                          toggle(row.index, option, row.question.multi_select === true)
                        }
                      />
                      <span>{option}</span>
                    </label>
                  );
                })}
              </div>
            )}
            <Input
              value={row.draft.custom}
              disabled={busy || row.settled}
              onChange={(event) => {
                const value = event.target.value;
                setDraft(request.requestId, row.index, (draft) => ({ ...draft, custom: value }));
              }}
              placeholder={
                row.question.options
                  ? t('ask.customPlaceholder.options')
                  : t('ask.customPlaceholder.open')
              }
            />
          </div>
        ))}
      </div>

      <div className="ask-card-actions mt-2 flex justify-end gap-2">
        <Button variant="dangerGhost" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={!complete || busy} onClick={() => onSubmit(answers)}>
          {busy ? t('permission.busy') : t('ask.submit')}
        </Button>
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
  // 已落定的题（分批提交时上一批答过的）由服务端逐题进度判定：标「已答」并锁住输入，
  // 别让它看起来还能改 —— 用户顺手再答一遍，提交载荷里就多一条只能靠服务端挡回来的行。
  const settled =
    question !== undefined &&
    askQuestionSettled(request.answeredQuestionIds, question, questionIndex);
  const disabled = busy || !connected || settled;
  // 已落定的题算答完：草稿在提交后就被清掉了，若还按草稿判「未答」，用户会卡在
  // 这道已经答过的题上翻不过去。
  const answered = settled || (question ? isAnswered({ selected: [...selected], custom }) : true);

  return (
    <fieldset
      className="ask-card ask-card-single"
      aria-labelledby={titleId}
      data-request-id={request.requestId}
    >
      <div className="ask-card-head" id={titleId}>
        <span className="ask-card-title">{t('ask.title')}</span>
        <span className="ask-card-meta font-mono text-muted tabular-nums">
          run {truncate(request.runId, 16)}
        </span>
        {question && (
          <span className="ask-card-meta text-muted tabular-nums">
            {t('ask.progress', {
              current: questionIndex + 1,
              total: request.questions.length,
            })}
          </span>
        )}
        {settled && <Badge tone="neutral">{t('pending.item.answered')}</Badge>}
      </div>

      {question && (
        <div className="ask-list flex flex-col gap-3 pr-1">
          <div
            className="flex flex-col gap-2 rounded-md bg-sunken p-3.5"
            key={`${request.requestId}-${questionIndex}`}
          >
            <div className="font-mono text-2xs font-semibold uppercase tracking-widest text-accent-ink">
              {question.header}
            </div>
            <div className="leading-relaxed whitespace-pre-wrap wrap-anywhere">
              {question.question}
            </div>
            {question.options && question.options.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {question.options.map((option) => {
                  const picked = selected.includes(option);
                  return (
                    <label
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-md pointer-coarse:min-h-touch ${
                        picked
                          ? 'bg-accent-soft text-accent-ink'
                          : 'bg-raised text-ink hover:bg-hover'
                      }`}
                      key={option}
                    >
                      <input
                        className="accent-accent"
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
            <Input
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
        <p className="mt-2 text-sm text-muted" role="status">
          {t('ask.answerRequired')}
        </p>
      )}

      <div className="ask-card-actions mt-2 flex justify-end gap-2">
        <Button variant="dangerGhost" disabled={disabled} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        {onPrev && (
          <Button disabled={disabled} onClick={onPrev}>
            {t('ask.previous')}
          </Button>
        )}
        <Button variant="primary" disabled={!canAdvance || disabled} onClick={onNext}>
          {busy ? t('permission.busy') : isLast ? t('ask.submit') : t('ask.next')}
        </Button>
      </div>
    </fieldset>
  );
}
