import { type ReactNode, useEffect, useRef, useState } from 'react';
import type {
  AskUserAnswer,
  AskUserRequest,
  PermissionRequest,
  PermissionScope,
} from '../../gateway/types';
import { t } from '../../i18n';
import { type AskDraft, AskQuestionCard, buildAnswer } from './AskCard';
import { PermissionCard } from './PermissionCard';

/** 队列摘要 chip：由 ChatView 从 `pendingQueue` 生成。 */
export interface PromptQueueChip {
  key: string;
  label: string;
}

function emptyDraft(): AskDraft {
  return { selected: [], custom: '' };
}

/**
 * Composer 槽位的三个互斥状态（0.18）：Composer / PermissionPrompt / AskPrompt。
 *
 * 权限与 ask_user 都会阻塞对话，所以 pending 期间用同尺寸提示卡替换输入框；
 * 多个 pending 由 `pendingQueue` 排序，槽位只渲染第一项，其余作为队列摘要。
 * 卡出现（或 ask 切题）时焦点移到卡容器；读屏播报用预先存在的 sr-only region。
 */
function PromptShell({
  label,
  more,
  focusKey,
  onStop,
  stopping = false,
  connected = true,
  queue,
  children,
}: {
  label: string;
  /** 除当前这条外还剩多少条待处理（含同一 ask 的剩余问题）。 */
  more: number;
  /** 变化时把焦点移到卡容器（新请求 / ask 切题）。 */
  focusKey?: string;
  /** 卡头的停止 run 入口（与 Composer 的 stop 同一回调）。 */
  onStop?: () => void;
  stopping?: boolean;
  /** 断线时在卡上方提示并禁用卡内动作。 */
  connected?: boolean;
  /** 队列摘要：最多渲染 3 个 chip。 */
  queue?: readonly PromptQueueChip[];
  children: ReactNode;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusKey 变化时重新聚焦卡容器
  useEffect(() => {
    sectionRef.current?.focus();
  }, [focusKey]);

  return (
    <footer className="composer-area prompt-area">
      <section
        ref={sectionRef}
        tabIndex={-1}
        className="prompt-slot"
        aria-label={t('chat.prompt.label')}
      >
        <div className="prompt-slot-head">
          <span className="prompt-slot-kind">{label}</span>
          {more > 0 && <span className="dim">{t('chat.prompt.more', { count: more })}</span>}
          <span className="dim prompt-slot-hint">{t('chat.prompt.blocking')}</span>
          {onStop && (
            <button
              type="button"
              className="link-btn prompt-slot-stop"
              onClick={onStop}
              disabled={stopping}
            >
              {stopping ? t('chat.run.stopping') : t('chat.run.stop')}
            </button>
          )}
          {queue && queue.length > 0 && (
            <div className="prompt-queue">
              {queue.slice(0, 3).map((item) => (
                <span className="prompt-queue-chip" key={item.key}>
                  {item.label}
                </span>
              ))}
            </div>
          )}
          <span className="sr-only" aria-live="polite">
            {label}
            {more > 0 ? ` ${t('chat.prompt.more', { count: more })}` : ''}
          </span>
        </div>
        {connected === false && (
          <p className="prompt-slot-hint err" role="status">
            {t('chat.prompt.disconnected')}
          </p>
        )}
        {children}
      </section>
    </footer>
  );
}

/** 权限请求：替换输入框，保留允许（once/session/always）与拒绝。 */
export function PermissionPrompt({
  request,
  more = 0,
  busy = false,
  connected = true,
  onStop,
  stopping = false,
  queue,
  onDecide,
}: {
  request: PermissionRequest;
  more?: number;
  busy?: boolean;
  connected?: boolean;
  onStop?: () => void;
  stopping?: boolean;
  queue?: readonly PromptQueueChip[];
  onDecide: (decision: 'allow' | 'deny', scope: PermissionScope) => void;
}) {
  return (
    <PromptShell
      label={t('chat.prompt.permission')}
      more={more}
      focusKey={request.requestId}
      onStop={onStop}
      stopping={stopping}
      connected={connected}
      queue={queue}
    >
      <PermissionCard request={request} busy={busy} connected={connected} onDecide={onDecide} />
    </PromptShell>
  );
}

/**
 * ask_user：替换输入框（0.18 S2/S3）。
 *
 * 同一 request 的多题拆成多张单卡：只渲染当前 `questionIndex`，草稿本地累计；
 * “下一题”推进，“上一题”回看；最后一题所有答案非空时才调用一次 `onSubmit(answers)`。
 */
export function AskPrompt({
  request,
  otherPending = 0,
  busy = false,
  connected = true,
  onStop,
  stopping = false,
  queue,
  onSubmit,
  onCancel,
}: {
  request: AskUserRequest;
  /** 同一会话内其它 pending 请求数量（不含本 ask 的问题）。 */
  otherPending?: number;
  busy?: boolean;
  connected?: boolean;
  onStop?: () => void;
  stopping?: boolean;
  queue?: readonly PromptQueueChip[];
  onSubmit: (answers: AskUserAnswer[]) => void;
  onCancel: () => void;
}) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [drafts, setDrafts] = useState<AskDraft[]>(() => request.questions.map(() => emptyDraft()));
  const submittedRef = useRef(false);

  // 切换 requestId 时重置进度与草稿（ChatView 的 key 也会重挂载，双保险）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅 requestId 变化时重置
  useEffect(() => {
    setQuestionIndex(0);
    setDrafts(request.questions.map(() => emptyDraft()));
    submittedRef.current = false;
  }, [request.requestId]);

  // 提交失败（busy 回落）后允许重试，但仍阻止同一次提交被触发两次。
  useEffect(() => {
    if (!busy) submittedRef.current = false;
  }, [busy]);

  const current = drafts[questionIndex] ?? emptyDraft();
  const question = request.questions[questionIndex];
  const answers = request.questions.map((item, index) =>
    buildAnswer(item, drafts[index] ?? emptyDraft()),
  );
  const currentAnswered = question
    ? current.selected.length > 0 || current.custom.trim().length > 0
    : true;
  const allAnswered = answers.every((answer) => answer.answer.length > 0);
  const isLast = questionIndex >= request.questions.length - 1;
  const remainingQuestions = Math.max(0, request.questions.length - questionIndex - 1);

  const updateDraft = (index: number, update: (draft: AskDraft) => AskDraft) => {
    setDrafts((prev) => {
      const next = prev.map((item) => ({
        selected: [...item.selected],
        custom: item.custom,
      }));
      next[index] = update(next[index] ?? emptyDraft());
      return next;
    });
  };

  const toggle = (option: string) => {
    if (!question) return;
    const multi = question.multi_select === true;
    updateDraft(questionIndex, (draft) => {
      if (!multi) return { ...draft, selected: [option] };
      const set = new Set(draft.selected);
      if (set.has(option)) set.delete(option);
      else set.add(option);
      return { ...draft, selected: [...set] };
    });
  };

  const handleNext = () => {
    if (isLast) {
      if (!allAnswered || submittedRef.current) return;
      submittedRef.current = true;
      onSubmit(answers);
      return;
    }
    if (!currentAnswered) return;
    setQuestionIndex((index) => Math.min(index + 1, request.questions.length - 1));
  };

  return (
    <PromptShell
      label={t('chat.prompt.question')}
      more={otherPending + remainingQuestions}
      focusKey={`${request.requestId}:${questionIndex}`}
      onStop={onStop}
      stopping={stopping}
      connected={connected}
      queue={queue}
    >
      <AskQuestionCard
        request={request}
        questionIndex={questionIndex}
        selected={current.selected}
        custom={current.custom}
        busy={busy}
        connected={connected}
        canAdvance={isLast ? allAnswered : currentAnswered}
        isLast={isLast}
        onToggle={toggle}
        onCustom={(value) => updateDraft(questionIndex, (draft) => ({ ...draft, custom: value }))}
        onPrev={questionIndex > 0 ? () => setQuestionIndex((index) => index - 1) : undefined}
        onNext={handleNext}
        onCancel={onCancel}
      />
    </PromptShell>
  );
}
