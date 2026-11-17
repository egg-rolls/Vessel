/**
 * 一条「本地待确认」的用户气泡（0.56 乐观渲染）。
 *
 * 它与落盘后的用户气泡**同一个视觉家族**（`.msg-user` + `.msg-bubble`，几何完全一致），
 * 只是身份上「还没落地」，所以底色 / 文字走 amber（`tokens.css` 里 `--amber` 就是
 * 「还没完成」那一支，注释点名的用处之一正是「未发送 / 排队中」），右侧一行状态字说明
 * 它在哪一段：
 * - `sending`：`chat.pendingSend.sending`（「发送中…」）—— **点击那一帧就在屏上**；
 * - `queued`：`chat.pendingSend.queued`（「已排队，前面还有一轮」）—— 不按超时判失败；
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
import type { PendingSend } from './pending-sends';

export function PendingBubble({
  pending,
  onRetry,
  onDismiss,
}: {
  pending: PendingSend;
  /** 重试：**复用同一条 pending**（同一个 id），不是新开一条。 */
  onRetry?: (pending: PendingSend) => void;
  /** 删除：这条从屏上消失（服务端没收到任何东西，不会留孤儿）。 */
  onDismiss?: (pending: PendingSend) => void;
}) {
  const failed = pending.state === 'failed';
  // 超时自带一句人话（「15 秒没有回显」比 `timeout` 这个内部词有用）；RPC 失败带原始错误。
  const reason =
    pending.failure === undefined || pending.failure === 'timeout' ? undefined : pending.failure;
  return (
    <div className="msg-user msg-pending msg-enter">
      <div className="msg-bubble msg-pending-bubble">{pending.text}</div>
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
            {pending.state === 'queued'
              ? t('chat.pendingSend.queued')
              : t('chat.pendingSend.sending')}
          </span>
        )}
      </div>
    </div>
  );
}
