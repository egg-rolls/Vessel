/**
 * 「已答」记录：把服务端已落盘的 answered ask 变成一张可读的答复卡（纯函数）。
 *
 * 为什么需要这一层：sync（工具默认模式）答完之后**从不产生答复卡** —— 时间线上只剩一条
 * ask 工具结果行，服务端 interactions-<tenant>.json 里那条 answered 记录（questions +
 * answer.answers + answered_at）Web 从来没人读回。于是「我问了什么、我答了什么」在刷新
 * 之后只剩一行工具输出，没有身份（见 docs/dev/reports/0.51/ask-interaction-design.md 1.1
 * 的第四张卡与 1.2-S4）。
 *
 * 数据来源只有一个：`interactions.list{status:'answered', session_id}` —— 那是**落盘的
 * 真相**，刷新 / 重连 / 换端都能重建。本模块不发明新协议字段，只做映射：
 * - `questions`（记录里的 input）与 `answer.answers` 都是既有 DTO 的既有字段；
 * - 产出形状直接复用 `ask-answer.ts` 的 `AskAnswerCard`（async 那条 user 消息解析出来的
 *   也是它），所以渲染能用同一张卡，不新造样式。
 *
 * 两条刻意不显示：
 * - `mode === 'async'`：它的答案**已经**是时间线上那条 `ask:answer` 消息（同一张卡），
 *   这里再画一张就是两张一样的卡；
 * - `answers` 为空（人点了取消 / 被 policy 收口）：没有「答了什么」，画出来只会让
 *   「我问了什么、我答了什么」里的后半句是空的。
 */
import type { ListedInteraction } from '../../gateway/interaction-hydration';
import type { AskAnswerCard, AskAnswerRow } from './ask-answer';

/** 一条已答记录 → 一张答复卡。 */
export interface AnsweredAsk {
  requestId: string;
  /** 服务端记录的回答时间（Unix ms）；缺 `answered_at` 时回退 `created_at`。 */
  answeredAt: number;
  card: AskAnswerCard;
}

/** 摘要上限：与 `ask-answer.ts` 的卡头一致（超过就截断，别把卡头撑成一行正文）。 */
const SUMMARY_MAX = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * `answer.answers` → 卡片行。
 *
 * 优先用答案行自带的 `question`；老记录（0.52 前）只有 `header`，此时按 `header` 从
 * `questions` 里找回原问题 —— 找回失败就不印问题（绝不错配一行别的问题）。
 */
function answerRows(answers: unknown, questions: unknown): AskAnswerRow[] {
  if (!Array.isArray(answers)) return [];
  const byHeader = new Map<string, string>();
  if (Array.isArray(questions)) {
    for (const question of questions) {
      if (!isRecord(question)) continue;
      const header = nonEmptyString(question.header);
      const text = nonEmptyString(question.question);
      if (header !== undefined && text !== undefined && !byHeader.has(header)) {
        byHeader.set(header, text);
      }
    }
  }
  const rows: AskAnswerRow[] = [];
  for (const answer of answers) {
    if (!isRecord(answer)) continue;
    const text = nonEmptyString(answer.answer);
    if (text === undefined) continue;
    const label = nonEmptyString(answer.header) ?? nonEmptyString(answer.question);
    if (label === undefined) continue;
    const own = nonEmptyString(answer.question);
    const question = own ?? byHeader.get(label);
    rows.push({ label, text, ...(question !== undefined ? { question } : {}) });
  }
  return rows;
}

/** 一条 `interactions.list` 记录 → 答复卡；不值得画一张卡的已答 ask 返回 undefined。 */
export function answeredAsk(item: ListedInteraction): AnsweredAsk | undefined {
  if (item.kind !== 'ask') return undefined;
  if (item.status !== 'answered') return undefined;
  // async 的答案在时间线上已有 `ask:answer` 消息卡（同一份数据），这里跳过避免重复。
  if (item.mode === 'async') return undefined;
  const requestId = nonEmptyString(item.request_id);
  if (requestId === undefined) return undefined;

  const rows = answerRows(item.answer?.answers, item.questions);
  if (rows.length === 0) return undefined;

  const first = rows[0];
  if (first === undefined) return undefined;
  const label = first.label.trim();
  const summary = label.length > SUMMARY_MAX ? `${label.slice(0, SUMMARY_MAX)}…` : label;
  const answeredAt =
    item.answer !== undefined && Number.isFinite(item.answer.answered_at)
      ? item.answer.answered_at
      : item.created_at;

  return {
    requestId,
    answeredAt,
    card: { requestId, summary, rows },
  };
}

/**
 * 一批记录 → 已答卡（去重、按回答时间升序：先发生的先出现，最新的一条在最后）。
 *
 * `sessionId` 给了就再按会话断一次（服务端 `session_id` 过滤之外的第二道）：旧 gateway
 * 可能忽略未识别参数，把别的会话的已答记录一起返回 —— 那是本单最不能出的错（串台）。
 * 没有 `session_id` 的记录同样不显示：归属不明的东西宁可不画。
 */
export function answeredAsks(
  items: readonly ListedInteraction[],
  sessionId?: string,
): AnsweredAsk[] {
  const seen = new Set<string>();
  const cards: AnsweredAsk[] = [];
  for (const item of items) {
    if (sessionId !== undefined && item.session_id !== sessionId) continue;
    const record = answeredAsk(item);
    if (record === undefined || seen.has(record.requestId)) continue;
    seen.add(record.requestId);
    cards.push(record);
  }
  cards.sort((a, b) => (a.answeredAt === b.answeredAt ? 0 : a.answeredAt - b.answeredAt));
  return cards;
}

/** 默认只画最近几条：会话页底部不是「回答历史」页面，长会话不该被它占满。 */
export const ANSWERED_ASKS_VISIBLE = 3;

/** 取末尾若干条给默认视图，返回被折叠的条数（调用方决定要不要给「展开」入口）。 */
export function recentAnsweredAsks(
  cards: readonly AnsweredAsk[],
  visible = ANSWERED_ASKS_VISIBLE,
): { shown: readonly AnsweredAsk[]; hidden: number } {
  if (cards.length <= visible) return { shown: cards, hidden: 0 };
  return { shown: cards.slice(cards.length - visible), hidden: cards.length - visible };
}
