/**
 * 消息身份（0.51）：给落盘的 assistant 正文盖章「同一次 run 内第几段」。
 *
 * 存在理由：Web 时间线跨来源去重（认领）过去只能拿正文内容当代理键，而 Output 阶段
 * guardrail 会在落盘前改写正文（PII 打码：13 位数字的中间 7 位换成 `*`），
 * 于是实时流那份（原文）与落盘那份（打码后）内容不等 ⇒ 认不出是同一段 ⇒ 两份都渲染。
 * `run_id` + 段序是结构化事实：内容被怎么改写都不影响「这是同一段」。
 *
 * 为什么是「后置盖章」而不是写入时计数：
 * - **一个口径**：身份只在落盘（`RunJournal.saveSessionState`）与事件投影
 *   （`projectMessages`）两个出口盖章，两者共用本函数；写入点（`addContext`）
 *   只管 `run_id`，不维护计数器 —— 计数器分散在多处就等于多处可能漂移。
 * - **幂等 + 续编**：已经盖过的段序**永不重写**，新消息续在「该 run 已分配的最大
 *   段序 + 1」。压缩会把早期段整条删掉（摘要替换），若按「从头数第几个」重编，
 *   幸存段的段序就会整体前移 ⇒ 与 Web 侧流式段序错位；续编则天然不受影响。
 * - **resume 安全**：投影重建出来的消息同样由本函数盖章，所以 resume 不会把身份丢掉。
 *
 * 段序口径（与 Web 侧一致）：只数「role 是 assistant 且正文非空（trim 后）」的消息，
 * 0 起。只有 tool_calls、正文为空的那一轮不占号 —— 它在时间线上不产生正文段。
 *
 * @module @vessel-agent/core/session
 */

import type { Message } from '../types/provider.js';

/**
 * 用户输入的稳定 id（0.56）。
 *
 * 形状 `${runId}:user`：一次 run 只有一条用户输入，run id 又是服务端生成的 uuid，
 * 所以这个字符串**确定、可复算、跨进程一致**。确定性是刻意的 —— 同一条输入被执行
 * 两遍（重试 / 续跑 / 落盘写两次）拿到的是**同一个 id**，于是渲染层能把它当同一条
 * 消息合并，而不必去猜「这两段正文是不是一回事」。
 */
export function userMessageIdOf(runId: string): string {
  return `${runId}:user`;
}

/**
 * 注入消息（`RunOptions.messages`：skill / 附件 / 引用文件……）的稳定 id（0.56）。
 *
 * 形状 `${runId}:inject:${index}`：`index` 是它在这一次注入批次里的下标。同一个批次
 * 走两遍 ⇒ 同一个 id（同 `userMessageIdOf` 的理由）；不同批次的同名消息 ⇒ 不同 id。
 */
export function injectedMessageIdOf(runId: string, index: number): string {
  return `${runId}:inject:${String(index)}`;
}

/**
 * BeforeLlm hook 注入（`ctx.messages`：环境卡 / 收件箱提示 / Self Card delta …）的稳定 id。
 *
 * 为什么与 `RunOptions.messages` 分开命名空间：同一个 run 里两条通道都会从下标 0 开始
 * 数，共用一个前缀会让「第二批的第 0 条」与「第一批的第 0 条」撞成同一个身份 —— 撞号
 * 在渲染层就是一条被静默丢掉的消息（`hook:` 段是唯一的分界）。
 *
 * `index` 是这条消息在**本 run** 里第几批 hook 注入里的位置（`injectedHookSeq`，单调递增）。
 * 同一条 hook 消息在同一个 run 内只会写一次（`injectedMessageKeys` 去重），所以这个下标
 * 对「同一条消息」是可复算的。
 */
export function injectedHookMessageIdOf(runId: string, index: number): string {
  return `${runId}:inject:hook:${String(index)}`;
}

