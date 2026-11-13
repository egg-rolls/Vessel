import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui';
import type {
  AskUserAnswer,
  AskUserRequest,
  PermissionRequest,
  PermissionScope,
} from '../../gateway/types';
import { t } from '../../i18n';
import { useAskDrafts, useSetAskDraft } from '../pending/ask-draft-store';
import { type AskDraftValue, askDraftOf } from '../pending/ask-drafts';
import { AskQuestionCard, buildAnswer } from './AskCard';
import { PermissionCard } from './PermissionCard';

/** 队列摘要 chip：由 ChatView 从 `pendingQueue` 生成。 */
export interface PromptQueueChip {
  key: string;
  label: string;
}

/**
 * Composer 槽位的三个互斥状态（0.18）：Composer / PermissionPrompt / AskPrompt。
 *
 * 权限与 ask 都会阻塞对话，所以 pending 期间用同尺寸提示卡替换输入框；
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
    <footer className="composer-area">
      <section
        ref={sectionRef}
        tabIndex={-1}
        className="prompt-slot mx-auto flex w-full max-w-[var(--chat-content-w,860px)] flex-col gap-2 overflow-y-auto overscroll-contain rounded-lg bg-raised px-3.5 py-3"
        aria-label={t('chat.prompt.label')}
      >
        <div className="prompt-slot-head sticky top-0 z-1 flex flex-wrap items-baseline gap-2.5 bg-raised py-0.5 text-sm">
          <span className="prompt-slot-kind text-md text-ink">{label}</span>
          {more > 0 && <span className="text-muted">{t('chat.prompt.more', { count: more })}</span>}
          <span className="prompt-slot-hint text-muted">{t('chat.prompt.blocking')}</span>
          {onStop && (
            <Button
              variant="link"
              className="prompt-slot-stop"
              onClick={onStop}
              disabled={stopping}
            >
              {stopping ? t('chat.run.stopping') : t('chat.run.stop')}
            </Button>
          )}
          {queue && queue.length > 0 && (
            <div className="flex basis-full flex-wrap gap-2">
              {queue.slice(0, 3).map((item) => (
                <span
                  className="inline-flex items-center rounded-full bg-sunken px-2.5 py-0.5 text-2xs leading-relaxed text-muted"
                  key={item.key}
                >
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
          <p className="prompt-slot-hint ml-0 text-danger" role="status">
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
 * ask：替换输入框（0.18 S2/S3）。
 *
 * 同一 request 的多题拆成多张单卡：只渲染当前 `questionIndex`，草稿按
 * `<requestId>#<题号>` 存进 `ask-draft-store`（**不**是组件 state）；
 * “下一题”推进，“上一题”回看；最后一题所有答案非空时才调用一次 `onSubmit(answers)`。
 *
 * 0.51：草稿离开组件，切页 / 刷新 / 重连回来还在（用户实测「正在勾选但还没提交的选项
 * 没了」就是这里丢的）。`questionIndex` 仍是本地的浏览位 —— 回到第 1 题看，但答案还在。
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
  const drafts = useAskDrafts();
  const setDraft = useSetAskDraft();
  const submittedRef = useRef(false);

  // 切 requestId 时把浏览位与提交守卫复位（ChatView 的 key 也会重挂载，双保险）。
  // 草稿**不**在这里清：它按 requestId 寻址，另一条请求的草稿与本条无关。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅 requestId 变化时重置
  useEffect(() => {
    setQuestionIndex(0);
    submittedRef.current = false;
  }, [request.requestId]);

  // 提交失败（busy 回落）后允许重试，但仍阻止同一次提交被触发两次。
  useEffect(() => {
    if (!busy) submittedRef.current = false;
  }, [busy]);

  const current = askDraftOf(drafts, request.requestId, questionIndex);
  const question = request.questions[questionIndex];
  const answers = request.questions.map((item, index) =>
    buildAnswer(item, askDraftOf(drafts, request.requestId, index)),
  );
  const currentAnswered = question
    ? current.selected.length > 0 || current.custom.trim().length > 0
    : false;
  const allAnswered =
    request.questions.length > 0 && answers.every((answer) => answer.answer.length > 0);
  const isLast = questionIndex >= request.questions.length - 1;
  const remainingQuestions = Math.max(0, request.questions.length - questionIndex - 1);

  const updateDraft = (index: number, update: (draft: AskDraftValue) => AskDraftValue) => {
    setDraft(request.requestId, index, update);
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
      queue={queue?.slice(questionIndex, questionIndex + 3)}
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
