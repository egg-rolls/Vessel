/**
 * ask 交互能力 — Agent 向用户提问
 * @module @vessel-agent/tui
 *
 * ADR-029：暂停型工具事件流化——ask 回归普通工具对象，
 * handler 发 `ask.user.requested` 事件 → 事件流等 `ask.user.answered` →
 * 返回回答。TUI 订阅请求事件展示弹窗，用户作答后发布回答事件。
 * 不同组件交流全走事件流，无直接回调（AskUserBridge 已退役）。
 *
 * **工具名**：0.52 起工具名是 `ask`（原名 `ask_user`）。事件名 `ask.user.*`、
 * 消息名 `ask:answer`、配置键 `ui.askUser` 与工具名无关，字面量未变；
 * 历史事件 / 历史记录里的 `data.tool` 仍是旧名，所以**读侧双认两个名字**
 * （见 `docs/lessons/L-011`）。
 */

import { randomUUID } from 'node:crypto';
import type { EventStream, ToolDefinition } from '@vessel-agent/core';
import { t } from '../i18n/index.js';

// ── 事件名与载荷 ──────────────────────────────────

/** ask 的两种语义（0.52）：阻塞等答案 / 立即返回、答案事后投递。 */
export type AskUserMode = 'sync' | 'async';

/** ask.user.requested 事件载荷（TUI 订阅展示） */
export interface AskUserRequestedData {
  requestId: string;
  questions: AskUserQuestion[];
  /** 发起提问的会话 ID */
  session_id?: string;
  /**
   * `async` = 工具已立即返回，答案稍后作为一条 user 消息投进该成员 inbox（并起新 run）。
   * 缺省（不写该键）= sync，与 0.51 及之前的事件逐字节一致。
   */
  mode?: AskUserMode;
}

/** ask.user.answered 事件载荷（TUI 发布回答；answers 为空 = 用户取消） */
export interface AskUserAnsweredData {
  requestId: string;
  /**
   * 本次带来答案的那些题（additive：分批后一次只带一批，不再是「整条请求的全部答案」）。
   *
   * 旧事件的 `answers` 就是整条请求的答案，读侧不必区分；缺 `final` 时按「整条收口」理解。
   */
  answers: AskUserAnswer[];
  /** 发起提问的会话 ID */
  session_id?: string;
  /**
   * 这条请求是不是**全部题目**都答完了（additive，缺省 = true）。
   *
   * `false` = 只是其中几题的答案到了，其余仍挂在待批队列，稍后会来下一批。
   * 旧事件的语义正好就是「一次答完」，所以缺省值必须是 true。
   */
  final?: boolean;
  /**
   * 仍未答的题 id（additive，只在 `final === false` 时有意义）。
   *
   * 工具靠它告诉模型「你还有几题没被答」，不靠它决定要不要继续等 —— 首批答案一到就返回。
   */
  remaining?: string[];
  /**
   * 这次答案属于待批页的哪一次提交（additive，`ask.respond` 的 `batch_id` 回传）。
   *
   * 仅用于排查：一次提交的多个 answer 事件带着同一个标记。
   */
  batch_id?: string;
}

// ── 类型 ──────────────────────────────────────────

/** 单个问题 */
export interface AskUserQuestion {
  /**
   * 题目标识（additive）：同一请求内稳定、可判定。
   *
   * 由 `normalizeQuestions` 按题序写成 `q1` / `q2` / …，模型不需要（也不该）自己给：
   * 答案要能对上「这是第几题的答复」，而 `header`（≤12 字、可重复）与 `question`
   * （正文可能很长或被改写）都不适合当键。旧事件里的题目没有这个字段，读侧一律
   * 按「下标 + 1」推导出同一个值（{@link questionIdOfIndex}）。
   */
  id?: string;
  /** 短标签（≤12 字符），用于 tab 显示 */
  header: string;
  /** 完整问题 */
  question: string;
  /** 选项（2-4 个）。提供 = 选择题；不提供 = 开放式输入 */
  options?: string[];
  /** 多选（默认 false，仅对选择题生效） */
  multi_select?: boolean;
}

