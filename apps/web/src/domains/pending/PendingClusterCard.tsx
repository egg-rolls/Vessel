/**
 * 「待批」里的一簇：同一 agent / 会话的多次 ask 聚在一起。
 *
 * - 折叠时只显示摘要与计数（列表态）；
 * - 展开后逐条显示问题正文（文本 / 同源图片 / 链接）、选项与自由输入；
 * - **每题独立**（用户裁决）：勾选框挂在**每个问题**上，不再把整条 ask 绑成一次
 *   「一起提交」—— 可以只回复第 2 题，也可以勾全部一次回复；
 * - 勾选只决定「这次回复带上哪些答案」，**不**决定能不能作答：任何一题随时可答，
 *   作答即自动纳入本次回复（不勾也能回答）；
 * - 提交仍是一次用户动作 → 同批带一个 `batch_id` 的多次 `ask.respond`（见
 *   usePendingBatch）。服务端本来就允许 `answers` 是任意长度的数组
 *   （`ask.respond` 只校验它是 Array，见 packages/serve 的 interactions 方法），
 *   且答案行自带原问题（`formatAnswersForModel`），所以「部分提交」不需要新协议；
 * - 代价（服务端语义，本页改不了）：一条 ask 一经应答就整体落定
 *   （pending → answered），未勾选的题随该请求一起收口 —— 回复行旁明写这一点；
 * - 提交中、或该 requestId 已在途时禁用输入，避免重复投递。
 */
import { useMemo, useState } from 'react';
import { Badge, Button, CountBadge, cn, Input, Section } from '../../components/ui';
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { AskUserAnswer, AskUserQuestion } from '../../gateway/types';
import { t } from '../../i18n';
import { buildAnswer } from '../chat/AskCard';
import type { PendingCluster } from './cluster';
import { questionBlocks } from './question-blocks';
import { usePendingBatch } from './usePendingBatch';

/** 单题草稿：是否纳入本次回复 + 已选选项 + 自定义输入。 */
interface QuestionDraft {
  /** 是否纳入本次回复（默认不勾；作答会自动勾上）。 */
  include: boolean;
  selected: string[];
  custom: string;
}

function emptyQuestionDraft(): QuestionDraft {
  return { include: false, selected: [], custom: '' };
}

/** 草稿键：requestId + 题号（题号在同一条请求内稳定）。 */
function draftKey(requestId: string, index: number): string {
  return `${requestId}:${index}`;
}

