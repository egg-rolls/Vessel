/**
 * 「这条输入是谁说的」的**唯一**判定（A2A 身份）。
 *
 * runtime 给 A2A 投递的输入写 `name: 'agent:<alias>'`（见 `packages/agent/src/runtime.ts`
 * 的 `agentInputName`）。这条身份在两条数据路径上是同一个东西：
 * - 历史消息：`Message.name`（`sessions.get`）；
 * - 运行态首帧：`run.started` 的 `input_name`（旧 gateway 不发时为 undefined），
 *   随后 `user.message` 的 `message.name` 再确认一次。
 *
 * 两条路径共用本模块的前缀与解析，**不允许**在渲染层另写一份「按正文猜身份」或
 * 第二个 `startsWith('agent:')`：猜错就把人说的话画成卡，或者把卡画成人的话。
 *
 * 认 `agent:`（A2A）与 `tool:`（工具来源投递，如异步 bash 完成）两个前缀；
 * `vessel:*` 仍归 runtime 上下文的可见性开关管（见 `state/runtime-visibility.ts`）。
 *
 * @module
 */

/** runtime 写入的前缀；alias 已 sanitize 成 `[A-Za-z0-9_-]`。 */
export const AGENT_MESSAGE_PREFIX = 'agent:';

/**
 * 工具来源投递的前缀（`tool:bash` = 异步 bash 作业完成投回本会话，见
 * `packages/agent/src/runtime.ts` 的 `BASH_JOB_INPUT_NAME`）。
 *
 * 与 `agent:` 同一族「不是人打的字」的卡身份：渲染复用同一张卡（AgentMessageCard），
 * 只有卡头文案不同（「来自 bash」而不是「来自 agent bash」）。判定仍只在本模块一处。
 */
export const TOOL_MESSAGE_PREFIX = 'tool:';

/** 卡身份：谁发来的（agent 投递 / 工具来源投递）。 */
export interface MessageSender {
  kind: 'agent' | 'tool';
  /** 发送者 alias（不含前缀）。 */
  alias: string;
}

/**
 * 消息名 → 卡身份；不是 agent / 工具投递返回 undefined。
 *
 * 空 alias（`agent:` / `tool:`）按非卡处理：宁可按人说的话显示，也不给一张没有署名的卡。
 */
export function senderOfName(name: string | undefined): MessageSender | undefined {
  if (typeof name !== 'string') return undefined;
  if (name.startsWith(AGENT_MESSAGE_PREFIX)) {
    const alias = name.slice(AGENT_MESSAGE_PREFIX.length);
    return alias.length > 0 ? { kind: 'agent', alias } : undefined;
  }
  if (name.startsWith(TOOL_MESSAGE_PREFIX)) {
    const alias = name.slice(TOOL_MESSAGE_PREFIX.length);
    return alias.length > 0 ? { kind: 'tool', alias } : undefined;
  }
  return undefined;
}

/**
 * 消息名 → 发送者 alias；不是 agent / 工具投递返回 undefined。
 *
 * 只要 alias、不区分来源类别的读点（是否成卡 / 发言人分组）用它；
 * 要按类别换卡头文案的读点用 `senderOfName`。
 */
export function agentSenderOfName(name: string | undefined): string | undefined {
  return senderOfName(name)?.alias;
}
