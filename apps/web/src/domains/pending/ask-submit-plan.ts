/**
 * 一次提交的「载荷规划」：哪些行进载荷、每条答案挂在哪一题上 —— 纯函数，零 React。
 *
 * 为什么单独一层：分批提交之后，待批页 / Composer 单题卡的同一屏里既有已经落定的题，
 * 也有还没答的题。两张卡各自 map 一遍 questions 就会各自把「已答过的行」重新塞进载荷
 * （0.52 的漂移就是这么来的：第二批发了一遍第一批的答案，而那一行进服务端时还缺
 * question_id，于是落盘多出一条空题号的答案）。把它收成一处可测的判定：
 *
 * - 载荷只含**还没落定**的行（服务端 answered_questions 里没有的题号）；
 * - 草稿照旧留着展示（用户能回看自己答了什么），但已落定的行不再进载荷；
 * - 每条答案都带 question_id（走 buildAskAnswer），服务端才有去重的键。
 *
 * @module web/domains/pending/ask-submit-plan
 */

import { askQuestionSettled, buildAskAnswer } from '../../gateway/ask-answers';
import type { AskUserAnswer, AskUserQuestion } from '../../gateway/types';
import { type AskDrafts, type AskDraftValue, askDraftOf, isAskDraftAnswered } from './ask-drafts';

/**
 * 规划只依赖请求的这几片：结构化类型而不是整条 AskUserRequest，测试不必伪造会话字段。
 */
export interface AskPlanRequest {
  readonly requestId: string;
  readonly questions?: readonly AskUserQuestion[] | undefined;
  /** 服务端逐题进度；缺省 = 旧 gateway 不给，按「都没答过」处理。 */
  readonly answeredQuestionIds?: readonly string[] | undefined;
}

/** 一行 = 一题 + 它此刻的草稿 + 落定状态。 */
export interface AskPlanRow {
  readonly requestId: string;
  readonly index: number;
  readonly question: AskUserQuestion;
  readonly draft: AskDraftValue;
  /** 本地草稿里已经有答案。 */
  readonly answered: boolean;
  /** 服务端已落定：不再进载荷，界面上标「已答」。 */
  readonly settled: boolean;
}

/** 把若干请求展开成行（题序即题号，与 askQuestionId 同一条规则）。 */
export function askPlanRows(
  requests: readonly AskPlanRequest[],
  drafts: AskDrafts,
): AskPlanRow[] {
  const rows: AskPlanRow[] = [];
  for (const request of requests) {
    const questions = request.questions ?? [];
    questions.forEach((question, index) => {
      const draft = askDraftOf(drafts, request.requestId, index);
      rows.push({
        requestId: request.requestId,
        index,
        question,
        draft,
        answered: isAskDraftAnswered(draft),
        settled: askQuestionSettled(request.answeredQuestionIds, question, index),
      });
    });
  }
  return rows;
}

/** 还没落定的行：卡片导航 / 「都答了吗」只该看这些。 */
export function askOpenRows(rows: readonly AskPlanRow[]): AskPlanRow[] {
  return rows.filter((row) => !row.settled);
}

/** 本地已经有答案、但还没落定的行（= 可以进载荷的行）。 */
export function askReadyRows(rows: readonly AskPlanRow[]): AskPlanRow[] {
  return rows.filter((row) => !row.settled && row.answered);
}

/** 单行 → 一条答案；题号必带，缺了服务端就只能靠正文猜题。 */
export function askAnswerOf(row: AskPlanRow): AskUserAnswer {
  return buildAskAnswer(row.question, row.draft, row.index);
}

/**
 * Composer 单题卡的载荷：未落定且本地有答案的题全带上（那里没有「纳入」勾选）。
 */
export function askPendingAnswers(rows: readonly AskPlanRow[]): AskUserAnswer[] {
  return askReadyRows(rows).map(askAnswerOf);
}

/**
 * 待批页的载荷：在 askPendingAnswers 之上再要「勾了带上这题」。
 */
export function askIncludedAnswers(rows: readonly AskPlanRow[]): AskUserAnswer[] {
  return askReadyRows(rows)
    .filter((row) => row.draft.include)
    .map(askAnswerOf);
}

/** 未落定的题是否都答完了（未落定的题为空也算完 = 卡片不该再提交）。 */
export function askRowsComplete(rows: readonly AskPlanRow[]): boolean {
  return askOpenRows(rows).every((row) => row.answered);
}
