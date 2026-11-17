/**
 * 一条「本地待确认」的用户气泡（0.56 乐观渲染）。
 *
 * 它与落盘后的用户气泡**同一个视觉家族**（`.msg-user` + `.msg-bubble`），但整个气泡压到
 * 弱化色（`opacity`），右侧一行状态字说明它在哪一段：
 * - `sending`：`chat.pendingSend.sending`（「发送中…」）—— **点击那一帧就在屏上**；
 * - `queued`：`chat.pendingSend.queued`（「已排队，前面还有一轮」）—— 不按超时判失败；
 * - `failed`：`chat.pendingSend.failed`（「未发送」）+ 原因 + 两颗键（重试 / 删除）。
 *
 * 三条纪律（与 `pending-sends.ts` 的注释一一对应）
 * 1. **只画灰态，不画正文的第二份**：正文是用户自己敲的字，这里只负责「它已经在飞」；
 *    服务端回显一到，这条就从屏上消失（摘除在 store 里做，这里不判重）。
 * 2. **失败绝不静默消失**：`failed` 的气泡留在原位等人处置 —— 它不是 toast，不自动收。
 * 3. **不参与消息身份**：本组件只读 `PendingSend`，不碰 `inputsByRun` / transcript 身份。
 *
 * 为什么不用 `MessageActions`（历史气泡的 hover 工具条）：那一条是「对已落盘消息的动作」，
 * 而这里的气泡**还没落盘**，可做的只有「重发一次」或「扔掉」，语义不同且必须常驻可见。
 */

import { cn, Icon } from '../../components/ui';
import { t } from '../../i18n';
import { composerIconControlClass, composerQuietIconTone } from './composer-controls';
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
  return (
    <div className={cn('msg-user msg-enter flex max-w-full flex-col items-end gap-1')}>
      <div className={cn('msg-bubble', failed ? 'opacity-70' : 'opacity-60')}>{pending.text}</div>
      <div className="flex items-center justify-end gap-2 text-xs">
        {failed ? (
          <>
            <span className="text-danger">{t('chat.pendingSend.failed')}</span>
            {pending.failure !== undefined && pending.failure !== 'timeout' && (
              <span className="text-muted" title={pending.failure}>
                {pending.failure}
              </span>
            )}
            {onRetry !== undefined && (
              <button
                type="button"
                className={cn(composerIconControlClass, composerQuietIconTone)}
                aria-label={t('chat.pendingSend.retry')}
                title={t('chat.pendingSend.retry')}
                onClick={() => onRetry(pending)}
              >
                <Icon name="retry" size={14} />
              </button>
            )}
            {onDismiss !== undefined && (
              <button
                type="button"
                className={cn(composerIconControlClass, composerQuietIconTone)}
                aria-label={t('chat.pendingSend.dismiss')}
                title={t('chat.pendingSend.dismiss')}
                onClick={() => onDismiss(pending)}
              >
                <Icon name="archive" size={14} />
              </button>
            )}
          </>
        ) : (
          <span className="text-muted" role="status">
            {pending.state === 'queued'
              ? t('chat.pendingSend.queued')
              : t('chat.pendingSend.sending')}
          </span>
        )}
      </div>
    </div>
  );
}