/** ask-user 工具输入：1-4 个问题 */
export interface AskUserInput {
  questions: AskUserQuestion[];
  /**
   * 缺省 `sync`（阻塞等答案，行为和 0.51 完全一样）。
   * `async` = 投放到人类的待批页后立即返回成功，答案稍后作为一条 user 消息
   * 进入本成员 inbox 并起一次新 run；本次 run 不等待、不因未批而失败。
   */
  mode?: AskUserMode;
}

/** 单个问题的回答 */
export interface AskUserAnswer {
  /**
   * 这次回答的是哪一题（additive；旧客户端 / 旧历史没有这个字段）。
   *
   * 服务端按它把答案挂到「题」上（未答的题不随一次提交被带走）。读侧缺省时按
   * `question` 正文 → `header` → 位置依次回退，因此旧记录一字不改也能读。
   */
  question_id?: string;
  header: string;
  question: string;
  /** 给模型读的渲染结果（多选用分隔符拼好）；结构化选项见 `selected` */
  answer: string;
  /**
   * 多选的结构化选中项（additive）。
   *
   * `answer` 是把选项拼成的一段文本，分不出「选了三项」还是「一项名叫 A, B」；
   * 有了它，答复卡能渲染成 chips、也能判定「选了几项」。旧记录只有 `answer`，
   * 读侧不回填（不猜分隔符）。
   */
  selected?: string[];
}

// ── 校验与格式化 ──────────────────────────────────

const MAX_QUESTIONS = 4;

/** 宽松校验 + 归一化：header 缺失回退、超长截断、选项数量约束 */
function normalizeQuestions(input: AskUserInput): AskUserQuestion[] | string {
  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    return 'Error: "questions" must be a non-empty array (1-4 questions)';
  }
  if (input.questions.length > MAX_QUESTIONS) {
    return `Error: too many questions (max ${MAX_QUESTIONS})`;
  }

  for (let i = 0; i < input.questions.length; i++) {
    const q = input.questions[i];
    if (!q || typeof q.question !== 'string' || !q.question.trim()) {
      return `Error: questions[${i}].question is required`;
    }
    if (q.options !== undefined) {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
        return `Error: questions[${i}].options must have 2-4 items`;
      }
      for (const o of q.options) {
        if (typeof o !== 'string') {
          return `Error: questions[${i}].options must be strings`;
        }
      }
    }
  }

  return input.questions.map((q, i) => ({
    // 题 id 一律按题序重写：模型给的（如果有）不可信，重复 / 乱序会让答案挂错题。
    id: questionIdOfIndex(i),
    header: q.header?.trim()
      ? q.header.trim().slice(0, 12)
      : t('ask.questionHeader', { number: i + 1 }),
    question: q.question.trim(),
    options: q.options,
    multi_select: q.multi_select ?? false,
  }));
}

/**
 * 第 `index` 题的 id（0 基下标 → `q1` / `q2` / …）。
 *
 * 唯一一处定义「题 id 怎么来」：写侧（`normalizeQuestions`）与所有读侧（服务端从
 * `input` 推导、Web 从 `questions[]` 推导）都必须算成同一个值，否则「未答的题」与
 * 「已答的题」会对不上。
 */
export function questionIdOfIndex(index: number): string {
  return `q${index + 1}`;
}

/**
 * 把一批回答格式化为给 LLM 的多行文本。
 *
 * 行号按**题序**编，不按「本次提交的第几条」编：分批之后一次可能只到第 3 题，
 * 按提交序编会让模型把「第 3 题」读成「第 1 题」。题序从 `question_id`（`q3`）取，
 * 旧答案没有该字段时退回「本批第几条」（旧行为一字不差）。
 */
function formatAnswers(
  answers: AskUserAnswer[],
  options?: { remaining?: readonly string[] },
): string {
  const lines = answers.map((answer, index) => {
    const position = questionIndexOf(answer.question_id) ?? index + 1;
    const label = answer.header.trim() === '' ? `question ${position}` : answer.header;
    return `${position}. ${label}: ${answer.answer}`;
  });
  const remaining = options?.remaining ?? [];
  if (remaining.length > 0) {
    // 未答的题必须显式说出来：模型拿到 1/3 的答案时最容易误以为「我问的都答了」，
    // 或者以为这批提问已经作废而再问一遍。
    const total = answers.length + remaining.length;
    lines.push(
      `(${remaining.length} of ${total} questions still unanswered: ${remaining.join(', ')}. ` +
        'They stay in the human pending queue and the rest will arrive later as a separate ' +
        'message — do not wait for them, do not ask those questions again.)',
    );
  }
  return lines.join('\n');
}

