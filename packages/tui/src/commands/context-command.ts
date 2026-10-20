/**
 * /context 与 /compact
 * @module @vessel-agent/tui
 *
 * /context 只做估算展示；/compact 调 core 的压缩入口：
 * - 0.6.1 core：`compactAsync()`（配置了 summarizer 时生成真实摘要）
 * - 旧 core：同步 `compact()`（占位摘要）
 * 压缩后把 context.messages 写回当前会话快照（远端内存后端 load 为空则跳过）。
 */

import type { ContextManager, Message } from '@vessel-agent/core';
import { t } from '../i18n/index.js';
import type { ReplContext } from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
import type { CommandEntry, CommandResult, ReplState } from './commands.js';
import { getSessionState } from './sessions-command.js';

/** 0.6.1 core 的可选异步压缩入口 */
interface CompactableContext extends ContextManager {
  compactAsync?(): Promise<number>;
  compactWithSummary?(): Promise<number>;
}

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_COMPACT_THRESHOLD = 0.8;

/** 与 core 一致的字符估算：ASCII 0.25 / CJK 0.5 token 每字符 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let total = 0;
  for (const char of text) {
    total++;
    if (/[一-鿿㐀-䶿]/.test(char)) cjk++;
  }
  return Math.ceil((total - cjk) * 0.25 + cjk * 0.5);
}

export interface ContextUsage {
  source: 'context' | 'session';
  totalMessages: number;
  system: { count: number; tokens: number };
  messages: { count: number; tokens: number };
  toolResults: { count: number; tokens: number };
  totalTokens: number;
  maxTokens: number;
  threshold: number;
  autoCompact: boolean;
  counts: Record<'system' | 'user' | 'assistant' | 'tool' | 'other', number>;
}

/** 纯函数：按 system / 对话消息 / 工具结果分段估算 */
export function estimateContextUsage(
  messages: Message[],
  options: {
    source?: 'context' | 'session';
    maxTokens?: number;
    threshold?: number;
    autoCompact?: boolean;
  } = {},
): ContextUsage {
  const usage: ContextUsage = {
    source: options.source ?? 'context',
    totalMessages: messages.length,
    system: { count: 0, tokens: 0 },
    messages: { count: 0, tokens: 0 },
    toolResults: { count: 0, tokens: 0 },
    totalTokens: 0,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    threshold: options.threshold ?? DEFAULT_COMPACT_THRESHOLD,
    autoCompact: options.autoCompact ?? false,
    counts: { system: 0, user: 0, assistant: 0, tool: 0, other: 0 },
  };

  for (const message of messages) {
    const role = message.role;
    const content = message.content ?? '';
    const reasoning = message.reasoning_content ?? '';
    const toolCallArgs =
      message.tool_calls?.map((call) => call.function?.arguments ?? '').join('') ?? '';
    const tokens =
      estimateTokens(content) + estimateTokens(reasoning) + estimateTokens(toolCallArgs);

    if (role === 'system') {
      usage.counts.system++;
      usage.system.count++;
      usage.system.tokens += tokens;
    } else if (role === 'tool') {
      usage.counts.tool++;
      usage.toolResults.count++;
      usage.toolResults.tokens += tokens;
    } else if (role === 'user' || role === 'assistant') {
      usage.counts[role]++;
      usage.messages.count++;
      usage.messages.tokens += tokens;
    } else {
      usage.counts.other++;
      usage.messages.count++;
      usage.messages.tokens += tokens;
    }
    usage.totalTokens += tokens;
  }

  return usage;
}

