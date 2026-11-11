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
 * 只认 `agent:` 前缀：`vessel:*` 仍归 runtime 上下文的可见性开关管
 * （见 `state/runtime-visibility.ts`）。
 *
 * @module
 */

/** runtime 写入的前缀；alias 已 sanitize 成 `[A-Za-z0-9_-]`。 */
export const AGENT_MESSAGE_PREFIX = 'agent:';

/**
 * 消息名 → 发送者 alias；不是 agent 投递返回 undefined。
 *
 * 空 alias（`agent:`）按非 agent 处理：宁可按人说的话显示，也不给一张没有署名的卡。
 */
export function agentSenderOfName(name: string | undefined): string | undefined {
  if (typeof name !== 'string' || !name.startsWith(AGENT_MESSAGE_PREFIX)) return undefined;
  const alias = name.slice(AGENT_MESSAGE_PREFIX.length);
  return alias.length > 0 ? alias : undefined;
}
