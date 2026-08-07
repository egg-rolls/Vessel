/**
 * ask-user 交互能力 — Agent 向用户提问
 * @module @vessel/tui
 *
 * 与 tool-permission（renderer/tool-confirm.ts）同构：交互类定义在 TUI 层，
 * bootstrap 创建 bridge 实例并以合成插件注册工具，TUI 注入 onPrompt 回调。
 *
 * 采用 Hermes 的回调注入模式：Agent 线程调 bridge.prompt() 返回 Promise（阻塞），
 * 前端线程通过 onPrompt 接收问题，用户回答后调 respond()/cancel() 解除阻塞。
 * 未来 desktop/web 前端只需各自实现 onPrompt 注入，机制不变。
 */

import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@vessel/core';

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

/** bridge 触发前端时的事件载荷 */
export interface AskUserPromptEvent {
  id: string;
  questions: AskUserQuestion[];
}

// ── Bridge ────────────────────────────────────────

/**
 * AskUserBridge — Agent 线程和前端之间的 Promise 桥接
 *
 * 对应 Hermes 的 _block() / _respond() 模式。
 * Agent 线程调 prompt() 返回 Promise（在此"阻塞"），
 * 前端线程通过 onPrompt 接收问题，用户回答后调 respond() 解除阻塞。
 *
 * 本类不依赖任何终端细节（Ink/readline）——渲染与输入交给前端注入的
 * onPrompt/respond。这样 desktop/web 等新前端只需各自实现注入。
 */
export class AskUserBridge {
  private pending = new Map<
    string,
    {
      input: AskUserInput;
      resolve: (answers: AskUserAnswer[]) => void;
      reject: (err: Error) => void;
    }
  >();

  /**
   * Agent 线程调用——暂停并等待用户输入
   * @returns Promise，resolve 时携带每个问题的回答
   */
  async prompt(input: AskUserInput): Promise<AskUserAnswer[]> {
    const id = randomUUID();
    return new Promise<AskUserAnswer[]>((resolve, reject) => {
      this.pending.set(id, { input, resolve, reject });
      this.onPrompt?.({
        id,
        questions: input.questions,
      });
    });
  }

  /** 前端调用——用户已回答全部问题，解除阻塞 */
  respond(id: string, answers: AskUserAnswer[]): void {
    const entry = this.pending.get(id);
    if (entry) {
      entry.resolve(answers);
      this.pending.delete(id);
    }
  }

  /** 前端调用——用户取消或超时 */
  cancel(id: string, reason = 'User cancelled'): void {
    const entry = this.pending.get(id);
    if (entry) {
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  /** 取消所有待处理请求（cleanup 用） */
  cancelAll(reason = 'Session ended'): void {
    for (const [id, entry] of this.pending) {
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  /** 前端设置此回调以接收 prompt 事件 */
  onPrompt?: (event: AskUserPromptEvent) => void;
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
    header: q.header?.trim() ? q.header.trim().slice(0, 12) : `问题 ${i + 1}`,
    question: q.question.trim(),
    options: q.options,
    multi_select: q.multi_select ?? false,
  }));
}

/** 把回答格式化为给 LLM 的多行文本 */
function formatAnswers(answers: AskUserAnswer[]): string {
  return answers.map((a, i) => `${i + 1}. ${a.header}: ${a.answer}`).join('\n');
}

// ── 工具 handler ──────────────────────────────────

function createAskUserHandler(bridge: AskUserBridge): ToolDefinition['handler'] {
  return async (args: unknown) => {
    const input = args as AskUserInput;

    const normalized = normalizeQuestions(input);
    if (typeof normalized === 'string') return normalized;

    try {
      const answers = await bridge.prompt({ questions: normalized });
      return formatAnswers(answers);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
}

/** 无 bridge（headless 等无前端场景）时直接返回错误 */
function createHeadlessHandler(): ToolDefinition['handler'] {
  return async () => {
    return 'Error: ask_user is not available — no interactive frontend is connected.';
  };
}

// ── 工具定义工厂 ──────────────────────────────────

/**
 * 创建 ask_user 工具定义
 *
 * @param bridge - AskUserBridge 实例。无前端（headless）时传 undefined，工具返回错误。
 *                 正常由 bootstrap 创建 bridge 实例传入，前端注入 onPrompt。
 */
export function createAskUserTool(bridge?: AskUserBridge): ToolDefinition {
  const handler = bridge ? createAskUserHandler(bridge) : createHeadlessHandler();

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
    handler,
    default: true,
  };
}
