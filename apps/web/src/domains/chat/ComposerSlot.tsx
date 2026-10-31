import type { AskUserAnswer, PermissionScope } from '../../gateway/types';
import { Composer } from './Composer';
import { AskPrompt, PermissionPrompt, type PromptQueueChip } from './PromptSlots';
import type { PendingQueueItem } from './pending-permissions';

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
}) {
  if (pendingItem && pendingItem.kind === 'permission') {
    return (
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
    );
  }
  if (pendingItem && pendingItem.kind === 'ask') {
    return (
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
    );
  }
  return (
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
    />
  );
}