/** `q3` → 3；不是这个形状（旧答案 / 手写值）→ undefined。 */
function questionIndexOf(questionId: string | undefined): number | undefined {
  if (questionId === undefined) return undefined;
  const match = /^q(\d+)$/.exec(questionId);
  if (match === null) return undefined;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 等待回答的选项。
 *
 * 0.18：默认**无限等待**——没有 TUI / Web 订阅者时也一直等到应答或 abort，
 * 不再用 120s 自动超时把 run 判失败。`timeout` 只保留给测试与显式调用方。
 */
export interface AskUserWaitOptions {
  /** 显式超时（毫秒）；缺省 = 不超时 */
  timeout?: number;
  /** run 的取消信号：abort 时停止等待并返回明确的取消文案 */
  signal?: AbortSignal;
}

/** 发布请求事件并返回 requestId（sync / async 共用同一事件，只有 `mode` 不同）。 */
function publishAskRequest(
  events: EventStream,
  runId: string,
  questions: AskUserQuestion[],
  sessionId?: string,
  mode?: AskUserMode,
): string {
  const requestId = randomUUID();
  events.publish({
    type: 'ask.user.requested',
    run_id: runId,
    data: {
      requestId,
      questions,
      ...(sessionId !== undefined && sessionId !== '' ? { session_id: sessionId } : {}),
      ...(mode === 'async' ? { mode: 'async' as const } : {}),
    } satisfies AskUserRequestedData,
    ts: Date.now(),
  });
  return requestId;
}

/**
 * async 投放：发请求事件就返回成功（不 waitFor、不因未批而失败）。
 *
 * 工具返回体必须让模型区分「已投放待批」与「已被回答」：这里只说投放成功、
 * 明确告知**还没有答案**，并要求结束本轮（答案会以一条新的 user 消息到达并起新 run）。
 * 事件带 `mode: 'async'`：待批页据此知道这个请求的 run 早已结束、仍然可答。
 */
function deliverAsync(
  events: EventStream,
  runId: string,
  questions: AskUserQuestion[],
  sessionId?: string,
): string {
  const requestId = publishAskRequest(events, runId, questions, sessionId, 'async');
  const count = questions.length === 1 ? '1 question' : `${questions.length} questions`;
  return [
    `ask accepted (async): ${count} delivered to the human for approval (request ${requestId}).`,
    'No answer yet — do not wait for one. The answer will arrive as a new user message and start a new run.',
    'The questions are answered independently: each submit of the human arrives as one message, and it may cover only some of them.',
  ].join('\n');
}

/** 解析 mode；缺省 sync（旧调用方不认识这个字段，行为不变）。 */
function normalizeMode(value: unknown): AskUserMode | string {
  if (value === undefined) return 'sync';
  if (value === 'sync' || value === 'async') return value;
  return `Error: "mode" must be "sync" or "async" (got ${JSON.stringify(value)})`;
}

/** 发请求事件 + 事件流等回答；应答 / 取消 / 显式超时三种收口 */
async function promptFromEvents(
  events: EventStream,
  runId: string,
  questions: AskUserQuestion[],
  wait: AskUserWaitOptions = {},
  sessionId?: string,
): Promise<string> {
  const requestId = publishAskRequest(events, runId, questions, sessionId);

  try {
    // 只等**一条**事件：分批提交时首批答案到就返回，不等其余题（用户裁决）。
    // 未答的题留在人类待批队列，后续批次以一条 inbox 消息补投，不卡住本轮。
    const data = (await events.waitFor('ask.user.answered', {
      requestId,
      ...(wait.timeout !== undefined ? { timeout: wait.timeout } : {}),
      ...(wait.signal !== undefined ? { signal: wait.signal } : {}),
    })) as AskUserAnsweredData | undefined;
    const answers = data?.answers ?? [];
    if (answers.length === 0) {
      return 'Error: ask was cancelled or received no answers.';
    }
    return formatAnswers(answers, { remaining: data?.remaining ?? [] });
  } catch (error) {
    // run 被取消 / abort：明确说明，不要伪装成超时（ADR-079 语义）。
    if (wait.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) {
      return 'Error: ask was cancelled.';
    }
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ── 工具定义工厂 ──────────────────────────────────

export interface CreateAskUserToolOptions {
  /** 显式等待超时（毫秒）；缺省 = 无限等待（0.18 起不再有 120s 自动超时） */
  timeout?: number;
}

/**
 * 创建 ask 工具定义（普通工具对象，ADR-029）
 *
 * handler 通过事件流交互：发布 `ask.user.requested` → 等 `ask.user.answered` →
 * 返回回答。默认一直等待，由应答 / abort（run 取消）/ run 终态收口。
 *
 * **首批即返回**：一次提问里的每道题都是独立问题，人可以一次答完，也可以分批答；
 * 第一条 `ask.user.answered` 到达就带着「这次答了哪几题 + 还剩哪几题」返回，不阻塞
 * 等其余题（未答的留在人类待批队列，后续批次以一条 inbox 消息补投）。
 *
 * 描述里那条硬口径（0.52）只改文案、不改机制：ask 仍是能阻塞等答案的工具，但**默认通道
 * 是向父 agent 汇报（`agent send`）**——只有「只有人能决定 / 缺信息完全卡住」才轮到人。
 */
export function createAskUserTool(opts: CreateAskUserToolOptions = {}): ToolDefinition {
  return {
    // 0.52：工具名 `ask`（原名 ask_user）。注册侧 / 生产侧只用新名。
    name: 'ask',
    description: `Ask the human — the last resort, not a default channel. Use it only when only
the human can decide (authorization, a hard-to-reverse or ambiguous choice, a missing
fact nobody else holds) or when the missing answer means you are completely stuck.

Everything else you handle yourself: a confirmation you can settle from the task or from
what the code says, a choice with an obvious default — decide it, and say what you
decided. If your parent agent needs to know, or is the one who can answer, report it with
agent send (the default way up) instead of putting the question in the human's lap.
Asking the human costs a person's attention; the parent channel costs nothing.

When you do ask, ask everything you need in one call — put multiple questions in the same
request instead of a multi-turn back-and-forth. One question is cheaper than redoing the
work.

Each question in that request is an independent question: the human may answer some of
them now and the rest later, or never. You get the answers as soon as the first one
arrives — unanswered questions stay in the human's pending queue (the answer text tells
you which ones), and the remaining answers come back later as a separate message. Do not
wait for all of them and do not ask those questions again.

If nothing blocks you, keep working and let the human answer when they can; if the
answer decides the next step, wait for it.`,
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['sync', 'async'],
          description:
            'sync (default) = wait for the answer here. async = return immediately; the answer arrives later as a new user message and starts a new run, so end your turn after calling it.',
          default: 'sync',
        },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              header: {
                type: 'string',
                description:
                  'Short tab label, at most 12 characters (longer labels are truncated; a default is filled in when omitted).',
                maxLength: 12,
              },
              question: {
                type: 'string',
                description: 'The complete question to display.',
              },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: { type: 'string' },
                description:
                  'Give 2-4 options to ask a multiple-choice question; omit them to ask for free-form text. An "input your own answer" option is always appended automatically. Set "multi_select": true when more than one of these options may be true at the same time (for example "which of these apply?").',
              },
              multi_select: {
                type: 'boolean',
                description:
                  'Allow the human to pick several options instead of one (default: false). Only applies when options are given. Prefer true whenever the options are not mutually exclusive — asking "which ones" with multi_select false silently forces a single answer.',
                default: false,
              },
            },
            required: ['header', 'question'],
          },
        },
      },
      required: ['questions'],
    },
    handler: async (args, ctx) => {
      const input = args as AskUserInput;
      const mode = normalizeMode(input.mode);
      if (mode !== 'sync' && mode !== 'async') return mode;
      const normalized = normalizeQuestions(input);
      if (typeof normalized === 'string') return normalized;
      if (mode === 'async') {
        return deliverAsync(ctx.events, ctx.run_id, normalized, ctx.session_id);
      }
      return promptFromEvents(
        ctx.events,
        ctx.run_id,
        normalized,
        {
          ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        },
        ctx.session_id,
      );
    },
  };
}
