/**
 * Agent→agent 消息卡：A2A 投递进本会话的那条输入。
 *
 * 入参与来源无关（`sender` + `content` + `ts`），历史消息与运行态首帧共用同一张卡：
 * - 历史侧：`sessions.get` 的 `Message`（`name: 'agent:<alias>'`）；
 * - 运行态：`run.started` 的 `input_name`（首帧就可能到，见 `state/events.ts`），
 *   所以「先闪一帧用户气泡再变卡」不再可能——没有中间态可闪。
 *
 * 身份判定只在 `agent-sender.ts`（`agentSenderOfName` / `AGENT_MESSAGE_PREFIX`）一处。
 *
 * 只做展示：视觉与「系统消息 / 原始事件」同族（`.event-block` 折叠行 —— muted 单行 +
 * chevron），不是用户气泡：这条消息不是坐在键盘前的人说的。默认一行缩略（发送者 +
 * 正文打头），点开看全文；`<details>` 原生可访问（summary 可 Tab 聚焦、Enter/Space 展开）。
 *
 * 历史消息没有 `name`（0.50 之前投递的 A2A 消息），继续按用户气泡渲染，不做回填。
 */
import { cn } from '../../components/ui';
import { formatClock } from '../../format';
import type { Message } from '../../gateway/types';
import { t } from '../../i18n';
import { type MessageSender, senderOfName } from './agent-sender';
import { StreamCard } from './StreamCard';

/**
 * 这条消息是否 agent / 工具发来的；是则返回卡身份（kind + alias）。
 * 名字 → 身份的解析只在 `agent-sender.ts`，这里只做 `Message` 到 `name` 的取值。
 */
export function agentMessageSender(message: Message): MessageSender | undefined {
  return senderOfName(message.name);
}

export function AgentMessageCard({
  sender,
  senderKind = 'agent',
  content,
  ts,
  source,
  defaultOpen = false,
  entering = false,
}: {
  /** 发送者 alias（不含 `agent:` / `tool:` 前缀）。 */
  sender: string;
  /**
   * 来源类别：`agent` = A2A 投递（卡头「来自 agent X」）；
   * `tool` = 工具来源投递（卡头「来自 X」，如异步 bash 完成的「来自 bash」）。
   * 缺省 `agent`：存量调用点都是 A2A。
   */
  senderKind?: 'agent' | 'tool';
  /** 正文（与 `Message.content` / `run.started.input` 同源）。 */
  content: string;
  /** 消息时间（Unix ms）；生命周期时间在卡片展开体里，缺省不显示。 */
  ts?: number;
  /**
   * A2A 来源地址（来自紧邻的 `vessel:source` 行）。
   *
   * 来源行不再单独成行：它被**吸入这张卡**——地址进展开体首行（等宽 / 可选中 / break-all），
   * 卡片表面只留「来自 agent <alias>」。默认折叠时看不到长地址，需要时展开即可。
   */
  source?: string;
  /** 默认展开（ui.expandCards || verbosity === 'debug'）；手动开合优先。 */
  defaultOpen?: boolean;
  /** 本帧才追加进来的项：入场只播一次（判定见 `useEnteringItemKeys`）。 */
  entering?: boolean;
}) {
  const clock = formatClock(ts);
  // 卡头文案按来源类别分：agent 投递带「agent」字样，工具来源只报工具名（「来自 bash」）。
  const fromKey = senderKind === 'tool' ? 'chat.toolMessage.from' : 'chat.agentMessage.from';
  const groupKey = senderKind === 'tool' ? 'chat.toolMessage.group' : 'chat.agentMessage.group';
  return (
    <StreamCard
      className={cn('agent-message', entering && 'msg-enter')}
      ariaLabel={t(groupKey, { name: sender })}
      defaultOpen={defaultOpen}
      title={
        <span className="max-w-56 truncate font-mono text-2xs tracking-wider text-accent">
          {t(fromKey, { name: sender })}
        </span>
      }
      summary={content}
    >
      {(source !== undefined || clock !== '') && (
        // 详细地址（+ 时间）只在这里出现：等宽、可整段选中、长地址按字符断行。
        <div className="mb-1 flex flex-wrap items-baseline gap-x-2 font-mono text-2xs text-faint">
          {source !== undefined && (
            <span className="break-all select-all" title={source}>
              {source}
            </span>
          )}
          {clock !== '' && (
            <time className="shrink-0 tabular-nums" dateTime={new Date(ts ?? 0).toISOString()}>
              {clock}
            </time>
          )}
        </div>
      )}
      {/* 卡头已经是「单行摘要 + 展开看全文」的那一层，展开体里直接是全文：不再套
          `MessageFold`（卡片有底色，但它是「卡片」不是气泡，按折叠口径
          「有背景包裹的气泡才折」不折；两级结构仍由 StreamCard 提供）。 */}
      <p className="m-0 whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed text-ink">
        {content}
      </p>
    </StreamCard>
  );
}
