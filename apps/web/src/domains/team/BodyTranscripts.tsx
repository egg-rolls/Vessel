import { type ReactNode, useCallback, useMemo, useRef } from 'react';
import { CopyButton } from '../../components/CopyButton';
import { Markdown } from '../../components/Markdown';
import { EmptyState, ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { Button, EntityHeader } from '../../components/ui';
import { formatClock, localDayKey, localDayLabel } from '../../format';
import type { Message, SessionDetail } from '../../gateway/types';
import { t } from '../../i18n';
import {
  isRuntimeMessageVisible,
  runtimeMessageKind,
  useRuntimeVisibility,
} from '../../state/runtime-visibility';
import { cleanSessionTitle } from '../../state/sessions';
import { resourceData, useResource } from '../../state/useResource';
import { ConversationIndex } from '../chat/ConversationIndex';
import { indexEntriesOfMessages } from '../chat/conversation-index';
import { EnvCard } from '../chat/EnvCard';
import { runtimeEnvCard } from '../chat/env-notice';
import { useConversationIndex } from '../chat/useConversationIndex';
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
        // data-index-entry-key：会话索引竖条的跳转锚点（局部序号 key，与
        // conversation-index.ts#indexEntriesOfMessages 同一套编号）。
        <div key={key} data-index-entry-key={key}>
          <div
            className="mx-auto my-0.5 max-w-180 rounded-r-sm border-l-2 border-l-line-strong bg-sunken px-3 py-1.25 text-center text-sm text-muted"
            role="status"
          >
            <span className="mr-1.5 font-mono text-2xs uppercase text-faint">
              {t('team.message.systemTag')}
            </span>
            <span>{message.content}</span>
          </div>
        </div>,
      );
      continue;
    }
    // 环境信息（vessel:notice / vessel:source）默认可见后，这里也不能把它画成成员说的话：
    // 与聊天时间线同一张卡（`EnvCard` → `StreamCard`）、同一个装配入口（runtimeEnvCard），
    // 同一套样式与点击展开。只读视图里保底展开（今天就是铺全部行，不因为换卡把上下文
    // 藏起来），想收起点一下即可。
    const env = runtimeEnvCard(kind, message.content);
    if (env !== undefined) {
      nodes.push(
        <div key={key} data-index-entry-key={key}>
          <EnvCard env={env} ts={ts} defaultOpen />
        </div>,
      );
      continue;
    }
    nodes.push(
      <div key={key} data-index-entry-key={key}>
        <div className="flex flex-col gap-1">
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
              <Markdown
                className="text-base leading-relaxed wrap-anywhere"
                text={message.content}
              />
            </div>
          )}
        </div>
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
  memberName,
  teamName,
  initialSession,
  onBackToMember,
}: {
  client: MemberDetailClient;
  hasToken: boolean;
  epoch: number;
  bodyId: string;
  /** Identity 槽：成员名（用户裁决：本屏 Identity 用成员名，不改成「第 N 次会话」）。 */
  memberName: string;
  /** Scope 槽：所属 Team 名（有则渲染 "in <team>"；缺省不渲染从属行）。 */
  teamName?: string | undefined;
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
  // 会话名优先，缺省回落到会话 ID（后者即 bodyId，取数用）；占位脏值跳过。
  const sessionTitle =
    cleanSessionTitle(session?.title) || cleanSessionTitle(session?.preview) || bodyId;

  // 会话索引竖条（minimap）：只读消息 → 索引条目（编号与 SessionTranscript 同源），
  // 视口追踪 + 点击跳转与会话页同一套。钩子在早退之前，保证 hook 顺序稳定。
  const { visibility } = useRuntimeVisibility();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const getScrollElement = useCallback(() => scrollRef.current, []);
  const indexEntries = useMemo(
    () => (session ? indexEntriesOfMessages(session.messages, visibility) : []),
    [session, visibility],
  );
  const { activeKey: indexActiveKey, jumpTo: indexJumpTo } = useConversationIndex({
    getElement: getScrollElement,
    entryKeys: indexEntries.map((entry) => entry.key),
    // hasToken 进 reset key：未连接时本屏早退成 NotEnabledState（滚动区不在 DOM），
    // 连上后滚动区才出现 —— 触发器变了才会重新订阅。
    resetKey: `${bodyId}:${hasToken ? '1' : '0'}`,
  });

  if (!hasToken) {
    return (
      <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
    );
  }

  return (
    <div className="team-body-view flex min-h-0 min-w-0 flex-col">
      {/* 四槽位（DESIGN-0.33.0 §1，用户 2026-11-04 裁决）：Identity=成员名，
          Scope=所属 Team（有则 "in <team>"）；bodyId 属 Detail，不进头部（I4）。
          外层 `team-body-head` 只为对齐提供 padding（与被替换的 `.team-chat-head` 同值），
          不加 border-bottom（DESIGN.md §3 无边框体系，两页统一不给线）。 */}
      <header className="team-body-head">
        <EntityHeader
          title={memberName}
          scope={teamName ? [{ label: teamName }] : []}
          actions={<Button onClick={onBackToMember}>{t('breadcrumb.team.member')}</Button>}
        />
      </header>
      <div className="transcript-stage">
        <div className="team-transcript-scroll pt-4" ref={scrollRef}>
          {!session && !error ? (
            <LoadingState rows={3} />
          ) : !session ? (
            <ErrorState
              message={error?.message ?? t('team.error.loadFailed')}
              onRetry={resource.reload}
            />
          ) : (
            <>
              {/* Detail 槽：会话名（超长截断），右侧复制按钮复制的是**会话 ID**（bodyId）。 */}
              <div className="mx-auto flex w-full max-w-180 min-w-0 items-center gap-2 text-2xs text-faint">
                <span className="min-w-0 flex-1 truncate" title={sessionTitle}>
                  {sessionTitle}
                </span>
                <CopyButton text={bodyId} className="shrink-0 text-2xs" />
              </div>
              {session.messages.length === 0 ? (
                <EmptyState title={t('team.chat.empty')} />
              ) : (
                <SessionTranscript messages={session.messages} />
              )}
            </>
          )}
        </div>
        <ConversationIndex
          entries={indexEntries}
          activeKey={indexActiveKey}
          onJump={indexJumpTo}
          className="conversation-index-rail"
        />
      </div>
    </div>
  );
}
