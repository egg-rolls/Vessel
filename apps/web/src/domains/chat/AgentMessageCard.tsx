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
import { formatClock } from '../../format';
import type { Message } from '../../gateway/types';
import { t } from '../../i18n';
import { StreamCard } from './StreamCard';

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

export function AgentMessageCard({
  message,
  sender,
  source,
  defaultOpen = false,
}: {
  message: Message;
  sender: string;
  /**
   * A2A 来源地址（来自紧邻的 `vessel:source` 行）。
   *
   * 来源行不再单独成行：它被**吸入这张卡**——meta 里展示地址，正文就是消息本身，
   * 于是同一次投递只有一张卡、不会出现「来源行 + agent 卡」两条。
   */
  source?: string;
  /** 默认展开（ui.expandCards || verbosity === 'debug'）；手动开合优先。 */
  defaultOpen?: boolean;
}) {
  const clock = formatClock(message.timestamp);
  return (
    <StreamCard
      className="agent-message"
      ariaLabel={t('chat.agentMessage.group', { name: sender })}
      defaultOpen={defaultOpen}
      title={
        <span className="max-w-56 truncate font-mono text-2xs tracking-wider text-accent">
          {t('chat.agentMessage.from', { name: sender })}
        </span>
      }
      meta={
        source !== undefined || clock !== '' ? (
          <>
            {source !== undefined && (
              <span className="max-w-48 truncate" title={source}>
                {source}
              </span>
            )}
            {source !== undefined && clock !== '' && <span aria-hidden="true"> · </span>}
            {clock !== '' && <span>{clock}</span>}
          </>
        ) : undefined
      }
      summary={message.content}
    >
      <p className="m-0 whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed text-ink">
        {message.content}
      </p>
    </StreamCard>
  );
}
