/**
 * REPL 实现（egg-rolls 基础版：readline 对话循环 + 二层 slash 命令 + 流式 + 错误分类）
 * @module @vessel/tui
 *
 * 契约（与 egg-rolls 壳的接缝）：壳构造 ReplContext -> 调 startRepl(ctx) -> 阻塞至 /exit。
 * emma 后续替换为 Ink 框架 + token 动画 + 弹窗，函数签名与 ReplContext 不变。
 */

import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import { type ReplState, consumePendingResume, createCommands } from '../commands/commands.js';
import { StreamRenderer } from '../renderer/stream-renderer.js';
import type { ReplContext } from '../repl-context.js';

// ── 错误分类（REPL-7）──────────────────────────────

export type ErrorCategory = 'network' | 'auth' | 'quota' | 'api' | 'unknown';

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  hint?: string;
}

/**
 * 把 run() 抛出的错误分类（网络 / API / 限额 / 鉴权 / 其他）。
 * 纯函数，可单测。
 */
export function classifyError(error: unknown): ClassifiedError {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (/usage limits exceeded|termination policy|max iterations|max_runtime/.test(lower)) {
    return {
      category: 'quota',
      message: msg,
      hint: '用量/限额触发，调大 limits 或 /session new 开新会话。',
    };
  }
  if (/429|rate limit|rate_limit|quota/.test(lower)) {
    return { category: 'quota', message: msg, hint: '请求过频或额度不足，稍后重试。' };
  }
  if (/401|unauthorized|invalid api key|invalid_api_key|authentication/.test(lower)) {
    return { category: 'auth', message: msg, hint: 'API Key 无效，运行 /setup 重新配置。' };
  }
  if (
    /fetch failed|econnrefused|enotfound|etimedout|connect_timeout|network|socket hang up|aborted/.test(
      lower,
    )
  ) {
    return { category: 'network', message: msg, hint: '网络不可达，检查 BaseURL/网络后重试。' };
  }
  if (/api error|http \d{3}|bad request|400|403|404|500|502|503/.test(lower)) {
    return { category: 'api', message: msg, hint: 'Provider 返回错误，检查模型名/参数。' };
  }
  return { category: 'unknown', message: msg };
}

// ── startRepl ─────────────────────────────────────

/**
 * 交互式 REPL 入口。
 * 壳（cli.ts）构造 ReplContext -> 调本函数 -> 阻塞至 /exit。
 *
 * egg-rolls 在此实现：
 * - readline 对话循环 + 历史 + 行编辑
 * - 二层 slash 命令分发（/session <action>、/tool list、/help /clear /setup /exit）
 * - StreamRenderer 订阅 ctx.events，token-by-token 流式输出
 * - /session resume 的 Hermes pending one-shot（裸数字恢复）
 * - 错误分类展示（网络/API/限额/鉴权）
 * - Ctrl+C：运行中->中断当前 run；空闲->退出
 */
export async function startRepl(ctx: ReplContext): Promise<void> {
  const rl = readline.createInterface({
    input,
    output,
    // 真终端开启行编辑；管道/非 TTY 用简单行模式（避免 Bun readline 缓冲怪癖）
    terminal: process.stdin.isTTY ?? false,
  });
  const commands = createCommands();
  const renderer = new StreamRenderer();
  renderer.start(ctx.events);

  const state: ReplState = {
    currentSessionId: ctx.currentSessionId,
    pendingResume: false,
    running: true,
  };

  // 当前 run 的 AbortController--SIGINT 用
  let currentController: AbortController | null = null;
  rl.on('SIGINT', () => {
    if (currentController) {
      currentController.abort(); // run() 抛 'Run cancelled' -> classifyError 兜底
    } else {
      console.log('\nGoodbye!');
      state.running = false;
      ctx.onExit();
    }
  });

  // 状态栏 / banner
  console.log(`\nVessel  ·  ${ctx.provider.name} | ${ctx.provider.model}`);
  if (ctx.plugins.length > 0) console.log(`plugins: ${ctx.plugins.join(', ')}`);
  console.log(`session: ${state.currentSessionId}`);
  console.log('Type your message, or /help for commands.\n');

  // 行队列：处理期间到达的行（粘贴/管道）排队不丢失，避免 question() 丢行
  const lineQueue: string[] = [];
  let lineResolver: ((line: string | null) => void) | null = null;
  rl.on('line', (line: string) => {
    if (lineResolver) {
      const r = lineResolver;
      lineResolver = null;
      r(line);
    } else {
      lineQueue.push(line);
    }
  });
  rl.on('close', () => {
    if (lineResolver) {
      const r = lineResolver;
      lineResolver = null;
      r(null);
    }
  });
  const nextLine = (): Promise<string | null> => {
    if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift() ?? null);
    return new Promise((resolve) => {
      lineResolver = resolve;
    });
  };

  try {
    while (state.running) {
      process.stdout.write('vessel> ');
      const line = await nextLine();
      if (line === null) break; // EOF / rl 关闭
      const trimmed = line.trim();

      // /session resume 的 pending one-shot：下一行裸数字 -> 恢复
      if (state.pendingResume) {
        if (/^\d+$/.test(trimmed)) {
          await consumePendingResume(trimmed, ctx, state);
          continue;
        }
        // 非数字 -> 取消 pending，继续正常处理本行
        state.pendingResume = false;
      }

      if (trimmed === '') continue;

      if (trimmed.startsWith('/')) {
        const result = await commands.execute(trimmed.slice(1), ctx, state);
        if (!result.handled) {
          const name = trimmed.split(/\s+/)[0] ?? trimmed;
          console.log(`Unknown command: ${name}. Type /help for available commands.`);
        }
        continue;
      }

      await handleMessage(trimmed, ctx, state, renderer, rl, (c) => {
        currentController = c;
      });
    }
  } finally {
    renderer.stop();
    rl.close();
  }
}

/** 处理普通对话消息：调 runtime.run，流式渲染，错误分类 */
async function handleMessage(
  msg: string,
  ctx: ReplContext,
  state: ReplState,
  renderer: StreamRenderer,
  rl: readline.Interface,
  setController: (c: AbortController | null) => void,
): Promise<void> {
  const controller = new AbortController();
  setController(controller);
  // 暂停 REPL 的 readline，让出 stdin 给工具权限确认弹窗（ToolPermissionChecker 自建 readline）
  rl.pause();
  try {
    const response = await ctx.runtime.run(msg, state.currentSessionId, {
      signal: controller.signal,
    });
    if (renderer.didStreamLastRun()) {
      // 流式已逐 token 打印，RunCompleted 已换行 -> 再空一行分隔
      process.stdout.write('\n');
    } else {
      // 非流式 provider 兜底：打印完整响应
      process.stdout.write(`${response}\n\n`);
    }
  } catch (error) {
    const c = classifyError(error);
    process.stdout.write('\n');
    if (c.hint) {
      console.error(`✗ [${c.category}] ${c.message}\n  ${c.hint}`);
    } else {
      console.error(`✗ [${c.category}] ${c.message}`);
    }
    console.log('');
  } finally {
    setController(null);
    rl.resume();
  }
}