function percent(part: number, total: number): string {
  if (total <= 0) return '0.0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

/** 纯函数：/context 报告 */
export function formatContextReport(usage: ContextUsage): string {
  const thresholdTokens = Math.floor(usage.maxTokens * usage.threshold);
  const totalRatio = percent(usage.totalTokens, usage.maxTokens);
  return [
    '',
    `Context usage (${usage.source === 'session' ? 'session history' : 'live context'}; estimated):`,
    `  system        ${usage.system.tokens.toString().padStart(7)} tokens  (${usage.system.count} msgs)`,
    `  messages      ${usage.messages.tokens.toString().padStart(7)} tokens  (${usage.messages.count} msgs)`,
    `  tool results  ${usage.toolResults.tokens.toString().padStart(7)} tokens  (${usage.toolResults.count} msgs)`,
    `  total         ${usage.totalTokens.toString().padStart(7)} / ${usage.maxTokens} tokens (${totalRatio})`,
    '',
    `  messages: ${usage.totalMessages} · system ${usage.counts.system} · user ${usage.counts.user} · assistant ${usage.counts.assistant} · tool ${usage.counts.tool}${usage.counts.other > 0 ? ` · other ${usage.counts.other}` : ''}`,
    `  auto-compact: ${usage.autoCompact ? 'on' : 'off'} at ${Math.round(usage.threshold * 100)}% (${thresholdTokens} tokens)`,
    '',
  ].join('\n');
}

function contextOptions(ctx: ReplContext): {
  maxTokens?: number;
  threshold?: number;
  autoCompact?: boolean;
} {
  return {
    ...(ctx.config.context?.maxTokens !== undefined
      ? { maxTokens: ctx.config.context.maxTokens }
      : {}),
    ...(ctx.config.context?.compactThreshold !== undefined
      ? { threshold: ctx.config.context.compactThreshold }
      : {}),
    ...(ctx.config.context?.autoCompact !== undefined
      ? { autoCompact: ctx.config.context.autoCompact }
      : {}),
  };
}

/** 读取上下文；context 为空时回退当前会话历史（尚未跑过 run） */
async function loadUsage(ctx: ReplContext, state: ReplState): Promise<ContextUsage> {
  const options = contextOptions(ctx);
  const live = ctx.context.messages;
  if (live.length > 0) return estimateContextUsage(live, { ...options, source: 'context' });
  try {
    const loaded = await getSessionState(ctx, state.currentSessionId);
    const messages = (loaded?.messages ?? []).map(
      (message) => ({ role: message.role, content: message.content }) as Message,
    );
    return estimateContextUsage(messages, { ...options, source: 'session' });
  } catch {
    return estimateContextUsage([], { ...options, source: 'context' });
  }
}

export async function runContextCommand(
  _args: string[],
  ctx: ReplContext,
  state: ReplState,
): Promise<CommandResult> {
  const usage = await loadUsage(ctx, state);
  return { handled: true, output: formatContextReport(usage) };
}

export interface CompactOutcome {
  removed: number;
  remaining: number;
  /** async = core 0.6.1 入口；sync = 旧 core 占位摘要 */
  mode: 'async' | 'sync';
  /** 会话快照是否写回（远端内存后端 load 为空时为 false） */
  persisted: boolean;
}

/** 纯适配：优先 compactAsync；同步 compact 也兼容 Promise 返回值 */
export async function compactSessionContext(
  context: ContextManager,
  persist?: (messages: Message[]) => Promise<boolean>,
): Promise<CompactOutcome> {
  const candidate = context as CompactableContext;
  let removed = 0;
  let mode: CompactOutcome['mode'] = 'sync';

  if (typeof candidate.compactAsync === 'function') {
    removed = await candidate.compactAsync();
    mode = 'async';
  } else if (typeof candidate.compactWithSummary === 'function') {
    removed = await candidate.compactWithSummary();
    mode = 'async';
  } else {
    const result = context.compact() as number | Promise<number>;
    removed = await result;
  }

  const remaining = context.messages.length;
  let persisted = false;
  if (removed > 0 && persist) {
    try {
      persisted = await persist(context.messages);
    } catch {
      persisted = false;
    }
  }

  return { removed, remaining, mode, persisted };
}

export async function runCompactCommand(
  _args: string[],
  ctx: ReplContext,
  state: ReplState,
): Promise<CommandResult> {
  if (ctx.context.messages.length === 0) {
    return { handled: true, output: '\nNothing to compact (context is empty).\n' };
  }

  const outcome = await compactSessionContext(ctx.context, async (messages) => {
    try {
      const saved = await ctx.session.load(state.currentSessionId);
      if (!saved) return false;
      saved.messages = messages;
      saved.updated_at = Date.now();
      await ctx.session.save(saved);
      return true;
    } catch (error) {
      throw new Error(formatRpcError(error));
    }
  });

  if (outcome.removed === 0) {
    return {
      handled: true,
      output: '\nNothing to compact (too few messages or already minimal).\n',
    };
  }

  const note =
    outcome.mode === 'async'
      ? 'core summary path'
      : 'placeholder summary (no summarizer; core < 0.6.1)';
  return {
    handled: true,
    nextState: { compactions: (state.compactions ?? 0) + 1 },
    output: [
      '',
      `Compacted ${outcome.removed} message(s); ${outcome.remaining} remain.`,
      `Mode: ${note}.`,
      `Session snapshot: ${outcome.persisted ? 'updated' : 'not written (remote/read-only backend)'}.`,
      '',
    ].join('\n'),
  };
}

export function contextCommand(): CommandEntry {
  return {
    name: 'context',
    description: t('command.context.description'),
    usage: '/context',
    category: 'session',
    keywords: ['context', 'tokens', 'usage', 'compact'],
    run: (args, ctx, state) => runContextCommand(args, ctx, state),
  };
}

export function compactCommand(): CommandEntry {
  return {
    name: 'compact',
    description: t('command.compact.description'),
    usage: '/compact',
    category: 'session',
    keywords: ['compact', 'compress', 'summary', 'context'],
    run: (args, ctx, state) => runCompactCommand(args, ctx, state),
  };
}
