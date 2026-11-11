/**
 * 「待批」里的一簇：同一 agent / 会话的多次 ask_user 聚在一起。
 *
 * - 折叠时只显示摘要与计数（列表态）；
 * - 展开后逐条显示问题正文（文本 / 同源图片 / 链接）、选项与自由输入；
 * - 勾选的条目「一起提交」→ 一次用户动作，每条 ask 一次应答（见 usePendingBatch）；
 * - 提交中、或该 requestId 已在途时禁用输入，避免重复投递。
 */
import { useMemo, useState } from 'react';
import { Badge, Button, CountBadge, cn, Input, Section } from '../../components/ui';
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { AskUserAnswer, AskUserQuestion, AskUserRequest } from '../../gateway/types';
import { t } from '../../i18n';
import { buildAnswer } from '../chat/AskCard';
import type { PendingCluster } from './cluster';
import { questionBlocks } from './question-blocks';
import { usePendingBatch } from './usePendingBatch';

/** 单条 ask 的草稿：勾选状态 + 逐题选项 / 自定义输入。 */
interface ItemDraft {
  included: boolean;
  selected: string[][];
  custom: string[];
}

function initialDraft(request: AskUserRequest): ItemDraft {
  return {
    included: true,
    selected: request.questions.map(() => []),
    custom: request.questions.map(() => ''),
  };
}

function answersFor(request: AskUserRequest, draft: ItemDraft): AskUserAnswer[] {
  return request.questions.map((question, index) =>
    buildAnswer(question, {
      selected: draft.selected[index] ?? [],
      custom: draft.custom[index] ?? '',
    }),
  );
}

function isComplete(answers: readonly AskUserAnswer[]): boolean {
  return answers.every((answer) => answer.answer.length > 0);
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
  draft,
  disabled,
  onChange,
}: {
  question: AskUserQuestion;
  /** radio 分组名：同一 requestId + 题号，避免跨条同题互相顶掉。 */
  groupId: string;
  index: number;
  draft: { selected: string[]; custom: string };
  disabled: boolean;
  onChange: (next: { selected: string[]; custom: string }) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md bg-sunken p-3.5">
      <div className="font-mono text-2xs font-semibold uppercase tracking-widest text-accent-ink">
        {question.header}
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
  const [drafts, setDrafts] = useState<Record<string, ItemDraft>>({});

  const items = useMemo(
    () =>
      cluster.requests.map((request) => {
        const draft = drafts[request.requestId] ?? initialDraft(request);
        const answers = answersFor(request, draft);
        return { request, draft, answers, complete: isComplete(answers) };
      }),
    [cluster.requests, drafts],
  );

  const included = items.filter((item) => item.draft.included);
  const ready = included.filter((item) => item.complete);
  const canSubmit = included.length > 0 && ready.length === included.length && !busy;

  const patch = (request: AskUserRequest, updater: (draft: ItemDraft) => ItemDraft) => {
    setDrafts((previous) => ({
      ...previous,
      [request.requestId]: updater(previous[request.requestId] ?? initialDraft(request)),
    }));
  };

  const clusterLabel =
    cluster.scope === 'agent'
      ? t('pending.cluster.agent', { id: shortId(cluster.agentId ?? '') })
      : cluster.scope === 'session'
        ? t('pending.cluster.session', { id: shortId(cluster.sessionId ?? '') })
        : t('pending.cluster.run', { id: shortId(cluster.requests[0]?.runId ?? '') });

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
        </span>
      }
      description={formatTimestamp(cluster.latestAt)}
      actions={
        <div className="ml-auto flex items-center gap-2">
          <Button size="small" onClick={onToggle} aria-expanded={expanded}>
            {expanded ? t('pending.cluster.collapse') : t('pending.cluster.expand')}
          </Button>
          {expanded && (
            <Button
              variant="primary"
              size="small"
              disabled={!canSubmit}
              onClick={() => {
                void submit(
                  cluster.key,
                  ready.map((item) => ({
                    requestId: item.request.requestId,
                    answers: item.answers,
                  })),
                );
              }}
            >
              {busy ? t('pending.submit.busy') : t('pending.submit', { count: ready.length })}
            </Button>
          )}
        </div>
      }
    >
      {expanded ? (
        <div className="flex flex-col gap-3">
          {items.map((item) => {
            const pendingRespond = responding.has(item.request.requestId);
            const disabled = busy || pendingRespond;
            return (
              <div
                key={item.request.requestId}
                className="flex flex-col gap-2 rounded-md bg-raised p-3 shadow-elev-1"
              >
                <div className="flex flex-wrap items-center gap-2 text-2xs text-faint">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-muted">
                    <input
                      className="accent-accent"
                      type="checkbox"
                      checked={item.draft.included}
                      disabled={disabled}
                      onChange={() =>
                        patch(item.request, (draft) => ({
                          ...draft,
                          included: !draft.included,
                        }))
                      }
                    />
                    {t('pending.item.include')}
                  </label>
                  <span className="font-mono tabular-nums">run {shortId(item.request.runId)}</span>
                  <span className="tabular-nums">{formatTimestamp(item.request.requestedAt)}</span>
                  {pendingRespond && <span>{t('pending.item.responding')}</span>}
                </div>
                {item.request.questions.map((question, index) => (
                  <QuestionField
                    // key 用问题自身的 header+正文：ask 的题目在同一请求内不会重复，
                    // 用下标当 key 会在勾选状态变化时错位（biome noArrayIndexKey）。
                    key={`${item.request.requestId}:${question.header}:${question.question}`}
                    question={question}
                    groupId={item.request.requestId}
                    index={index}
                    draft={{
                      selected: item.draft.selected[index] ?? [],
                      custom: item.draft.custom[index] ?? '',
                    }}
                    disabled={disabled || !item.draft.included}
                    onChange={(next) =>
                      patch(item.request, (draft) => {
                        const selected = draft.selected.map((picks, position) =>
                          position === index ? next.selected : picks,
                        );
                        const custom = draft.custom.map((value, position) =>
                          position === index ? next.custom : value,
                        );
                        return { ...draft, selected, custom };
                      })
                    }
                  />
                ))}
              </div>
            );
          })}
          {included.length > 0 && ready.length < included.length && (
            <p className="text-sm text-muted" role="status">
              {t('pending.answerRequired')}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted wrap-anywhere">{collapsedPreview(cluster)}</p>
      )}
    </Section>
  );
}
