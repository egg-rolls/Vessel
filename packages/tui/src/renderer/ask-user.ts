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
  answers: AskUserAnswer[];
  /** 发起提问的会话 ID */
  session_id?: string;
}

// ── 类型 ──────────────────────────────────────────

/** 单个问题 */
export interface AskUserQuestion {
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
  header: string;
  question: string;
  answer: string;
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
    header: q.header?.trim()
      ? q.header.trim().slice(0, 12)
      : t('ask.questionHeader', { number: i + 1 }),
    question: q.question.trim(),
    options: q.options,
    multi_select: q.multi_select ?? false,
  }));
}

/** 把回答格式化为给 LLM 的多行文本 */
function formatAnswers(answers: AskUserAnswer[]): string {
  return answers.map((a, i) => `${i + 1}. ${a.header}: ${a.answer}`).join('\n');
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
    const data = (await events.waitFor('ask.user.answered', {
      requestId,
      ...(wait.timeout !== undefined ? { timeout: wait.timeout } : {}),
      ...(wait.signal !== undefined ? { signal: wait.signal } : {}),
    })) as AskUserAnsweredData | undefined;
    const answers = data?.answers ?? [];
    if (answers.length === 0) {
      return 'Error: ask was cancelled or received no answers.';
    }
    return formatAnswers(answers);
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
 */
export function createAskUserTool(opts: CreateAskUserToolOptions = {}): ToolDefinition {
  return {
    // 0.52：工具名 `ask`（原名 ask_user）。注册侧 / 生产侧只用新名。
    name: 'ask',
    description: `Ask the human when only they can decide or supply the missing fact: confirmation,
a choice between options, missing information, authorization, or intent you cannot
safely infer. Anything that needs a human to say one line belongs here.

Ask everything you need in one call — put multiple questions in the same request
instead of a multi-turn back-and-forth. Prefer asking over guessing: one question is
cheaper than redoing the work.

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
                  'Give 2-4 options to ask a multiple-choice question; omit them to ask for free-form text. An "input your own answer" option is always appended automatically.',
              },
              multi_select: {
                type: 'boolean',
                description:
                  'Allow selecting multiple options. Default: false. Only applies when options are given.',
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
