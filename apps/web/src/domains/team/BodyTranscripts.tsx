import type { ReactNode } from 'react';
import { Markdown } from '../../components/Markdown';
import { EmptyState, ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { Button } from '../../components/ui';
import { formatClock, localDayKey, localDayLabel } from '../../format';
import type { Message, SessionDetail } from '../../gateway/types';
import { t } from '../../i18n';
import {
  isRuntimeMessageVisible,
  runtimeMessageKind,
  useRuntimeVisibility,
} from '../../state/runtime-visibility';
import { resourceData, useResource } from '../../state/useResource';
import type { MemberDetailClient } from './member-detail-types';

export function SessionTranscript({ messages }: { messages: readonly Message[] }) {
  const { visibility } = useRuntimeVisibility();
  const nodes: ReactNode[] = [];
  let lastDay: string | null = null;
  // 只读会话消息没有稳定 id：用局部序号做 key，稳定且不受排序影响。
  let keySeq = 0;
  for (const message of messages) {
    // Runtime context (`vessel:*`) is model-only; hide it unless the user opts in.
    const kind = runtimeMessageKind(message);
    if (kind !== undefined && !isRuntimeMessageVisible(visibility, kind)) continue;
    const key = `message-${keySeq++}`;
    const ts = message.timestamp;
    const day = ts !== undefined ? localDayKey(ts) : null;
    if (day && day !== lastDay) {
      nodes.push(
        <div className="day-divider mt-1.5 mb-0.5" key={`day-${day}`}>
          <span>{localDayLabel(ts ?? 0)}</span>
        </div>,
      );
      lastDay = day;
    }
    if (message.role === 'system') {
      nodes.push(
        <div
          className="mx-auto my-0.5 max-w-180 rounded-r-sm border-l-2 border-l-line-strong bg-sunken px-3 py-1.25 text-center text-sm text-muted"
          key={key}
          role="status"
        >
          <span className="mr-1.5 font-mono text-2xs uppercase text-faint">
            {t('team.message.systemTag')}
          </span>
          <span>{message.content}</span>
        </div>,
      );
      continue;
    }
    nodes.push(
      <div className="flex flex-col gap-1" key={key}>
        <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
          <span className="font-medium text-muted">{message.name || message.role}</span>
          {ts !== undefined && (
            <time className="font-mono tabular-nums" dateTime={new Date(ts).toISOString()}>
              {formatClock(ts)}
            </time>
          )}
        </div>
        {message.role === 'tool' ? (
          <pre className="m-0 max-w-180 rounded-sm border border-line bg-sunken px-2.5 py-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
            {message.content}
          </pre>
        ) : (
          <div className="team-message-bubble">
            <Markdown className="text-base leading-relaxed wrap-anywhere" text={message.content} />
          </div>
        )}
      </div>,
    );
  }
  return <div className="mx-auto flex w-full max-w-180 flex-col gap-3">{nodes}</div>;
}

export function BodyTranscript({
  client,
  hasToken,
  epoch,
  bodyId,
  initialSession,
  onBackToMember,
}: {
  client: MemberDetailClient;
  hasToken: boolean;
  epoch: number;
  bodyId: string;
  initialSession?: SessionDetail;
  onBackToMember: () => void;
}) {
  const resource = useResource({
    load: () => client.getSession(bodyId),
    enabled: hasToken,
    deps: [bodyId, epoch],
    ...(initialSession !== undefined ? { initialData: initialSession } : {}),
  });
  const session = resourceData(resource.state);
  const error =
    resource.state.status === 'error'
      ? { message: resource.state.error, code: resource.state.code }
      : undefined;

  if (!hasToken) {
    return (
      <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
    );
  }

  return (
    <div className="team-body-view flex min-h-0 min-w-0 flex-col">
      <header className="team-chat-head">
        <div className="min-w-0">
          <h1 className="font-serif text-title font-semibold wrap-anywhere">
            {t('team.member.title')}
          </h1>
          <div className="mt-1.25 flex flex-wrap items-center gap-2 text-sm text-muted">
            <span className="font-mono">{bodyId}</span>
          </div>
        </div>
        <div className="flex flex-none flex-wrap justify-end gap-1.5">
          <Button onClick={onBackToMember}>{t('breadcrumb.team.member')}</Button>
        </div>
      </header>
      <div className="team-transcript-scroll pt-4">
        {!session && !error ? (
          <LoadingState rows={3} />
        ) : !session ? (
          <ErrorState
            message={error?.message ?? t('team.error.loadFailed')}
            onRetry={resource.reload}
          />
        ) : session.messages.length === 0 ? (
          <EmptyState title={t('team.chat.empty')} />
        ) : (
          <SessionTranscript messages={session.messages} />
        )}
      </div>
    </div>
  );
}
