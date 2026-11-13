/**
 * ask 的「答案载荷」与「这次提交收口了没有」—— 纯函数，零 React / DOM / i18n 依赖。
 *
 * 为什么单独一层（用户裁决）：一次提交可以只答一部分题，服务端把「还剩哪几题」回在
 * `ask.respond` 的返回体里。**卡片的生死由这个返回体决定**，不是由「提交成功」决定 ——
 * 只要还有题没答，请求就仍是 pending，卡片必须留在待批页。
 *
 * 放在 `gateway/` 而不是 `domains/pending/`：后者是草稿 / 卡片呈现的作业区，这里只做
 * 「草稿 → 载荷」与「返回体 → 要不要收卡片」两件与协议对齐的事，两边都能直接用。
 *
 * @module web/gateway/ask-answers
 */

import type { AskUserAnswer, AskUserQuestion } from './types';

/**
 * 多选选项拼成 `answer` 文本时的分隔符。
 *
 * 与 `domains/chat/AskCard.tsx` 的既有 Web 文本保持一致（` · `）—— `answer` 是给模型
 * 读的渲染结果，换分隔符等于换模型看到的内容；真要统一两端的写法是另一件事。
 * `selected` 才是结构化真相：卡片渲染 chips、判定「选了几项」都读它。
 */
export const ASK_ANSWER_OPTION_SEPARATOR = ' · ';

/** 题 id：事件里带了就用，没带按题序推（与工具 / 服务端同一条规则）。 */
export function askQuestionId(question: AskUserQuestion, index: number): string {
  const explicit = typeof question.id === 'string' ? question.id.trim() : '';
  return explicit === '' ? `q${index + 1}` : explicit;
}

/** 单题草稿：已选选项 + 自由输入。 */
export interface AskAnswerDraft {
  selected: readonly string[];
  custom: string;
}

/**
 * 单题草稿 → `ask.respond` 的一条答案。
 *
 * 三个字段各有分工：`question_id` 让服务端把答案挂到**题**上（未答的题不随这次提交
 * 被带走），`selected` 保住多选的结构（不压成一段带分隔符的文本），`answer` 仍是
 * 人读得懂、模型也读得懂的那一句。
 */
export function buildAskAnswer(
  question: AskUserQuestion,
  draft: AskAnswerDraft,
  index: number,
): AskUserAnswer {
  const custom = draft.custom.trim();
  const selected = [...draft.selected];
  const parts = [...selected, ...(custom === '' ? [] : [custom])];
  return {
    question_id: askQuestionId(question, index),
    header: question.header,
    question: question.question,
    answer: parts.join(ASK_ANSWER_OPTION_SEPARATOR),
    ...(selected.length > 0 ? { selected } : {}),
  };
}

/**
 * `ask.respond` 的返回体里我们关心的那部分（服务端 additive；旧 gateway 不返回）。
 *
 * 只声明用得到的键：这是**读**侧契约，多声明一个字段就等于替服务端许下一个承诺。
 */
export interface AskRespondOutcome {
  ok?: boolean;
  duplicate?: boolean;
  /** 这次真正写进去的题 id。 */
  answered_questions?: string[];
  /** 仍未答的题 id：非空 ⇒ 这条请求还没收口，卡片得留着。 */
  remaining_questions?: string[];
  /** 已答过、本次被跳过的题 id（幂等重复提交会全在这里）。 */
  skipped_questions?: string[];
  /** 整条请求是否已全部答完（缺省 = 旧服务端，按「收口」理解）。 */
  final?: boolean;
}

/**
 * 这次提交之后，请求是否**仍然** pending（= 卡片不能收）。
 *
 * 判据优先级：`remaining_questions` 非空 > `final === false` > 缺省。
 * 旧服务端（没有任何新字段）返回 false ⇒ 与分批之前一样收卡片，绝不会把旧装配的卡片
 * 卡死在一屏；反过来「有新字段但没给 final」时以 remaining 为准，仍按未答处理。
 */
export function askRespondKeepsPending(outcome: AskRespondOutcome | undefined): boolean {
  if (outcome === undefined) return false;
  if (Array.isArray(outcome.remaining_questions)) return outcome.remaining_questions.length > 0;
  return outcome.final === false;
}
