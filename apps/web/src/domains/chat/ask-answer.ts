/**
 * 「待批答复」：async `ask_user` 的答案在时间线上的身份与解析（纯函数）。
 *
 * 答案必须是**一条真正的 user 消息**（协议要求：只有 user 消息才能开新一轮 run），
 * 但人不是在那个输入框里打的 —— 他是在待批页回答的。所以数据照旧是 user 消息，
 * 呈现换成一张卡（用户裁决：「待批答复」卡，而不是用户气泡）：
 * - 身份：执行内核把这种输入的 `Message.name` 写成 `ask:answer`
 *   （`packages/agent/src/runtime.ts` 的 `ASK_ANSWER_INPUT_NAME`，字面量必须一致）；
 *   它不是 `vessel:*` —— 那是模型侧上下文、不算 turn 锚点，这条**就是**该轮的用户输入。
 * - 正文：`src/ask-answer-delivery.ts` 的 `formatAskAnswerContent` 写
 *   `[ask_user answer <requestId>] Answers from the human …` + `N. header（原问题摘要）: answer`
 *   行；同一次「一起提交」的多条答案合并成一条消息时，前缀里是逗号分隔的多个
 *   requestId（0.52 additive）。
 *   解析失败（旧数据 / 别人手改）时**回退普通用户气泡**，绝不吞正文；旧格式
 *   （只有 header、没有原问题）解析结果与旧版一字不差。
 *
 * 为什么不新开字段：`Message` 只有 role / content / name / timestamp，name 已经是
 * 既有身份位（`agent:<alias>` / `vessel:*`），加第二个身份位等于两套真相。
 *
 * @module web/domains/chat/ask-answer
 */

import type { Message } from '../../gateway/types';

/** async 答案消息的 `Message.name`（与 `packages/agent` 的 `ASK_ANSWER_INPUT_NAME` 同一字面量）。 */
export const ASK_ANSWER_MESSAGE_NAME = 'ask:answer';

/** 正文前缀（`src/ask-answer-delivery.ts` 的 `ASK_ANSWER_TAG_PREFIX` 同一字面量）。 */
export const ASK_ANSWER_TAG_PREFIX = '[ask_user answer ';

/** 卡片里的一条答案。 */
export interface AskAnswerRow {
  /** 题目标签（`header`，模型没给时退化成 `Answer N` 或问题摘要）。 */
  label: string;
  text: string;
  /**
   * 原问题摘要（0.52 additive：答案行写成 `N. header（问题摘要）: 答案`）。
   *
   * 缺省 = 旧格式（只有 header / 没有 header），此时渲染与旧版一字不差。
   */
  question?: string;
}

/** 一张「待批答复」卡的数据。 */
export interface AskAnswerCard {
  /** 请求 id（标题副行 / 排障用；解析不出时缺失）。合并消息取第一个。 */
  requestId?: string;
  /** 同批合并进来的**其它** request 数（`ask.respond` 带 batch_id 时的一批）。 */
  extraRequestIds?: number;
  /** 标题摘要：第一题的标签（截断），缺失回退「第 N 题」。 */
  summary: string;
  rows: AskAnswerRow[];
}

/** 这条消息是不是 async ask 的答案（按结构化的 name 判定，不猜正文）。 */
export function isAskAnswerMessage(message: Message): boolean {
  return message.role === 'user' && message.name === ASK_ANSWER_MESSAGE_NAME;
}

/** `N. label: text`；label 不许跨行，正文可以（保持多行答案原样）。 */
const ROW_PATTERN = /^\d+\.\s+([^:\n]{1,400}):\s*([\s\S]*)$/;

/** 问题摘要的包装（`formatAnswersForModel` 用全角括号把原问题接在 header 后面）。 */
const QUESTION_OPEN = '（';
const QUESTION_CLOSE = '）';

/**
 * 把 `header（问题摘要）` 拆成 label + question；不是这个形状就原样返回。
 *
 * 旧格式（只有 header）没有全角括号，因此解析结果与旧版完全一致。
 */
function splitQuestion(rawLabel: string): { label: string; question?: string } {
  if (!rawLabel.endsWith(QUESTION_CLOSE)) return { label: rawLabel };
  const start = rawLabel.indexOf(QUESTION_OPEN);
  if (start <= 0) return { label: rawLabel };
  const question = rawLabel.slice(start + 1, -1).trim();
  if (question.length === 0) return { label: rawLabel };
  return { label: rawLabel.slice(0, start).trim(), question };
}

/**
 * 正文 → 卡片数据；不是可识别的答案格式时返回 undefined（调用方回退气泡）。
 *
 * 容错：前缀缺失（旧数据）也能按行解析 —— 只要至少有一行像答案；一行都不像就
 * 说明这条消息不是本功能的产物，交给普通渲染。
 */
export function askAnswerCard(content: string): AskAnswerCard | undefined {
  const text = content.trim();
  if (text.length === 0) return undefined;
  const lines = text.split(/\r?\n/);
  let requestId: string | undefined;
  let extraRequestIds: number | undefined;
  const header = lines[0] ?? '';
  if (header.startsWith(ASK_ANSWER_TAG_PREFIX)) {
    const end = header.indexOf(']', ASK_ANSWER_TAG_PREFIX.length);
    const raw = end === -1 ? undefined : header.slice(ASK_ANSWER_TAG_PREFIX.length, end);
    const trimmed = raw?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      // 同批合并的答案消息把整批 requestId 逗号分隔写在前缀里（additive）。
      const ids = trimmed
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      requestId = ids[0];
      if (ids.length > 1) extraRequestIds = ids.length - 1;
    }
  }
  const rows: AskAnswerRow[] = [];
  for (const line of lines) {
    const match = ROW_PATTERN.exec(line.trim());
    if (match === null) continue;
    const { label, question } = splitQuestion((match[1] ?? '').trim());
    const body = (match[2] ?? '').trim();
    if (label.length === 0 || body.length === 0) continue;
    rows.push({ label, text: body, ...(question !== undefined ? { question } : {}) });
  }
  if (rows.length === 0) return undefined;
  const first = rows[0];
  if (first === undefined) return undefined;
  const summary = first.label.length > 40 ? `${first.label.slice(0, 40)}…` : first.label;
  return {
    ...(requestId !== undefined ? { requestId } : {}),
    ...(extraRequestIds !== undefined ? { extraRequestIds } : {}),
    summary,
    rows,
  };
}
