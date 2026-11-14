/**
 * 启动恢复的「判定核心」（0.52 S1c）：纯函数、零 IO。
 *
 * 分工：
 * - 本模块只回答三个问题——**这张卡是不是已经发过了**（幂等去重键）、
 *   **这张卡是否已被准入**（落成消息且随请求进了模型上下文）、
 *   **哪些会话该恢复**（有标记、没有被显式留弃）。
 * - 真正发卡 / 清标记 / 重放输入的 IO 在装配层（`src/node-resume.ts`），
 *   标记的写仍然只经 RunJournal 单写口。
 *
 * 去重键为什么是「run_id + interrupted_at 同时出现在文本里」：
 * 卡片的文案要同时给用户读、给模型读（用户裁定：一张卡、两边同源），
 * 所以不能在正文里塞一个只能给机器看的 tag。run_id 是 Run 的唯一标识，
 * interrupted_at 以 ISO 出现在同一条文案里，两者同时命中一条 `vessel:notice`
 * 消息，只可能是同一张重启恢复卡——备案在案、与 UI 语言无关。
 *
 * @module @vessel-agent/core/runtime
 */

import type { SessionEventRecord } from '../types/event.js';
import type { Message } from '../types/provider.js';
import type { ResumeAfterRestart, SessionState } from '../types/session.js';

/** 卡片注入用的 notice 消息发送者（与其它环境信息同一条通道，见 env-info-scope）。 */
export const RESTART_CARD_SENDER = 'vessel:notice';

/** 重启恢复卡的机器可读身份（= 幂等去重键）。 */
export interface RestartCardKey {
  run_id: string;
  interrupted_at: number;
}

/** 从标记里取出幂等键。 */
export function restartCardKey(marker: RestartCardKey): string {
  return `${marker.run_id}@${marker.interrupted_at}`;
}

/** 打断时刻的 ISO 形式（文案里出现的那一份，也是去重匹配用的那一份）。 */
export function restartInterruptedIso(marker: RestartCardKey): string {
  return new Date(marker.interrupted_at).toISOString();
}

function messageTextOf(message: Message): string {
  // 内容可能是字符串，也可能是 content-part 数组（历史/多模态）。先按 unknown 收窄，
  // 否则 Array.isArray 作用在声明为 string 的字段上会被 TS 窄化成 never。
  const content: unknown = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part === null || typeof part !== 'object') return '';
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('\n');
}

/**
 * 这条消息是不是某个标记的「重启恢复卡」。
 *
 * 判据：发送者是 `vessel:notice`（环境信息通道），且文本里同时出现 run_id 与
 * 被打断时刻的 ISO —— 这两样只会是同一张卡的内容。
 */
export function isRestartCardMessage(message: Message, marker: RestartCardKey): boolean {
  if (message.name !== RESTART_CARD_SENDER) return false;
  const text = messageTextOf(message);
  if (text === '') return false;
  return text.includes(marker.run_id) && text.includes(restartInterruptedIso(marker));
}

/** 一条事件记录里可能携带的消息（注入事件 / 上下文变更事件两种形状）。 */
function messageOfRecord(record: SessionEventRecord): Message | undefined {
  const data = record.data;
  if (data === null || typeof data !== 'object') return undefined;
  const message = (data as { message?: unknown }).message;
  if (message === null || typeof message !== 'object') return undefined;
  const candidate = message as Message;
  return typeof candidate.role === 'string' ? candidate : undefined;
}

/** 事件日志里是否已有这张卡（= 已经发过了，不要发第二张）。 */
export function findRestartCardRecord(
  records: readonly SessionEventRecord[],
  marker: RestartCardKey,
): SessionEventRecord | undefined {
  return records.find((record) => {
    const message = messageOfRecord(record);
    return message !== undefined && isRestartCardMessage(message, marker);
  });
}

/** 是否在 `afterSeq` 之后出现过一次 LLM 请求（= 上下文真的进了模型）。 */
function hasRequestAfter(records: readonly SessionEventRecord[], afterSeq: number): boolean {
  return records.some((record) => record.seq > afterSeq && record.type === 'llm.request');
}

/**
 * 卡片是否**已被准入**：已落成消息（`message.injected` 在事件日志里），
 * 且之后确实发出过至少一次 `llm.request`（随请求进了模型上下文）。
 *
 * 只有准入之后才允许清标记：读完就删扛不住「刚恢复又崩一次」。
 */
export function restartCardAdmitted(
  records: readonly SessionEventRecord[],
  marker: RestartCardKey,
): boolean {
  const card = findRestartCardRecord(records, marker);
  if (card === undefined) return false;
  return hasRequestAfter(records, card.seq);
}

/** 一个待恢复的会话（标记 + 身份）。 */
export interface RestartCandidate {
  session_id: string;
  marker: ResumeAfterRestart;
}

/**
 * 从会话状态里挑出「该恢复」的：有标记即可。
 *
 * 不做 close / left 之类的判断——那是装配层的事（它才知道这具 body 还能不能收卡），
 * 本模块只保证「有标记」这一个事实口径。
 */
export function restartCandidates(states: readonly SessionState[]): RestartCandidate[] {
  const candidates: RestartCandidate[] = [];
  for (const state of states) {
    const marker = state.resume_after_restart;
    if (marker === undefined) continue;
    if (typeof marker.run_id !== 'string' || marker.run_id === '') continue;
    if (typeof marker.interrupted_at !== 'number' || !Number.isFinite(marker.interrupted_at))
      continue;
    candidates.push({ session_id: state.session_id, marker });
  }
  return candidates;
}

/**
 * 清标记的守卫：只清**还是同一份标记**的那一个。
 *
 * 恢复期间如果该会话又被打断（新的 run_id / 新的 interrupted_at），
 * 那是新的一次崩溃，它的标记必须留着（下一次启动再发它自己的卡）。
 */
export function sameRestartMarker(
  current: ResumeAfterRestart | undefined,
  expected: RestartCardKey,
): boolean {
  if (current === undefined) return false;
  return current.run_id === expected.run_id && current.interrupted_at === expected.interrupted_at;
}
