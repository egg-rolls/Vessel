/**
 * ask-user 交互能力 — Agent 向用户提问
 * @module @vessel-agent/tui
 *
 * ADR-029：暂停型工具事件流化——ask-user 回归普通工具对象，
 * handler 发 `ask.user.requested` 事件 → 事件流等 `ask.user.answered` →
 * 返回回答。TUI 订阅请求事件展示弹窗，用户作答后发布回答事件。
 * 不同组件交流全走事件流，无直接回调（AskUserBridge 已退役）。
 */

import { randomUUID } from 'node:crypto';
import type { EventStream, ToolDefinition } from '@vessel-agent/core';
import { t } from '../i18n/index.js';

// ── 事件名与载荷 ──────────────────────────────────

/** ask.user.requested 事件载荷（TUI 订阅展示） */
export interface AskUserRequestedData {
  requestId: string;
  questions: AskUserQuestion[];
  /** 发起提问的会话 ID */
  session_id?: string;
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

/** 发请求事件 + 事件流等回答；应答 / 取消 / 显式超时三种收口 */
async function promptFromEvents(
  events: EventStream,
  runId: string,
  questions: AskUserQuestion[],
  wait: AskUserWaitOptions = {},
  sessionId?: string,
): Promise<string> {
  const requestId = randomUUID();
  events.publish({
    type: 'ask.user.requested',
    run_id: runId,
    data: {
      requestId,
      questions,
      ...(sessionId !== undefined && sessionId !== '' ? { session_id: sessionId } : {}),
    } satisfies AskUserRequestedData,
    ts: Date.now(),
  });

  try {
    const data = (await events.waitFor('ask.user.answered', {
      requestId,
      ...(wait.timeout !== undefined ? { timeout: wait.timeout } : {}),
      ...(wait.signal !== undefined ? { signal: wait.signal } : {}),
    })) as AskUserAnsweredData | undefined;
    const answers = data?.answers ?? [];
    if (answers.length === 0) {
      return 'Error: ask_user was cancelled or received no answers.';
    }
    return formatAnswers(answers);
  } catch (error) {
    // run 被取消 / abort：明确说明，不要伪装成超时（ADR-079 语义）。
    if (wait.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) {
      return 'Error: ask_user was cancelled.';
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
 * 创建 ask_user 工具定义（普通工具对象，ADR-029）
 *
 * handler 通过事件流交互：发布 `ask.user.requested` → 等 `ask.user.answered` →
 * 返回回答。默认一直等待，由应答 / abort（run 取消）/ run 终态收口。
 */
export function createAskUserTool(opts: CreateAskUserToolOptions = {}): ToolDefinition {
  return {
    name: 'ask_user',
    description: `Ask the user up to 4 questions during execution, with optional multiple-choice options and multi-select.
Each question can have up to 4 options; the user may pick one, select multiple (multi_select: true), or type their own answer.
This tool pauses the run and waits for the user to answer all questions, then returns the answers.
Use when you need clarification, confirmation, or to gather information only the user can provide.
Do NOT use for trivial questions you can resolve yourself.`,
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              header: {
                type: 'string',
                description: 'Short label (≤ 12 chars) shown as a tab.',
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
                  'Multiple-choice options (2-4). Omit for open-ended input. An "input your own answer" option is always appended automatically.',
              },
              multi_select: {
                type: 'boolean',
                description: 'Allow selecting multiple options. Default: false.',
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
      const normalized = normalizeQuestions(input);
      if (typeof normalized === 'string') return normalized;
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