/**
 * 运行时提示（`appendNotice` / `appendNoticeToSnapshot`，`vessel:notice`）的稳定 id。
 *
 * `timestamp` 是提示**被创建**的那一刻，创建时定死、之后不再改写（`addContext` 也遵守
 * 「已有值不覆盖」）。用它与 run 段拼 id：同一条提示不论被谁来写（有 active run 的
 * `addContext` 还是无 run 的快照追加）都得到同一个字符串。
 */
export function noticeMessageIdOf(owner: string, timestamp: number): string {
  return `${owner}:notice:${String(timestamp)}`;
}

/**
 * 会话种子（`sessions.create --seed` / fork：把父会话的前缀复制成新会话的
 * `message.injected`）的稳定 id。
 *
 * 形状 `${sessionId}:seed:${index}`：新会话 id 是服务端生成的 uuid，种子批次在
 * `writeSeedEvents` 里一次写定、下标即顺序 —— 同批次重写一遍拿到同一个 id。
 * **已有 id 的种子消息原样保留**（`withMessageId` 只补缺）：从父会话复制来的消息
 * 携带的是它当初的身份，改写就是伪造。
 */
export function seedMessageIdOf(sessionId: string, index: number): string {
  return `${sessionId}:seed:${String(index)}`;
}

/**
 * async ask 答案**接续投递**（`src/ask-channel.ts` 直写 `user.message`）的稳定 id。
 *
 * 形状 `${runId}:ask:${requestId}`：`requestId` 是那次提问的 id，投递侧本来就拿它
 * 当「这条答案投过没有」的键 —— 同一条答案被补投两次拿到同一个 id。
 */
export function askAnswerMessageIdOf(runId: string, requestId: string): string {
  return `${runId}:ask:${requestId}`;
}

/**
 * 幂等守卫：同一 `message_id` 在一份 `messages` 里**最多一条**。
 *
 * 为什么需要它：`message_id` 是「同一条消息」的结构化事实（`${runId}:user` /
 * `${runId}:inject:<下标>` 这类确定式字符串）。同一条输入被写进上下文两次 —— 不管
 * 是哪条路径的锅 —— 在落盘这一处必然撞同一个 id。撞号就是**同一个身份的两份副本**，
 * 留一份不是「吞消息」，是把同一条消息写一次（正文逐字节相同；不同则说明 id 生成
 * 有 bug，所以只在正文相同的人才丢，并把这件事 warn 出来）。
 *
 * 口径（三条，缺一条就会误伤）：
 * - **只处理带 id 的消息**：旧数据（0.56 之前落盘）没有 id，一条都不动；
 * - **只丢**「同 id 且 role / name / content / tool_calls / refs 全同」的后者 ——
 *   正文不同 = id 生成错，宁可两都留并报出来，也不静默删掉一条真实内容；
 * - 返回新数组，**不动入参**：调用方传进来的往往是 live 窗口的 `messages`，
 *   就地 `splice` 会把运行中的上下文也改掉。
 *
 * 纯函数、无日志（调用方决定怎么报）。返回 `dropped` 的样本 id 供 warn 带出来。
 */
export function dropDuplicateMessageIds(messages: readonly Message[]): {
  messages: Message[];
  dropped: number;
  sample: string[];
} {
  const seen = new Map<string, Message>();
  const kept: Message[] = [];
  const sample: string[] = [];
  let dropped = 0;
  for (const message of messages) {
    const id = message.message_id;
    if (typeof id !== 'string' || id.length === 0) {
      kept.push(message);
      continue;
    }
    const previous = seen.get(id);
    if (previous === undefined) {
      seen.set(id, message);
      kept.push(message);
      continue;
    }
    if (sameMessageContent(previous, message)) {
      dropped += 1;
      if (sample.length < 5) sample.push(id);
      continue;
    }
    // 同 id 不同正文：身份生成有问题，但不许因此吞掉一条真实内容。
    kept.push(message);
  }
  return { messages: kept, dropped, sample };
}

