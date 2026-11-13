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
 * - 服务端语义：一条 ask 要等**它自己的每一题**都被答完才整体落定（pending → answered）；
 *   0.52 起允许**分批**——一次只答几题，剩下的题仍 pending（逐题进度见
 *   `answeredQuestionIds`）。已落定的题在界面上标「已答」并锁住输入，草稿保留回看，
 *   但**不再进载荷** —— 重投的那几行只能靠题号被服务端挡回来，缺 question_id 的
 *   旧写法还会变成一条独立答案（分批提交漂移的入口，见 ask-submit-plan）；
 * - 提交中、或该 requestId 已在途时禁用输入，避免重复投递。
 *
 * 0.51：草稿（勾选 / 自定义输入 / 纳入勾选）不再是组件 state，而是按
 * `requestId + 题号` 存进 `ask-draft-store`（sessionStorage 镜像）——
 * 切页 / 刷新 / 重连回来，正在勾的选项与打了一半的答复都还在。
 */
import { useMemo } from 'react';
import { Badge, Button, CountBadge, cn, Input, Section } from '../../components/ui';
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { AskUserQuestion } from '../../gateway/types';
import { t } from '../../i18n';
import { useAskDrafts, useDropAskDrafts, useSetAskDraft } from './ask-draft-store';
import { type AskDraftValue, isAskDraftAnswered } from './ask-drafts';
import { askIncludedAnswers, askPlanRows } from './ask-submit-plan';
import type { PendingCluster } from './cluster';
import { questionBlocks } from './question-blocks';
import { usePendingBatch } from './usePendingBatch';

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
  settled,
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
  /** 服务端已经落定这题：草稿留着回看，输入锁住，勾选换成「已答」标记。 */
  settled: boolean;
  draft: { selected: readonly string[]; custom: string };
  disabled: boolean;
  onToggleInclude: () => void;
  onChange: (next: { selected: readonly string[]; custom: string }) => void;
}) {
  const locked = disabled || settled;
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-md bg-sunken p-3.5',
        include && !settled && 'outline-2 outline-offset-2 outline-accent-soft',
        settled && 'opacity-70',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="font-mono text-2xs font-semibold uppercase tracking-widest text-accent-ink">
          {question.header}
        </div>
        {settled ? (
          // 已落定的题不给勾选：它不会进载荷，给出可点的勾选框只会让人以为还能改。
          <span className="inline-flex items-center gap-1.5 text-sm text-muted">
            <Badge tone="neutral">{t('pending.item.answered')}</Badge>
          </span>
        ) : (
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
        )}
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
                  disabled={locked}
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
        disabled={locked}
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
  // 草稿不再是组件 state：切页 / 刷新回来还在（见 ask-draft-store 头注释）。
  const drafts = useAskDrafts();
  const setDraft = useSetAskDraft();
  const dropDrafts = useDropAskDrafts();

  /** 全部问题的扁平视图：勾选、计数、投递计划都按「题」算，不按 request 绑死。 */
  const rows = useMemo(() => askPlanRows(cluster.requests, drafts), [cluster.requests, drafts]);

  /** 本次回复的投递计划：按 request 分组（同一请求的几题合成一次 `ask.respond`）。 */
  const plan = useMemo(() => {
    const byRequest = new Map<string, typeof rows>();
    for (const row of rows) {
      // 已落定的题不进载荷：服务端只会把它当重复挡回来，而缺题号的旧写法还会被当成
      // 一条独立的新答案写进记录。草稿留着展示，这里只筛不删。
      if (row.settled || !row.answered || !row.draft.include) continue;
      const group = byRequest.get(row.requestId);
      if (group === undefined) byRequest.set(row.requestId, [row]);
      else group.push(row);
    }
    // 逐题结构化：question_id 让服务端把答案挂到「题」上（未答的题不随本次提交
    // 被带走），selected 保住多选结构；行内 index 就是该请求内的稳定题号。
    return [...byRequest.entries()].map(([requestId, group]) => ({
      requestId,
      answers: askIncludedAnswers(group),
    }));
  }, [rows]);

  /** 还能勾 / 还能答的题：已落定的题已经有答案了，不再参与勾选与计数。 */
  const openRows = rows.filter((row) => !row.settled);
  const answeredRows = openRows.filter((row) => row.answered);
  const includedCount = rows.filter(
    (row) => !row.settled && row.answered && row.draft.include,
  ).length;
  const allIncluded = answeredRows.length > 0 && answeredRows.every((row) => row.draft.include);
  /** 勾了但没答：回复时会被跳过，所以给一句提示（不阻塞提交）。 */
  const hasSkipped = openRows.some((row) => row.draft.include && !row.answered);
  const canSubmit = plan.length > 0 && !busy;

  const patchDraft = (
    requestId: string,
    index: number,
    updater: (draft: AskDraftValue) => AskDraftValue,
  ) => {
    setDraft(requestId, index, updater);
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
    next: { selected: readonly string[]; custom: string },
  ) => {
    patchDraft(requestId, index, (draft) => {
      const flipped = isAskDraftAnswered(draft) !== isAskDraftAnswered(next);
      return { ...draft, ...next, ...(flipped ? { include: isAskDraftAnswered(next) } : {}) };
    });
  };

  const toggleInclude = (requestId: string, index: number) => {
    patchDraft(requestId, index, (draft) => ({ ...draft, include: !draft.include }));
  };

  /** 全选 / 取消全选：只作用于已作答且还没落定的题，未答的题不制造空勾选。 */
  const toggleAll = () => {
    const target = !allIncluded;
    for (const row of answeredRows) {
      patchDraft(row.requestId, row.index, (draft) => ({ ...draft, include: target }));
    }
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    const requestIds = plan.map((item) => item.requestId);
    void submit(cluster.key, plan).then(() => {
      // 提交后清掉这批的草稿（请求通常也会随即从 pending 列表里消失；
      // 请求消失但没提交过的那部分由 useAskDraftPrune 兜）。
      dropDrafts(requestIds);
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
                {rows
                  .filter((row) => row.requestId === request.requestId)
                  .map((row) => (
                    <QuestionField
                      // key 用问题自身的 header+正文：ask 的题目在同一请求内不会重复，
                      // 用下标当 key 会在勾选状态变化时错位（biome noArrayIndexKey）。
                      key={`${row.requestId}:${row.question.header}:${row.question.question}`}
                      question={row.question}
                      groupId={row.requestId}
                      index={row.index}
                      include={row.draft.include}
                      settled={row.settled}
                      draft={{ selected: row.draft.selected, custom: row.draft.custom }}
                      disabled={requestDisabled}
                      onToggleInclude={() => toggleInclude(row.requestId, row.index)}
                      onChange={(next) => setAnswer(row.requestId, row.index, next)}
                    />
                  ))}
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
