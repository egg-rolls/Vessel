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
 * 三条刻意不显示：
 * - `mode === 'async'`：它的答案**已经**是时间线上那条 `ask:answer` 消息（同一张卡），
 *   这里再画一张就是两张一样的卡；
 * - `answers` 为空（人点了取消 / 被 policy 收口）：没有「答了什么」，画出来只会让
 *   「我问了什么、我答了什么」里的后半句是空的；
 * - 连时间都取不到（见 `answeredAsk` 的 `answeredAt`）：落位不可信，宁可不画。
 *
 * 位置（0.51 用户裁决）：这些记录**按 `answered_at` 落进时间线内部**（item kind
 * `ask-answered`，与消息 item 共用同一套 ts 排序），不再是会话滚动区末尾的额外一段。
 * 所以本模块不提供「只画最近几条」的裁剪 —— 那是「底部区块」的产物，时间线自己会滚。
 */
import type { ListedInteraction } from '../../gateway/interaction-hydration';
import type { AskAnswerCard, AskAnswerRow } from './ask-answer';

/** 一条已答记录 → 一张答复卡。 */
export interface AnsweredAsk {
  requestId: string;
  /**
   * 服务端记录的回答时间（Unix ms）：**排序 ts**，决定这张卡插在时间线的哪个点。
   *
   * 取值口径（缺字段时的取舍写在 `answeredAsk` 里）：有 `answer.answered_at` 就用它
   * （「答的那一瞬」才是这一问在历史上真正的位置），否则回退 `created_at`
   * （问出来的时刻 —— 比正确答案早一点，但仍然是这条记录的真实时刻，比「排到最后」准）。
   */
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
 * 可用的时间戳（Unix ms）；非数字 / NaN / Infinity 一律当「没有这个时间」。
 *
 * 为什么不用 `Number.isFinite` 直接判：它不收窄类型，调用侧要写 `as number` 把宽松的
 * 载荷强行断言成数字 —— 旧 gateway / 旧记录里那个字段完全可能就是 undefined / 字符串。
 */
function finiteOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
  // 排序 ts：`answered_at` 权威（答的那一瞬），其次 `created_at`（问出来的时刻）。
  // 两个都取不到（NaN / 非有限 / 旧格式）⇒ **不画**：时间线 item 没有 ts 就只剩
  // 「沉到会话末尾」这一种落位，那会把一条几小时前的问答摆到最新消息之后 —— 位置错了
  // 比少一张卡更误导（同 `ask-answer.ts` 的「宁可少一张卡，也不吞正文」取舍的反面：
  // 这里吞的不是正文，正文本来就没有别的入口，但位置必须可信）。
  const answeredAt = finiteOf(item.answer?.answered_at) ?? finiteOf(item.created_at);
  if (answeredAt === undefined) return undefined;

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
 *
 * 排序在这里做完（而不是交给调用方）：时间线只负责把 `answeredAt` 当 ts 用，同一毫秒的
 * 多条记录靠**这个升序 + 稳定排序**定序 —— 重建两次的顺序必须一模一样，否则刷新会跳。
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
