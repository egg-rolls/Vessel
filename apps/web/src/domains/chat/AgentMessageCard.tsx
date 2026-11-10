/**
 * Agent→agent 消息卡：A2A 投递进本会话的那条 user 消息（runtime 给它写了
 * `name: 'agent:<alias>'`，见 `packages/agent/src/runtime.ts` 的 `agentInputName`）。
 *
 * 只做展示：视觉与「系统消息 / 原始事件」同族（`.event-block` 折叠行 —— muted 单行 +
 * chevron），不是用户气泡：这条消息不是坐在键盘前的人说的。默认一行缩略（发送者 +
 * 正文打头），点开看全文；`<details>` 原生可访问（summary 可 Tab 聚焦、Enter/Space 展开）。
 *
 * 历史消息没有 `name`（0.50 之前投递的 A2A 消息），继续按用户气泡渲染，不做回填。
 */
import { Icon } from '../../components/ui';
import { formatClock } from '../../format';
import type { Message } from '../../gateway/types';
import { t } from '../../i18n';

/** runtime 写入的前缀；alias 已 sanitize 成 `[A-Za-z0-9_-]`。 */
const AGENT_MESSAGE_PREFIX = 'agent:';

/**
 * 这条消息是否 agent 发来的；是则返回发送者 alias。
 * 只认 `agent:` 前缀：`vessel:*` 仍归 runtime 上下文的可见性开关管。
 */
export function agentMessageSender(message: Message): string | undefined {
  const name = message.name;
  if (typeof name !== 'string' || !name.startsWith(AGENT_MESSAGE_PREFIX)) return undefined;
  const alias = name.slice(AGENT_MESSAGE_PREFIX.length);
  return alias.length > 0 ? alias : undefined;
}

export function AgentMessageCard({ message, sender }: { message: Message; sender: string }) {
  const clock = formatClock(message.timestamp);
  return (
    <details
      className="event-block agent-message"
      aria-label={t('chat.agentMessage.group', { name: sender })}
    >
      <summary className="event-block-summary">
        <span className="max-w-56 shrink-0 truncate font-mono text-2xs tracking-wider text-accent">
          {t('chat.agentMessage.from', { name: sender })}
        </span>
        {clock !== '' && (
          <time
            className="shrink-0 font-mono text-2xs tabular-nums text-faint"
            dateTime={new Date(message.timestamp ?? 0).toISOString()}
          >
            {clock}
          </time>
        )}
        <span className="event-block-preview">{message.content}</span>
        <span className="event-block-toggle">
          <span className="event-toggle-expand sr-only">{t('chat.event.expand')}</span>
          <span className="event-toggle-collapse sr-only">{t('chat.event.collapse')}</span>
          <Icon name="chevron" className="event-toggle-icon" />
        </span>
      </summary>
      <div className="event-block-body">
        <p className="m-0 whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed text-ink">
          {message.content}
        </p>
      </div>
    </details>
  );
}
