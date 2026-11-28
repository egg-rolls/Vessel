/**
 * 一条「本地待确认」的用户气泡（0.56 乐观渲染）。
 *
 * **0.56 排队生命周期之后，这一层只画 `sending`**（见 `TranscriptWindow` 的过滤与
 * `pending-placement.ts#inConversationStream`）：`queued` 只在待处理条带、`failed` 回流到
 * 条带（带「重试 / 编辑」）、`sent` 之后由服务端回显接管成正常用户气泡。所以下面这些状态
 * 分支留在这里是**给直接渲染它的宿主**（设计预览 / 别的屏）用的，会话流不会走到
 * `queued` / `failed` 那两支 —— 别把它们当成「还有第二处展示位置」。
 *
 * 它与落盘后的用户气泡**同一个视觉家族**（`.msg-user` + `.msg-bubble`，几何完全一致），
 * 只是身份上「还没落地」，所以底色 / 文字走 amber（`tokens.css` 里 `--amber` 就是
 * 「还没完成」那一支，注释点名的用处之一正是「未发送 / 排队中」），右侧一行状态字说明
 * 它在哪一段：
 * - `sending`：`chat.pendingSend.sending`（「发送中…」）—— **点击那一帧就在屏上**；
 * - `queued`：`chat.pendingSend.queued` / `chat.pendingSend.queuedLong`（「已排队，前面还有
 *   一轮」；1 分钟起带分钟数）—— 不按 15 s 判失败，但 3 分钟仍未被认领就转「未发送 · 已排队超时」；
 * - `failed`：`chat.pendingSend.failed`（「未发送」）+ 原因 + 两颗小动作键（重试 / 删除）。
 *
 * 三条纪律（与 `pending-sends.ts` 的注释一一对应）
 * 1. **只画灰态，不画正文的第二份**：正文是用户自己敲的字，这里只负责「它已经在飞」；
 *    服务端回显一到，这条就从屏上消失（摘除在 store 里做，这里不判重）。
 * 2. **失败绝不静默消失**：`failed` 的气泡留在原位等人处置 —— 它不是 toast，不自动收。
 * 3. **不参与消息身份**：本组件只读 `PendingSend`，不碰 `inputsByRun` / transcript 身份。
 *
 * 为什么不用 `MessageActions`（历史气泡的 hover 工具条）：那一条是「对已落盘消息的动作」，
 * 而这里的气泡**还没落盘**，可做的只有「重发一次」或「扔掉」，语义不同且必须常驻可见。
 *
 * 为什么动作键是**文案**而不是图标：失败态这两颗键是唯一出口（不能藏在 hover 里、也不能
 * 只剩一个看不懂的图形）；`--amber` / `--danger` 只在状态字上出现，气泡正文保持正常可读。
 */

import { t } from '../../i18n';
import { MessageBlocks } from './block-views';
import { liftBlocks } from './lift-blocks';
import type { PendingSend } from './pending-sends';

export function PendingBubble({
  pending,
  onRetry,
  onDismiss,
  onJumpQuote,
}: {
  pending: PendingSend;
  /** 重试：**复用同一条 pending**（同一个 id），不是新开一条。 */
  onRetry?: (pending: PendingSend) => void;
  /** 删除：这条从屏上消失（服务端没收到任何东西，不会留孤儿）。 */
  onDismiss?: (pending: PendingSend) => void;
  /** 引用块点击跳转原消息（q-message-quote）；缺省引用块纯展示。 */
  onJumpQuote?: (messageId: string) => void;
}) {
  const failed = pending.state === 'failed';
  // 组装冲突解决（0.56）：两侧各有对方没有的东西，合并保留两者。
  // - 来自 `queued-lifecycle`：`queue_timeout` / `offline` 也是**人话已覆盖**的失败原因
  //   （条带里「未发送 · 排队超时 / 断线」由卡头统一给），不必再重复一行原始码；
  // - 来自 HEAD（本轮其它单）：排队**很久**要看得见 —— 1 分钟起把「已排队 N 分钟」写进状态字，
  //   节拍由 `PendingSendStore.sweep` 按整分钟推一次渲染（排队本身不产生事件）。
  const reason =
    pending.failure === undefined ||
    pending.failure === 'timeout' ||
    pending.failure === 'queue_timeout' ||
    pending.failure === 'defer_timeout' ||
    pending.failure === 'offline'
      ? undefined
      : pending.failure;
  const queuedMinutes =
    pending.state === 'queued' || pending.state === 'deferred'
      ? Math.floor((Date.now() - pending.createdAt) / 60_000)
      : 0;
  // 块提升（块 P0）：发送文本里的信封提升成块，与落盘后的气泡同形（同一管线）。
  // refs 一并交给管线（q-block-cardshell-unify）：token 卡 + chip 同一份去重。
  const { blocks, body } = liftBlocks({
    role: 'user',
    content: pending.text,
    ...(pending.refs !== undefined ? { refs: [...pending.refs] } : {}),
  });
  return (
    <div className="msg-user msg-pending msg-enter">
      <MessageBlocks blocks={blocks} render={{ onJumpQuote }} />
      {body.length > 0 && <div className="msg-bubble msg-pending-bubble">{body}</div>}
      <div className="msg-pending-meta">
        {failed ? (
          <>
            <span className="msg-pending-status is-failed">{t('chat.pendingSend.failed')}</span>
            {reason !== undefined && (
              <span className="msg-pending-reason" title={reason}>
                {reason}
              </span>
            )}
            {onRetry !== undefined && (
              <button type="button" className="msg-pending-action" onClick={() => onRetry(pending)}>
                {t('chat.pendingSend.retry')}
              </button>
            )}
            {onDismiss !== undefined && (
              <button
                type="button"
                className="msg-pending-action"
                onClick={() => onDismiss(pending)}
              >
                {t('chat.pendingSend.dismiss')}
              </button>
            )}
          </>
        ) : (
          <span className="msg-pending-status" role="status">
            {pending.state === 'queued' || pending.state === 'deferred'
              ? waitingStatusText(pending, queuedMinutes)
              : t('chat.pendingSend.sending')}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 「等」这一档的状态字（`queued` / `deferred`）。
 *
 * 会话流只画 `sending`（见 `pending-placement.ts`），所以这一支正常走不到这里；留着是为了
 * 让**直接渲染气泡的宿主**（设计预览 / 别的屏）不会把 `deferred` 说成「发送中…」——
 * 「服务端已收下、为什么还没跑」与「正在发」是两件事。
 */
function waitingStatusText(pending: PendingSend, minutes: number): string {
  if (pending.state === 'deferred') {
    const reason =
      pending.deferredReason === 'draining'
        ? t('chat.pendingSend.deferred.draining')
        : pending.deferredReason === 'rotate'
          ? t('chat.pendingSend.deferred.rotate')
          : pending.deferredReason === 'stopped'
            ? t('chat.pendingSend.deferred.stopped')
            : t('chat.pendingSend.deferred.other');
    return minutes >= 1
      ? t('chat.pendingSend.deferredLong', { reason, minutes })
      : t('chat.pendingSend.deferred', { reason });
  }
  return minutes >= 1
    ? t('chat.pendingSend.queuedLong', { minutes })
    : t('chat.pendingSend.queued');
}