function isAnswered(draft: { selected: readonly string[]; custom: string }): boolean {
  return draft.selected.length > 0 || draft.custom.trim().length > 0;
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 16)}…` : value;
}

/** 折叠态的一行预览：第一条提问的 header + 正文。 */
function collapsedPreview(cluster: PendingCluster): string {
  const first = cluster.requests[0]?.questions[0];
  if (first === undefined) return '';
  return `${first.header}: ${first.question}`;
}

function toggleOption(picks: readonly string[], option: string, multi: boolean): string[] {
  if (!multi) return [option];
  const next = new Set(picks);
  if (next.has(option)) next.delete(option);
  else next.add(option);
  return [...next];
}

/** 问题正文：文本 + 同源图片 + 链接（远程图片由 CSP 拦截，统一降级成链接）。 */
function QuestionBody({ text }: { text: string }) {
  const blocks = useMemo(() => questionBlocks(text), [text]);
  return (
    <div className="flex flex-col gap-1.5 leading-relaxed wrap-anywhere">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        if (block.kind === 'image') {
          return (
            <img
              key={key}
              alt={block.alt}
              className="max-h-64 w-auto max-w-full rounded-sm"
              loading="lazy"
              referrerPolicy="no-referrer"
              src={block.src}
            />
          );
        }
        if (block.kind === 'link') {
          return (
            <a
              key={key}
              className="text-accent-ink underline underline-offset-2 wrap-anywhere"
              href={block.href}
              rel="noreferrer noopener"
              target="_blank"
            >
              {block.label}
            </a>
          );
        }
        return (
          <span key={key} className="whitespace-pre-wrap">
            {block.text}
          </span>
        );
      })}
    </div>
  );
}

function QuestionField({
  question,
  groupId,
  index,
  include,
  draft,
  disabled,
  onToggleInclude,
  onChange,
}: {
  question: AskUserQuestion;
  /** radio 分组名：同一 requestId + 题号，避免跨条同题互相顶掉。 */
  groupId: string;
  index: number;
  /** 这一题是否纳入本次回复（勾选只影响提交内容，不影响能否作答）。 */
  include: boolean;
  draft: { selected: string[]; custom: string };
  disabled: boolean;
  onToggleInclude: () => void;
  onChange: (next: { selected: string[]; custom: string }) => void;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-md bg-sunken p-3.5',
        include && 'outline-2 outline-offset-2 outline-accent-soft',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="font-mono text-2xs font-semibold uppercase tracking-widest text-accent-ink">
          {question.header}
        </div>
        <label
          className={cn(
            'inline-flex cursor-pointer items-center gap-1.5 text-sm',
            include ? 'text-ink' : 'text-muted',
          )}
        >
          <input
            className="accent-accent"
            type="checkbox"
            checked={include}
            disabled={disabled}
            onChange={onToggleInclude}
          />
          {t('pending.item.include')}
        </label>
      </div>
      <QuestionBody text={question.question} />
      {question.options && question.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {question.options.map((option) => {
            const picked = draft.selected.includes(option);
            return (
              <label
                key={option}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-md pointer-coarse:min-h-touch',
                  picked ? 'bg-accent-soft text-accent-ink' : 'bg-raised text-ink hover:bg-hover',
                )}
              >
                <input
                  className="accent-accent"
                  type={question.multi_select ? 'checkbox' : 'radio'}
                  name={`${groupId}-${index}`}
                  checked={picked}
                  disabled={disabled}
                  onChange={() =>
                    onChange({
                      ...draft,
                      selected: toggleOption(
                        draft.selected,
                        option,
                        question.multi_select === true,
                      ),
                    })
                  }
                />
                <span>{option}</span>
              </label>
            );
          })}
        </div>
      )}
      <Input
        value={draft.custom}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, custom: event.target.value })}
        placeholder={
          question.options ? t('ask.customPlaceholder.options') : t('ask.customPlaceholder.open')
        }
        aria-label={`${question.header}: ${question.question}`}
      />
    </div>
  );
}

export function PendingClusterCard({
  cluster,
  expanded,
  onToggle,
}: {
  cluster: PendingCluster;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { respondAsk, responding } = useConnection();
  const { busyKey, submit } = usePendingBatch(respondAsk);
  const busy = busyKey === cluster.key;
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});

  /** 全部问题的扁平视图：勾选、计数、投递计划都按「题」算，不按 request 绑死。 */
  const rows = useMemo(
    () =>
      cluster.requests.flatMap((request) =>
        request.questions.map((question, index) => {
          const draft = drafts[draftKey(request.requestId, index)] ?? emptyQuestionDraft();
          return { request, question, index, draft, answered: isAnswered(draft) };
        }),
      ),
    [cluster.requests, drafts],
  );

  /** 本次回复的投递计划：按 request 分组（同一请求的几题合成一次 `ask.respond`）。 */
  const plan = useMemo(() => {
    const byRequest = new Map<string, { requestId: string; answers: AskUserAnswer[] }>();
    for (const row of rows) {
      if (!row.draft.include || !row.answered) continue;
      const entry = byRequest.get(row.request.requestId) ?? {
        requestId: row.request.requestId,
        answers: [],
      };
      entry.answers.push(buildAnswer(row.question, row.draft));
      byRequest.set(row.request.requestId, entry);
    }
    return [...byRequest.values()];
  }, [rows]);

  const answeredRows = rows.filter((row) => row.answered);
  const includedCount = rows.filter((row) => row.draft.include && row.answered).length;
  const allIncluded = answeredRows.length > 0 && answeredRows.every((row) => row.draft.include);
  /** 勾了但没答：回复时会被跳过，所以给一句提示（不阻塞提交）。 */
  const hasSkipped = rows.some((row) => row.draft.include && !row.answered);
  const canSubmit = plan.length > 0 && !busy;

  const patchDraft = (
    requestId: string,
    index: number,
    updater: (draft: QuestionDraft) => QuestionDraft,
  ) => {
    setDrafts((previous) => {
      const key = draftKey(requestId, index);
      return { ...previous, [key]: updater(previous[key] ?? emptyQuestionDraft()) };
    });
  };

  /**
   * 改答案：作答即自动纳入本次回复，清空即自动移出。
   *
   * 只在「已答 / 未答」真的翻转时才动 `include`，所以用户手动勾选 / 取消勾选
   * 不会被后续的文字编辑反复覆盖。
   */
  const setAnswer = (
    requestId: string,
    index: number,
    next: { selected: string[]; custom: string },
  ) => {
    patchDraft(requestId, index, (draft) => {
      const flipped = isAnswered(draft) !== isAnswered(next);
      return { ...draft, ...next, ...(flipped ? { include: isAnswered(next) } : {}) };
    });
  };

  const toggleInclude = (requestId: string, index: number) => {
    patchDraft(requestId, index, (draft) => ({ ...draft, include: !draft.include }));
  };

  /** 全选 / 取消全选：只作用于已作答的题，未答的题不制造空勾选。 */
  const toggleAll = () => {
    const target = !allIncluded;
    setDrafts((previous) => {
      const next = { ...previous };
      for (const row of answeredRows) {
        const key = draftKey(row.request.requestId, row.index);
        next[key] = { ...(next[key] ?? emptyQuestionDraft()), include: target };
      }
      return next;
    });
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    const requestIds = plan.map((item) => item.requestId);
    void submit(cluster.key, plan).then(() => {
      // 提交后清掉这批的勾选与草稿（请求通常也会随即从 pending 列表里消失）。
      setDrafts((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(
            ([key]) => !requestIds.some((requestId) => key.startsWith(`${requestId}:`)),
          ),
        ),
      );
    });
  };

  const clusterLabel =
    cluster.scope === 'agent'
      ? t('pending.cluster.agent', { id: shortId(cluster.agentId ?? '') })
      : cluster.scope === 'session'
        ? t('pending.cluster.session', { id: shortId(cluster.sessionId ?? '') })
        : t('pending.cluster.run', { id: shortId(cluster.requests[0]?.runId ?? '') });
  /**
   * 归属会话（0.51）：成员 bridge 的请求「发起会话」是成员自己的，真正算谁的是父会话。
   * 只在两者不同（且确实解析出了父会话）时多标一行，避免普通会话的卡片上多一句废话。
   */
  const homeSessionId = cluster.homeSessionId;
  const homeLabel =
    homeSessionId !== undefined && homeSessionId.length > 0 && homeSessionId !== cluster.sessionId
      ? shortId(homeSessionId)
      : undefined;

  return (
    <Section
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          {clusterLabel}
          <CountBadge
            count={cluster.requests.length}
            label={t('pending.cluster.count', { count: cluster.requests.length })}
          />
          <Badge tone={cluster.source === 'team' ? 'info' : 'neutral'}>
            {cluster.source === 'team' ? t('pending.source.team') : t('pending.source.session')}
          </Badge>
          {homeLabel !== undefined && (
            <span className="font-mono text-2xs text-faint">
              {t('pending.cluster.home', { id: homeLabel })}
            </span>
          )}
        </span>
      }
      description={formatTimestamp(cluster.latestAt)}
      actions={
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="small" onClick={onToggle} aria-expanded={expanded}>
            {expanded ? t('pending.cluster.collapse') : t('pending.cluster.expand')}
          </Button>
          {expanded && (
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-muted">
              <input
                className="accent-accent"
                type="checkbox"
                checked={allIncluded}
                disabled={busy || answeredRows.length === 0}
                onChange={toggleAll}
              />
              {t('pending.item.includeAll')}
            </label>
          )}
          {expanded && includedCount > 0 && (
            <span className="text-sm text-muted tabular-nums">
              {t('pending.submit.count', { count: includedCount })}
            </span>
          )}
          {expanded && (
            <Button variant="primary" size="small" disabled={!canSubmit} onClick={handleSubmit}>
              {busy ? t('pending.submit.busy') : t('pending.submit')}
            </Button>
          )}
        </div>
      }
    >
      {expanded ? (
        <div className="flex flex-col gap-3">
          {cluster.requests.map((request) => {
            const pendingRespond = responding.has(request.requestId);
            const requestDisabled = busy || pendingRespond;
            return (
              <div
                key={request.requestId}
                className="flex flex-col gap-2 rounded-md bg-raised p-3 shadow-elev-1"
              >
                <div className="flex flex-wrap items-center gap-2 text-2xs text-faint">
                  <span className="font-mono tabular-nums">run {shortId(request.runId)}</span>
                  {request.mode === 'async' && (
                    <span className="font-mono text-accent">{t('ask.asyncBadge')}</span>
                  )}
                  <span className="tabular-nums">{formatTimestamp(request.requestedAt)}</span>
                  {pendingRespond && <span>{t('pending.item.responding')}</span>}
                </div>
                {request.questions.map((question, index) => {
                  const draft = drafts[draftKey(request.requestId, index)] ?? emptyQuestionDraft();
                  return (
                    <QuestionField
                      // key 用问题自身的 header+正文：ask 的题目在同一请求内不会重复，
                      // 用下标当 key 会在勾选状态变化时错位（biome noArrayIndexKey）。
                      key={`${request.requestId}:${question.header}:${question.question}`}
                      question={question}
                      groupId={request.requestId}
                      index={index}
                      include={draft.include}
                      draft={{ selected: draft.selected, custom: draft.custom }}
                      disabled={requestDisabled}
                      onToggleInclude={() => toggleInclude(request.requestId, index)}
                      onChange={(next) => setAnswer(request.requestId, index, next)}
                    />
                  );
                })}
              </div>
            );
          })}
          {hasSkipped && (
            <p className="text-sm text-muted" role="status">
              {t('pending.answerRequired')}
            </p>
          )}
          {answeredRows.length > 0 && (
            <p className="text-sm text-muted">{t('pending.submit.note')}</p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted wrap-anywhere">{collapsedPreview(cluster)}</p>
      )}
    </Section>
  );
}
