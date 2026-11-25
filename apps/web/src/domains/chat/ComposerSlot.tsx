import { MessageBar, type MessageBarItem } from '../../components/MessageBar';
import type { PendingFetchState } from '../../gateway/interaction-hydration';
import type { AskUserAnswer, MessageRef, PermissionScope } from '../../gateway/types';
import { t } from '../../i18n';
import type { AttachBrowseClient } from './AttachDialog';
import { Composer } from './Composer';
import type { ComposerContextUsage } from './ComposerChrome';
import type { MemberModelSwitchProps } from './MemberModelSwitch';
import { AskPrompt, PermissionPrompt, type PromptQueueChip } from './PromptSlots';
import type { PendingQueueItem } from './pending-permissions';
import type { SessionRefChip, SessionRefScope } from './session-ref';

/**
 * `interactions.list` 拉取失败的可见条（0.59）。
 *
 * 为什么要在 Composer 槽位里也说一遍：这里正是「本来该出现权限卡」的位置 ——
 * 拉不到时它是空的，而空输入框会让用户以为「没有请求等我」，于是去按停止。
 * 拉取恢复后条自然消失（`pendingFetch.status` 回到 `ok`），卡片由 hydration 补回。
 */
function PendingFetchNotice({
  pendingFetch,
  onRetry,
}: {
  pendingFetch: PendingFetchState;
  onRetry?: () => void;
}) {
  if (pendingFetch.status !== 'failed') return null;
  const blocked = pendingFetch.kind === 'session' || pendingFetch.kind === 'origin';
  const item: MessageBarItem = {
    id: 'composer-pending-fetch',
    tone: 'error',
    // 单行 chip：text 必须自足（长句会被截断），完整原因放 hint（error 档渲染成第二行）。
    text: blocked ? t('pending.fetch.shortBlocked') : t('pending.fetch.shortFailed'),
    hint: blocked
      ? t('pending.fetch.blocked', { detail: pendingFetch.message ?? '' })
      : t('pending.fetch.failed', { detail: pendingFetch.message ?? '' }),
    ...(onRetry ? { actions: [{ label: t('pending.fetch.retry'), onClick: onRetry }] } : {}),
  };
  return <MessageBar items={[item]} />;
}

/**
 * Composer 槽位：权限卡 / ask 卡 / 输入框三选一（0.18）。
 * 待处理请求串行展示第一项，其余作为队列摘要。
 */