/** 两条消息的**内容**是否相同（身份字段 `message_id` / `run_segment` 不参与比较）。 */
function sameMessageContent(left: Message, right: Message): boolean {
  if (left.role !== right.role) return false;
  if (left.content !== right.content) return false;
  if ((left.name ?? '') !== (right.name ?? '')) return false;
  if ((left.tool_call_id ?? '') !== (right.tool_call_id ?? '')) return false;
  const leftCalls = (left.tool_calls ?? [])
    .map((call) => `${call.id}:${call.function.name}:${call.function.arguments}`)
    .join('|');
  const rightCalls = (right.tool_calls ?? [])
    .map((call) => `${call.id}:${call.function.name}:${call.function.arguments}`)
    .join('|');
  if (leftCalls !== rightCalls) return false;
  const leftRefs = (left.refs ?? []).map((ref) => `${ref.kind}:${ref.path}`).join('|');
  const rightRefs = (right.refs ?? []).map((ref) => `${ref.kind}:${ref.path}`).join('|');
  return leftRefs === rightRefs;
}

/**
 * 给一条**正在进入会话**的消息盖 `message_id`（只补缺，不覆盖已有值）。
 *
 * 为什么只补缺：resume / 重放会把历史消息灌回来，那些 id 是当初落盘时的身份，改写就是
 * 伪造身份（还会把「同一条消息的两个副本」变回两个身份）。已经带 id 的消息原样返回，
 * 调用侧的引用身份不变。
 *
 * 与 `withRunIdentity` 的分工：`run_id` 是「归属哪次 run」（历史消息会被灌回上下文，
 * 归属是原来那次）；`message_id` 是「这是哪一条消息」（一条消息一个，全局唯一）。
 */
export function withMessageId(message: Message, messageId: string): Message {
  if (typeof message.message_id === 'string' && message.message_id.length > 0) return message;
  if (messageId.length === 0) return message;
  return { ...message, message_id: messageId };
}

/** 该消息是否占用一个正文段号（口径见文件头注释）。 */
function occupiesSegment(message: Message): boolean {
  return message.role === 'assistant' && message.content.trim().length > 0;
}

/**
 * 给一条**正在写入上下文**的消息盖 `run_id`（只补缺，不覆盖已有值）。
 *
 * 为什么不覆盖：resume / rotate 会先把历史消息灌回上下文，那些消息的身份属于**原来那次
 * run**，被当前 runId 改写就是伪造归属（历史那轮的正文段会认不出来）。同理，已经带
 * `run_id` 的消息一律原样返回 —— 不产生副本，调用侧引用身份不变。
 */
export function withRunIdentity(message: Message, runId: string): Message {
  if (typeof message.run_id === 'string' && message.run_id.length > 0) return message;
  if (runId.length === 0) return message;
  return { ...message, run_id: runId };
}

/**
 * 给一批消息补上 `run_segment`（原地写入；只补缺，不改已有值）。
 *
 * 调用点必须保证「同一批消息按会话顺序排列」（`state.messages` / 投影结果都是），
 * 否则「最大段序 + 1」的续编会给出与流式侧不一致的号。
 */
export function assignMessageIdentities(messages: readonly Message[]): void {
  if (messages.length === 0) return;
  /** run_id → 已分配的最大段序（缺省 = 该 run 还没有正文段）。 */
  const lastByRun = new Map<string, number>();
  for (const message of messages) {
    const runId = message.run_id;
    if (typeof runId !== 'string' || runId.length === 0) continue;
    if (!occupiesSegment(message)) continue;
    const assigned = message.run_segment;
    const known = lastByRun.get(runId);
    if (typeof assigned === 'number' && Number.isFinite(assigned)) {
      // 已盖章：只把水位抬到它（压缩 / 重投影都可能是「中间缺了几段」的形状）。
      lastByRun.set(runId, known === undefined ? assigned : Math.max(known, assigned));
      continue;
    }
    const next = known === undefined ? 0 : known + 1;
    message.run_segment = next;
    lastByRun.set(runId, next);
  }
}