export function ComposerSlot({
  pendingItem,
  pendingItems,
  queueChips,
  responding,
  connected,
  onStop,
  stopping,
  onDecide,
  onRespondAsk,
  value,
  onChange,
  onSubmit,
  submitting,
  targetLabel,
  hasToken,
  onOpenConnection,
  focusSignal,
  refs,
  onRemoveRef,
  onAddRef,
  client,
  contextUsage,
  memberModel,
  sessionId,
  pendingFetch,
  onRetryPendingFetch,
  sessionRefs,
  onRemoveSessionRef,
  onAddSessionRef,
  currentScope,
}: {
  pendingItem: PendingQueueItem | null;
  pendingItems: readonly PendingQueueItem[];
  queueChips: readonly PromptQueueChip[];
  responding: ReadonlySet<string>;
  connected: boolean;
  onStop?: () => void;
  stopping: boolean;
  onDecide: (requestId: string, decision: 'allow' | 'deny', scope: PermissionScope) => void;
  onRespondAsk: (requestId: string, answers: AskUserAnswer[]) => void;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  targetLabel: string;
  hasToken: boolean;
  onOpenConnection: () => void;
  focusSignal: number;
  /** 待发送的附件引用（只有路径）；权限 / ask 卡替换输入框时不显示。 */
  refs?: readonly MessageRef[];
  /** 删除一条引用（下标即 refs 里的位置）。 */
  onRemoveRef?: (index: number) => void;
  /** 加一条引用（现有 addRef）：工具栏「引用文件」入口用；缺省时不渲染该入口。 */
  onAddRef?: (ref: MessageRef) => boolean;
  /** 目录浏览数据源（attachments.list）：与 onAddRef 一起决定是否出工具入口。 */
  client?: AttachBrowseClient;
  /** 发送键左侧的上下文用量；缺省（未知）时不渲染。 */
  contextUsage?: ComposerContextUsage;
  /** 会话归属成员的模型切换入口；透传给 Composer 工具栏（权限 / ask 卡替换输入框时不显示）。 */
  memberModel?: MemberModelSwitchProps;
  /** 当前会话 id（P3 思考强度菜单 sessionScoped write）；缺省（草稿态）按全局默认。 */
  sessionId?: string;
  /** `interactions.list` 本轮状态（0.59）：failed ⇒ 这里出一条可见提示。 */
  pendingFetch?: PendingFetchState;
  /** 重新拉 pending（提示条上的「重新拉取」）。 */
  onRetryPendingFetch?: () => void;
  /** 待发送的会话引用（拖拽会话卡产生）；透传给 Composer 引用区。 */
  sessionRefs?: readonly SessionRefChip[];
  /** 删除一条会话引用（下标即 sessionRefs 里的位置）。 */
  onRemoveSessionRef?: (index: number) => void;
  /** 加一条会话引用（Composer 的 drop 落点）；缺省不启用 drop 目标。 */
  onAddSessionRef?: (chip: SessionRefChip) => boolean;
  /** 渐进披露基准（当前会话节点 / 团队）；透传给 Composer。 */
  currentScope?: SessionRefScope;
}) {
  // 提示条在**三种槽位之上**：权限卡 / ask 卡 / 输入框。拉不到 pending 时正是这三种
  // 都可能「什么都没有」的时刻，提示必须跟着槽位一起在。
  const notice = pendingFetch ? (
    <PendingFetchNotice pendingFetch={pendingFetch} onRetry={onRetryPendingFetch} />
  ) : null;

  const body =
    pendingItem && pendingItem.kind === 'permission' ? (
      <PermissionPrompt
        key={pendingItem.request.requestId}
        request={pendingItem.request}
        more={pendingItems.length - 1}
        busy={responding.has(pendingItem.request.requestId)}
        connected={connected}
        onStop={onStop}
        stopping={stopping}
        queue={queueChips}
        onDecide={(decision, scope) => onDecide(pendingItem.request.requestId, decision, scope)}
      />
    ) : pendingItem && pendingItem.kind === 'ask' ? (
      <AskPrompt
        key={pendingItem.request.requestId}
        request={pendingItem.request}
        otherPending={Math.max(
          0,
          pendingItems.length - Math.max(1, pendingItem.request.questions.length),
        )}
        busy={responding.has(pendingItem.request.requestId)}
        connected={connected}
        onStop={onStop}
        stopping={stopping}
        queue={queueChips}
        onSubmit={(answers) => onRespondAsk(pendingItem.request.requestId, answers)}
        onCancel={() => onRespondAsk(pendingItem.request.requestId, [])}
      />
    ) : (
      <Composer
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        submitting={submitting}
        targetLabel={targetLabel}
        hasToken={hasToken}
        connected={connected}
        onOpenConnection={onOpenConnection}
        focusSignal={focusSignal}
        onStop={onStop}
        stopping={stopping}
        refs={refs}
        onRemoveRef={onRemoveRef}
        onAddRef={onAddRef}
        client={client}
        contextUsage={contextUsage}
        memberModel={memberModel}
        sessionRefs={sessionRefs}
        onRemoveSessionRef={onRemoveSessionRef}
        onAddSessionRef={onAddSessionRef}
        currentScope={currentScope}
        sessionId={sessionId}
      />
    );

  if (notice === null) return body;
  return (
    <>
      {notice}
      {body}
    </>
  );
}
