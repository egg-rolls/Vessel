/**
 * 斜杠命令（扁平结构：`/<command> [args]`）
 * @module @vessel/tui
 *
 * 命令清单（ADR-020）：
 * /tools - 工具浏览器（读 ctx.pluginHost）
 * /plugins - 插件浏览器
 * /resume - 恢复会话
 * /mcp - MCP server 状态 / 重连
 * /runs - durable run 列表 / 恢复
 * /new - 新建会话
 * /history - 显示历史
 * /setup - 配置向导
 * /reload - 重载配置
 * /clear - 清屏
 * /help - 帮助
 * /exit - 退出
 *
 * 全部从 ReplContext 取数；切会话经 ctx.context.clear() + ctx.onSessionChange()。
 * /resume 照搬 Hermes pending one-shot：无参->编号列表 + 置 pending；下一行裸数字->恢复。
 *
 * 命令是纯函数：只返回 `{ handled, output, nextState }`，不直接改 state、不直接打印。
 * state 应用集中在 CommandRegistry.execute()；output 由调用方消费（simple 模式打印、Ink 模式入历史）。
 */

import { t } from '../i18n/index.js';
import type { DurableRunHandle, ReplContext, WorkflowRunHandle } from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
import { displayWidth, truncateToWidth } from '../utils/text-layout.js';
import type { DetailView, ListView, ViewActionInvocation, ViewEnvelope } from '../views/types.js';
import { capabilitiesCommand } from './capabilities-command.js';
import { configCommand } from './config-command.js';
import { compactCommand, contextCommand } from './context-command.js';
import { costCommand } from './cost-command.js';
import { detailsCommand } from './details-command.js';
import { exportCommand } from './export-command.js';
import { feishuCommand } from './feishu-command.js';
import { mcpCommand } from './mcp-command.js';
import { metricsCommand } from './metrics-command.js';
import { permissionsCommand } from './permissions-command.js';
import { runsCommand } from './runs-command.js';
import {
  deleteSession,
  deleteSessionAction,
  getSessionState,
  listSessions,
  renameSessionAction,
  type SessionMessageLike,
  sessionsCommand,
} from './sessions-command.js';
import { tenantCommand } from './tenant-command.js';
import { traceCommand } from './trace-command.js';
import { workflowsCommand } from './workflows-command.js';

// ── 类型 ──────────────────────────────────────────

/** REPL 运行态--命令只读，execute 按 nextState 统一应用 */
export type ToolDetailMode = 'hidden' | 'collapsed' | 'expanded';

export interface ReplState {
  /** 当前会话 ID--/new、/resume 会改；chat 传它给 runtime.run() */
  currentSessionId: string;
  /** /resume 无参后置位；下一行裸数字触发按编号恢复 */
  pendingResume: boolean;
  /** /resume 无参时显示交互式选择器（Ink 模式） */
  showResumePicker: boolean;
  /** 主循环运行标志--/exit 置 false 退出 */
  running: boolean;
  /** 历史/恢复回灌是否展示 reasoning_content（默认 false） */
  showReasoning?: boolean;
  /** 成功压缩次数（状态规则展示；0/缺失不显示） */
  compactions?: number;
  /** Tool trail 三态；缺失按 collapsed */
  toolDetailMode?: ToolDetailMode;
}

/** 命令执行结果 */
export interface CommandResult {
  /** 是否已识别并处理（false = 未知命令，由调用方提示） */
  handled: boolean;
  /** 命令输出文本（调用方显示） */
  output?: string;
  /** 需要写入终端 scrollback 的多行历史（/resume hydrate） */
  history?: string[];
  /** 命令请求的 state 变更（execute 统一应用到 state） */
  nextState?: Partial<ReplState>;
  /** /clear 等需要 REPL 层清屏的命令置 true（替代硬编码字符串匹配） */
  clearScreen?: boolean;
  /** /runs resume：命令已启动恢复，REPL 层接管运行态（runStart/runEnd、取消、流式） */
  resumeRun?: DurableRunHandle;
  /** /workflows run|resume：命令已启动，REPL 层接管运行态与取消 */
  workflowRun?: WorkflowRunHandle;
  /**
   * Ink 模式下打开交互视图；simple mode 忽略并打印 `output`
   * （`output` 仍是契约，缺失时 fallback 到 `renderViewAsText(view)`）。
   */
  view?: ViewEnvelope;
}

/** 命令执行函数签名 */
type Run = (
  args: string[],
  ctx: ReplContext,
  state: ReplState,
) => Promise<CommandResult> | CommandResult;

/** 命令元数据分类（help / autocomplete 分组） */
export type CommandCategory = 'session' | 'run' | 'inspect' | 'config' | 'system';

/** 命令条目 */
export interface CommandEntry {
  name: string;
  description: string;
  usage?: string;
  /** help/autocomplete 分组；缺省 'system' */
  category?: CommandCategory;
  /** 模糊匹配的别名词 */
  keywords?: string[];
  /** 不出现在 help/autocomplete，但仍可执行 */
  hidden?: boolean;
  /** 当前上下文是否可用；缺省 true（用于 dim 标签，不用于隐藏） */
  available?: (ctx: ReplContext) => boolean;
  /** 不可用原因（如 'RPC required' / 'durable disabled'），用于 help/autocomplete 标签 */
  unavailableHint?: string;
  /** 命令执行函数 */
  run: Run;
  /** 视图动作处理；返回新的 CommandResult（可带新 view） */
  viewAction?: (
    invocation: ViewActionInvocation,
    ctx: ReplContext,
    state: ReplState,
  ) => Promise<CommandResult> | CommandResult;
}

/** 恢复会话结果（doResume 纯函数返回） */
export interface ResumeResult {
  message: string;
  /** 最近 N 条历史消息的展示行（供 Ink Static / simple 模式输出） */
  history?: string[];
  nextState: Partial<ReplState>;
}

/** state 唯一 mutation 点：把 nextState 合并进 state（兼容既有 test/simple-mode 契约） */
function applyNextState(state: ReplState, nextState: Partial<ReplState>): void {
  Object.assign(state, nextState);
}

// ── 命令注册表 ────────────────────────────────────

/**
 * 扁平命令注册表。execute 解析 `/<command> <args...>`：
 * - 命令已注册 -> 跑 run -> 应用 nextState -> 返回 output（调用方消费）
 * - 未注册 -> { handled: false }
 */
export class CommandRegistry {
  private entries = new Map<string, CommandEntry>();

  register(entry: CommandEntry): void {
    this.entries.set(entry.name, entry);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  list(): CommandEntry[] {
    return [...this.entries.values()];
  }

  /** help / autocomplete 使用的可见命令（过滤 hidden alias） */
  visibleList(): CommandEntry[] {
    return this.list().filter((entry) => !entry.hidden);
  }

  /**
   * 视图动作统一入口：与 execute 一样应用 nextState、捕获异常。
   * 渲染层不 import 命令实现，只按 source + actionId 路由回来。
   */
  async dispatchViewAction(
    source: string,
    invocation: ViewActionInvocation,
    ctx: ReplContext,
    state: ReplState,
  ): Promise<CommandResult> {
    const entry = this.entries.get(source);
    if (!entry?.viewAction) {
      return { handled: false, output: `\nNo view action handler for /${source}.\n` };
    }
    let result: CommandResult;
    try {
      result =
        (await entry.viewAction(invocation, ctx, state)) || ({ handled: true } as CommandResult);
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to handle /${source} ${invocation.actionId}:\n${formatRpcError(error)}\n`,
      };
    }
    if (result.nextState) applyNextState(state, result.nextState);
    return result;
  }

  async execute(input: string, ctx: ReplContext, state: ReplState): Promise<CommandResult> {
    const tokens = input.trim().split(/\s+/).filter(Boolean);
    const rawCommand = tokens[0];
    if (!rawCommand) return { handled: false };

    // 去掉开头的斜杠（如果用户输入了 /help，command 应该是 help）
    const command = rawCommand.startsWith('/') ? rawCommand.slice(1) : rawCommand;

    const entry = this.entries.get(command);
    if (!entry) return { handled: false };

    // 最后一道防线：单条命令的异常不得让 REPL 崩溃。
    // 命令自身已有的精确 catch（/tools、/sessions 等）优先，这里只兜未捕获的异常。
    let result: CommandResult;
    try {
      result = (await entry.run(tokens.slice(1), ctx, state)) || { handled: true };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to run /${entry.name}:\n${formatRpcError(error)}\n`,
      };
    }
    if (result.nextState) {
      applyNextState(state, result.nextState);
    }
    return result;
  }
}

/** 创建并填充命令注册表。ctx 在 execute 时传入，注册表本身无状态。 */
export function createCommands(): CommandRegistry {
  const reg = new CommandRegistry();
  reg.register(toolsCommand());
  reg.register(pluginsCommand());
  reg.register(resumeCommand());
  reg.register(mcpCommand());
  reg.register(runsCommand());
  reg.register(workflowsCommand());
  reg.register(metricsCommand());
  reg.register(feishuCommand());
  reg.register(capabilitiesCommand());
  reg.register(configCommand());
  reg.register(tenantCommand());
  reg.register(traceCommand());
  reg.register(sessionsCommand());
  reg.register(contextCommand());
  reg.register(compactCommand());
  reg.register(detailsCommand());
  reg.register(permissionsCommand());
  reg.register(exportCommand());
  reg.register(costCommand());
  reg.register(reasoningCommand());
  reg.register(newCommand());
  reg.register(historyCommand());
  reg.register(helpCommand(reg));
  reg.register(clearCommand());
  reg.register(setupCommand());
  reg.register(reloadCommand());
  reg.register(exitCommand());
  return reg;
}

// ── 帮助渲染 ──────────────────────────────────────

const CATEGORY_ORDER: CommandCategory[] = ['session', 'run', 'inspect', 'config', 'system'];
const CATEGORY_LABEL: Record<CommandCategory, string> = {
  session: 'SESSION',
  run: 'RUN',
  inspect: 'INSPECT',
  config: 'CONFIG',
  system: 'SYSTEM',
};

function renderHelp(reg: CommandRegistry, ctx: ReplContext): string {
  const lines: string[] = ['', 'Available commands:'];
  const visible = reg.visibleList();

  for (const category of CATEGORY_ORDER) {
    const entries = visible.filter((entry) => (entry.category ?? 'system') === category);
    if (entries.length === 0) continue;
    lines.push('');
    lines.push(`${CATEGORY_LABEL[category]}:`);
    for (const entry of entries) {
      const usage = entry.usage || `/${entry.name}`;
      // usage 必须完整可读：只用空格补齐，绝不截断（/trace、/workflows 的用法很长）。
      const padded = usage + ' '.repeat(Math.max(0, 30 - displayWidth(usage)));
      const unavailable =
        entry.available && !entry.available(ctx)
          ? ` (${entry.unavailableHint ?? 'unavailable'})`
          : '';
      lines.push(`  ${padded} ${entry.description}${unavailable}`);
    }
  }

  lines.push('');
  lines.push('Tips:');
  lines.push('  Ctrl+J   insert a newline (multi-line input)');
  lines.push('  ↑/↓      recall submitted input (outside the completion menu)');
  lines.push('  Esc      cancel the running turn (or clear the command list)');
  lines.push('  Ctrl+C   cancel the running turn; press again / when idle to exit');
  lines.push('  Ctrl+L   clear the screen');
  lines.push('  Ctrl+O   expand full tool output into scrollback');
  lines.push('  Resume   picker: ↑↓/jk move · / filter · enter open · r rename · x delete');
  lines.push('');
  return lines.join('\n');
}

// ── /resume ──────────────────────────────────────

function resumeCommand(): CommandEntry {
  return {
    name: 'resume',
    description: t('command.resume.description'),
    usage: '/resume [number|id|prefix|title #N|delete <id> --yes|rename <id> <title>]',
    category: 'session',
    keywords: ['session', 'switch', 'load', 'history'],
    run: async (args, ctx, state) => {
      // /resume delete <id> --yes（从 /sessions 迁移）
      if (args[0] === 'delete') {
        const target = args[1];
        const rest = args.slice(2);
        const extra = rest.filter((arg) => arg !== '--yes');
        if (target === undefined || extra.length > 0) {
          return {
            handled: true,
            output: '\nUsage: /resume delete <id> --yes\n',
          };
        }
        return deleteSessionAction(ctx, target, {
          confirmed: rest.includes('--yes'),
          currentSessionId: state.currentSessionId,
        });
      }

      // /resume rename <id> <title>
      if (args[0] === 'rename') {
        const target = args[1];
        const title = args.slice(2).join(' ').trim();
        if (target === undefined || title.length === 0) {
          return { handled: true, output: '\nUsage: /resume rename <id> <title>\n' };
        }
        return renameSessionAction(ctx, target, title);
      }

      if (args.length === 0) {
        let sessions: Awaited<ReturnType<typeof listSessions>>;
        try {
          sessions = await listSessions(ctx);
        } catch (error) {
          // 拉取失败必须显示错误，不能伪装成「无会话」。
          return {
            handled: true,
            output: `\nFailed to list sessions:\n${formatRpcError(error)}\n`,
          };
        }
        if (sessions.length === 0) {
          return { handled: true, output: '\nNo sessions to resume.\n' };
        }
        // Ink 模式由 showResumePicker 触发交互式选择器；simple 模式 fallback 到 pendingResume
        return {
          handled: true,
          output: '\nResume which session? Enter its number:\n',
          nextState: { showResumePicker: true, pendingResume: true },
        };
      }
      const resolved = await resolveResumeTarget(args.join(' '), ctx);
      if (!resolved.ok) {
        return { handled: true, output: `\n${resolved.message}\n` };
      }
      const { message, history, nextState } = await doResume(ctx, resolved.sessionId, {
        showReasoning: state.showReasoning ?? false,
      });
      return { handled: true, output: message, history, nextState };
    },
  };
}

/** /resume 的裸数字 one-shot--由 REPL 主循环在 pendingResume 时调入 */
export async function consumePendingResume(
  input: string,
  ctx: ReplContext,
  state: ReplState,
): Promise<CommandResult> {
  const num = Number.parseInt(input.trim(), 10);
  if (Number.isNaN(num) || num < 1) {
    const output = '\nCancelled resume (not a number).\n';
    applyNextState(state, { pendingResume: false });
    return { handled: true, output };
  }
  const sessions = await listSessions(ctx);
  const target = sessions[num - 1];
  if (!target) {
    const output = `\nNo session #${num}. Cancelled.\n`;
    applyNextState(state, { pendingResume: false });
    return { handled: true, output };
  }
  const { message, history, nextState } = await doResume(ctx, target.session_id, {
    showReasoning: state.showReasoning ?? false,
  });
  applyNextState(state, { ...nextState, pendingResume: false });
  return { handled: true, output: message, history };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 解析 resume 参数（Hermes 语义）：
 * 编号 → 精确 id → 唯一 id 前缀 → title（同名取最新；`title #N` 取第 N 新）。
 */
export async function resolveResumeTarget(
  arg: string,
  ctx: ReplContext,
): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> {
  const query = arg.trim();
  if (!query) return { ok: false, message: 'Usage: /resume <number|id|prefix|title>' };

  if (/^\d+$/.test(query)) {
    const num = Number.parseInt(query, 10);
    if (num >= 1) {
      const sessions = await listSessions(ctx);
      const target = sessions[num - 1];
      // 纯数字也可能是日期形式的 id 前缀（YYYYMMDD...），越界时继续按 id 解析。
      if (target) return { ok: true, sessionId: target.session_id };
    }
  }

  const exact = await getSessionState(ctx, query);
  if (exact) return { ok: true, sessionId: query };

  const sessions = await listSessions(ctx);
  const prefixMatches = sessions.filter((session) => session.session_id.startsWith(query));
  if (prefixMatches.length === 1) {
    return { ok: true, sessionId: prefixMatches[0]?.session_id ?? query };
  }
  if (prefixMatches.length > 1) {
    const candidates = prefixMatches
      .slice(0, 5)
      .map((session) => session.session_id)
      .join(', ');
    return {
      ok: false,
      message: `Session prefix "${query}" is ambiguous (${prefixMatches.length} matches: ${candidates}).`,
    };
  }

  // Hermes 语义：存在 "title #N" 变体时取最新（列表已按 updated_at 倒序）。
  const numbered = new RegExp(`^${escapeRegExp(query)} #\\d+$`);
  const numberedMatches = sessions.filter((session) => numbered.test(session.title));
  if (numberedMatches.length > 0) {
    return { ok: true, sessionId: numberedMatches[0]?.session_id ?? '' };
  }

  // title 精确匹配（含字面 "title #N"）。
  const exactTitle = sessions.filter((session) => session.title === query);
  if (exactTitle.length > 0) {
    return { ok: true, sessionId: exactTitle[0]?.session_id ?? '' };
  }

  // "base #N"：同名会话按更新时间取第 N 新（1-based）。
  const explicit = /^(.*\S)\s+#(\d+)$/.exec(query);
  if (explicit) {
    const base = explicit[1] ?? '';
    const index = Number.parseInt(explicit[2] ?? '0', 10);
    const sameTitle = sessions.filter(
      (session) => session.title.toLowerCase() === base.toLowerCase(),
    );
    if (sameTitle.length > 0) {
      const target = sameTitle[index - 1];
      if (!target) {
        return {
          ok: false,
          message: `No session "${base} #${index}" (${sameTitle.length} found).`,
        };
      }
      return { ok: true, sessionId: target.session_id };
    }
  }

  const caseInsensitive = sessions.filter(
    (session) => session.title.toLowerCase() === query.toLowerCase(),
  );
  if (caseInsensitive.length === 1) {
    return { ok: true, sessionId: caseInsensitive[0]?.session_id ?? '' };
  }

  return {
    ok: false,
    message: `Session "${query}" not found (tried exact id, unique id prefix, and title).`,
  };
}

/** resume 后回灌的历史：最多条数 / 单条字符上限 */
const RESUME_HISTORY_MESSAGES = 20;
const RESUME_HISTORY_MESSAGE_CHARS = 600;

export interface HistoryFormatOptions {
  /** 展示 assistant reasoning_content（默认 false） */
  showReasoning?: boolean;
}

/** 单条工具调用摘要（工具名 + 参数） */
function summarizeToolCalls(message: SessionMessageLike): string | null {
  if (!message.tool_calls?.length) return null;
  const calls = message.tool_calls.map((call) => {
    const name = call.function?.name ?? 'unknown';
    const raw = call.function?.arguments ?? '';
    let args = raw.replace(/\s+/g, ' ').trim();
    try {
      args = JSON.stringify(JSON.parse(raw));
    } catch {
      // 非 JSON 参数原样展示
    }
    return `${name}(${args.length > 160 ? `${args.slice(0, 160)}…` : args})`;
  });
  return calls.join(', ');
}

function reasoningLine(message: SessionMessageLike): string | null {
  const reasoning = message.reasoning_content?.trim();
  if (!reasoning) return null;
  const oneLine = reasoning.replace(/\s+/g, ' ');
  return `[reasoning] ${oneLine.length > 400 ? `${oneLine.slice(0, 400)}…` : oneLine}`;
}

/**
 * 纯函数：把最近 N 条消息格式化为可写入终端 scrollback 的行。
 * system 不展示；user/assistant/tool 用轻量角色前缀与竖线缩进。
 */
export function formatResumeHistory(
  messages: SessionMessageLike[],
  options: HistoryFormatOptions = {},
): string[] {
  const visible = messages.filter((message) => message.role !== 'system');
  if (visible.length === 0) return [];

  const recent = visible.slice(-RESUME_HISTORY_MESSAGES);
  const omitted = visible.length - recent.length;
  const lines = [
    '',
    `── history · last ${recent.length}${omitted > 0 ? ` of ${visible.length}` : ''} messages ──`,
    '',
  ];

  for (const message of recent) {
    const formatted = formatHistoryMessage(message, options).join('\n');
    const clipped =
      formatted.length > RESUME_HISTORY_MESSAGE_CHARS
        ? `${formatted.slice(0, RESUME_HISTORY_MESSAGE_CHARS)}…`
        : formatted;
    // 统一到 4 列，保证多行内容的竖线与首行对齐
    const label = message.role === 'user' ? 'you ' : message.role === 'assistant' ? 'ai  ' : 'tool';
    const [first = '', ...rest] = clipped.split('\n');
    lines.push(`  ${label} │ ${first}`);
    for (const line of rest) lines.push(`       │ ${line}`);
    lines.push('');
  }

  return lines;
}

/** 实际切会话：清 context -> 通知壳 -> 下次 run() 自动载入历史。
 *  纯函数：只返回确认消息 + 历史展示行 + 请求的 state 变更，不直接改 state、不打印。 */
export async function doResume(
  ctx: ReplContext,
  sessionId: string,
  options: HistoryFormatOptions = {},
): Promise<ResumeResult> {
  ctx.context.clear();
  ctx.onSessionChange(sessionId);
  const loaded = await getSessionState(ctx, sessionId);
  const messages = loaded?.messages ?? [];
  return {
    message: `Resumed session "${sessionId}" (${messages.length} messages).`,
    history: formatResumeHistory(messages, options),
    nextState: { currentSessionId: sessionId },
  };
}

// ── /new ─────────────────────────────────────────

function newCommand(): CommandEntry {
  return {
    name: 'new',
    description: t('command.new.description'),
    usage: '/new',
    category: 'session',
    keywords: ['new', 'session', 'create'],
    run: async (_args, ctx, state) => {
      const oldId = state.currentSessionId;
      try {
        const old = await getSessionState(ctx, oldId);
        if (old && old.messages.length === 0) {
          await deleteSession(ctx, oldId);
        }
      } catch {
        // 丢弃失败不阻塞开新会话
      }
      ctx.context.clear();
      const newId = ctx.newSessionId();
      ctx.onSessionChange(newId);
      return {
        handled: true,
        output: `\nNew session started: ${newId}\n`,
        nextState: { currentSessionId: newId },
      };
    },
  };
}

// ── /history ─────────────────────────────────────

/** 单条历史消息的展示上限（字符）；注入的整文件消息很容易上万字 */
const MAX_HISTORY_MESSAGE_CHARS = 1200;

/** 把一条历史消息格式化为若干展示行（注入文件只显示路径与大小） */
function formatHistoryMessage(
  msg: SessionMessageLike,
  options: HistoryFormatOptions = {},
): string[] {
  if (msg.role === 'user') {
    const fileMatch = msg.content.match(/^<file path="([^"]+)">/);
    if (fileMatch?.[1]) {
      return [
        t('history.userFile', { path: fileMatch[1] }),
        t('history.attachedFile', { chars: msg.content.length }),
      ];
    }
  }

  const lines: string[] = [];
  if (options.showReasoning) {
    const reasoning = reasoningLine(msg);
    if (reasoning) lines.push(reasoning);
  }

  if (msg.content.length <= MAX_HISTORY_MESSAGE_CHARS) {
    if (msg.content) lines.push(msg.content);
  } else {
    const omitted = msg.content.length - MAX_HISTORY_MESSAGE_CHARS;
    lines.push(
      `${msg.content.slice(0, MAX_HISTORY_MESSAGE_CHARS)}\n${t('history.omitted', {
        chars: omitted,
      })}`,
    );
  }

  const toolCalls = summarizeToolCalls(msg);
  if (toolCalls) lines.push(t('history.toolCalls', { calls: toolCalls }));
  if (msg.role === 'tool' && msg.name) lines.push(t('history.toolLabel', { name: msg.name }));
  return lines.length > 0 ? lines : [''];
}

export type HistoryRole = 'user' | 'assistant' | 'tool';

export interface HistoryOptions {
  /** 未显式指定时使用 HISTORY_LIMIT_DEFAULT（最近 50 条） */
  limit?: number;
  role?: HistoryRole;
  /** 单次覆盖 showReasoning；缺省用 ReplState.showReasoning */
  reasoning?: boolean;
}

const HISTORY_LIMIT_MAX = 500;
/** 无参 /history 的默认展示条数（只显示最近 N 条） */
export const HISTORY_LIMIT_DEFAULT = 50;
const HISTORY_ROLES: readonly HistoryRole[] = ['user', 'assistant', 'tool'];

/** 解析 /history 参数；未知参数直接给 usage，不发数据请求。 */
export function parseHistoryArgs(
  args: string[],
): { ok: true; value: HistoryOptions } | { ok: false; message: string } {
  let limit: number | undefined;
  let role: HistoryRole | undefined;
  let reasoning: boolean | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) break;

    if (arg === '--limit') {
      const value = args[++i];
      if (value === undefined || !/^\d+$/.test(value)) {
        return {
          ok: false,
          message: t('history.limitError', { max: HISTORY_LIMIT_MAX }),
        };
      }
      const parsed = Number.parseInt(value, 10);
      if (parsed < 1 || parsed > HISTORY_LIMIT_MAX) {
        return {
          ok: false,
          message: t('history.limitError', { max: HISTORY_LIMIT_MAX }),
        };
      }
      limit = parsed;
      continue;
    }

    if (arg === '--role') {
      const value = args[++i];
      if (value === undefined || !HISTORY_ROLES.includes(value as HistoryRole)) {
        return {
          ok: false,
          message: t('history.roleError', { roles: HISTORY_ROLES.join(', ') }),
        };
      }
      role = value as HistoryRole;
      continue;
    }

    if (arg === '--reasoning') {
      reasoning = true;
      continue;
    }

    if (arg === '--no-reasoning') {
      reasoning = false;
      continue;
    }

    return {
      ok: false,
      message: t('history.unknownArg', { usage: t('history.usage'), arg }),
    };
  }

  return {
    ok: true,
    value: {
      ...(limit !== undefined ? { limit } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    },
  };
}

function historyCommand(): CommandEntry {
  return {
    name: 'history',
    description: t('command.history.description'),
    usage: '/history [--limit <n>] [--role user|assistant|tool] [--reasoning|--no-reasoning]',
    category: 'session',
    keywords: ['history', 'transcript', 'messages'],
    run: async (args, ctx, state) => {
      const parsed = parseHistoryArgs(args);
      if (!parsed.ok) {
        return { handled: true, output: `\n${parsed.message}\n` };
      }

      const loaded = await getSessionState(ctx, state.currentSessionId);
      if (!loaded || loaded.messages.length === 0) {
        return { handled: true, output: `\n${t('history.empty')}\n` };
      }

      const { limit, role } = parsed.value;
      const scoped = role
        ? loaded.messages.filter((message) => message.role === role)
        : loaded.messages;
      if (scoped.length === 0) {
        return {
          handled: true,
          output: `\n${t('history.noMessages', { role: role ?? t('history.matching') })}\n`,
        };
      }

      // 先按 role 过滤，再取最近 N 条；无参默认只展示最近 50 条。
      const effectiveLimit = limit ?? HISTORY_LIMIT_DEFAULT;
      const shown = scoped.slice(-effectiveLimit);
      const header = t('history.header', {
        shown: shown.length,
        total: scoped.length,
        roleSuffix: role ? t('history.roleSuffix', { role }) : '',
        limit: effectiveLimit,
      });

      const showReasoning = parsed.value.reasoning ?? state.showReasoning ?? false;
      const lines = ['', `${header}${showReasoning ? t('history.reasoningOn') : ''}`];
      for (const msg of shown) {
        const label = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
        lines.push('');
        lines.push(`[${label}]`);
        lines.push(...formatHistoryMessage(msg, { showReasoning }));
      }
      lines.push('');
      return { handled: true, output: lines.join('\n') };
    },
  };
}

// ── /reasoning ───────────────────────────────────

function reasoningCommand(): CommandEntry {
  return {
    name: 'reasoning',
    description: t('command.reasoning.description'),
    usage: '/reasoning [on|off]',
    category: 'session',
    keywords: ['reasoning', 'thinking', 'history', 'toggle'],
    run: (args, _ctx, state) => {
      const value = (args[0] ?? '').toLowerCase();
      if (value && value !== 'on' && value !== 'off') {
        return { handled: true, output: '\nUsage: /reasoning [on|off]\n' };
      }
      const next =
        value === 'on' ? true : value === 'off' ? false : !(state.showReasoning ?? false);
      return {
        handled: true,
        output: `\nReasoning display: ${next ? 'on' : 'off'} (applies to /history and /resume).\n`,
        nextState: { showReasoning: next },
      };
    },
  };
}

// ── /tools ───────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** /tools 视图使用的归一化条目（RPC 与本地 PluginHost 同构） */
export interface ToolViewInfo {
  name: string;
  description: string;
  inputSchema?: unknown;
  /** mcp__<server>__<tool> 归为 mcp，其余为插件工具 */
  source: 'mcp' | 'plugin';
  /** 是否声明了权限判定（执行时可能 ask） */
  requiresApproval: boolean;
}

function toolSource(name: string): 'mcp' | 'plugin' {
  return name.startsWith('mcp__') ? 'mcp' : 'plugin';
}

function readToolList(value: unknown): ToolViewInfo[] {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.tools)
      ? value.tools
      : [];
  return raw
    .filter(
      (item): item is Record<string, unknown> => isRecord(item) && typeof item.name === 'string',
    )
    .map((item) => ({
      name: item.name as string,
      description: typeof item.description === 'string' ? item.description : '',
      ...(isRecord(item.input_schema) ? { inputSchema: item.input_schema } : {}),
      source: toolSource(item.name as string),
      requiresApproval: item.has_permission_check === true,
    }));
}

function readLocalTools(ctx: ReplContext): ToolViewInfo[] {
  return ctx.pluginHost.listTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    source: toolSource(tool.name),
    requiresApproval: typeof tool.checkPermission === 'function',
  }));
}

async function loadToolInfo(ctx: ReplContext): Promise<ToolViewInfo[]> {
  return ctx.rpc ? readToolList(await ctx.rpc.request<unknown>('tools.list')) : readLocalTools(ctx);
}

function truncateText(text: string, max: number): string {
  return truncateToWidth(text, max);
}

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 纯函数：工具列表视图（名称 + 截断描述 + source/permission 标记） */
export function buildToolsListView(tools: ToolViewInfo[]): ListView {
  return {
    kind: 'list',
    title: 'Tools',
    items: tools.map((tool) => ({
      key: tool.name,
      label: tool.name,
      description: truncateText(oneLine(tool.description), 96),
      badge: `${tool.source}${tool.requiresApproval ? ' · ask' : ''}`,
    })),
    actions: [{ id: 'inspect', key: 'enter', label: 'inspect', enabled: 'selected' }],
    emptyText: 'No tools registered.',
  };
}

/** 纯函数：schema 美化并限制行数/字符数（避免超大 schema 撑爆详情） */
export function formatToolSchema(schema: unknown, maxLines = 80, maxChars = 8000): string[] {
  if (schema === undefined || schema === null) return ['(none)'];
  let text: string;
  try {
    text = JSON.stringify(schema, null, 2) ?? '(none)';
  } catch {
    text = String(schema);
  }
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text;
  const lines = clipped.split('\n');
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`];
}

/** 纯函数：工具详情视图 */
export function buildToolDetailView(tool: ToolViewInfo): DetailView {
  return {
    kind: 'detail',
    title: `Tool: ${tool.name}`,
    key: tool.name,
    badge: { text: tool.source, tone: tool.source === 'mcp' ? 'info' : 'default' },
    sections: [
      {
        title: 'Overview',
        fields: [
          { label: 'Name', value: tool.name },
          { label: 'Source', value: tool.source },
          {
            label: 'Permission',
            value: tool.requiresApproval ? 'ask when invoked' : 'default policy',
          },
          { label: 'Description', value: tool.description || '-' },
        ],
      },
      { title: 'Input schema', lines: formatToolSchema(tool.inputSchema) },
    ],
  };
}

function readPluginNames(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.plugins)
      ? value.plugins
      : [];
  return raw
    .map((item) => (typeof item === 'string' ? item : isRecord(item) ? item.name : undefined))
    .filter((name): name is string => typeof name === 'string');
}

/** `/tools` 视图动作：Enter 打开工具详情（含完整描述与 input schema） */
export async function runToolsViewAction(
  invocation: ViewActionInvocation,
  ctx: ReplContext,
): Promise<CommandResult> {
  if (invocation.actionId !== 'inspect' && invocation.actionId !== 'enter') {
    return {
      handled: true,
      output: `\nUnknown /tools view action "${invocation.actionId}".\n`,
    };
  }
  const name = invocation.selectionKey || invocation.viewKey;
  if (!name) return { handled: true, output: '\nSelect a tool first.\n' };
  try {
    const tool = (await loadToolInfo(ctx)).find((item) => item.name === name);
    if (!tool) return { handled: true, output: `\nTool "${name}" not found.\n` };
    return {
      handled: true,
      view: { source: 'tools', view: buildToolDetailView(tool) },
    };
  } catch (error) {
    return {
      handled: true,
      output: `\nFailed to load tool "${name}":\n${formatRpcError(error)}\n`,
    };
  }
}

function toolsCommand(): CommandEntry {
  return {
    name: 'tools',
    description: t('command.tools.description'),
    usage: '/tools',
    category: 'inspect',
    keywords: ['plugins', 'capabilities', 'tools'],
    run: async (_args, ctx, _state) => {
      try {
        const list = await loadToolInfo(ctx);
        const view: ViewEnvelope = { source: 'tools', view: buildToolsListView(list) };
        if (list.length === 0) {
          return { handled: true, output: '\nNo tools registered.\n', view };
        }
        const lines = ['', `Available tools (${list.length}):`];
        for (const t of list) lines.push(`  - ${t.name}: ${t.description}`.trimEnd());
        lines.push('');
        return { handled: true, output: lines.join('\n'), view };
      } catch (error) {
        return { handled: true, output: `\nFailed to list tools:\n${formatRpcError(error)}\n` };
      }
    },
    viewAction: (invocation, ctx) => runToolsViewAction(invocation, ctx),
  };
}

// ── /plugins ─────────────────────────────────────

/** 纯函数：插件列表视图（名称列表足够清晰，无详情层） */
export function buildPluginsListView(plugins: string[]): ListView {
  return {
    kind: 'list',
    title: 'Loaded plugins',
    items: plugins.map((name) => ({ key: name, label: name, badge: 'plugin' })),
    emptyText: 'No plugins loaded.',
  };
}

function pluginsCommand(): CommandEntry {
  return {
    name: 'plugins',
    description: t('command.plugins.description'),
    usage: '/plugins',
    category: 'inspect',
    keywords: ['plugins', 'loaded'],
    run: async (_args, ctx, _state) => {
      try {
        const plugins = ctx.rpc
          ? readPluginNames(await ctx.rpc.request<unknown>('plugins.list'))
          : ctx.plugins;
        const view: ViewEnvelope = { source: 'plugins', view: buildPluginsListView(plugins) };
        if (plugins.length === 0) {
          return { handled: true, output: '\nNo plugins loaded.\n', view };
        }
        const lines = ['', `Loaded plugins (${plugins.length}):`];
        for (const p of plugins) lines.push(`  - ${p}`);
        lines.push('');
        return { handled: true, output: lines.join('\n'), view };
      } catch (error) {
        return {
          handled: true,
          output: `\nFailed to list plugins:\n${formatRpcError(error)}\n`,
        };
      }
    },
  };
}

// ── /help ─────────────────────────────────────────

function helpCommand(reg: CommandRegistry): CommandEntry {
  return {
    name: 'help',
    description: t('command.help.description'),
    usage: '/help',
    category: 'system',
    keywords: ['commands', 'usage'],
    run: (_args, ctx, _state) => ({ handled: true, output: renderHelp(reg, ctx) }),
  };
}

// ── /clear ────────────────────────────────────────

function clearCommand(): CommandEntry {
  return {
    name: 'clear',
    description: t('command.clear.description'),
    usage: '/clear',
    category: 'system',
    keywords: ['clear', 'screen'],
    run: () => ({ handled: true, clearScreen: true }),
  };
}

// ── /setup ────────────────────────────────────────

function setupCommand(): CommandEntry {
  return {
    name: 'setup',
    description: t('command.setup.description'),
    usage: '/setup',
    category: 'system',
    keywords: ['setup', 'config', 'wizard'],
    run: async (_args, _ctx, _state) => {
      // P0：向导用 readline 独占 stdin，与已挂载的 Ink 抢 raw mode 会串屏/失效。
      // 因此不在 REPL 内直接启动；给出准确的手动路径。
      const { getUserConfigPath } = await import('@vessel/config');
      return {
        handled: true,
        output: [
          '',
          'The setup wizard needs exclusive terminal access and cannot run inside the REPL.',
          `Config file: ${getUserConfigPath()}`,
          '',
          'To reconfigure:',
          '  1. Exit Vessel (Ctrl+C).',
          '  2. Edit the config file above, or remove its apiKey and restart to re-run first-run setup.',
          '',
        ].join('\n'),
      };
    },
  };
}

// ── /reload ───────────────────────────────────────

function reloadCommand(): CommandEntry {
  return {
    name: 'reload',
    description: t('command.reload.description'),
    usage: '/reload',
    category: 'system',
    keywords: ['reload', 'validate', 'config'],
    run: async (_args, ctx, _state) => {
      try {
        const { loadConfig } = await import('@vessel/config');
        const { config: newConfig, validation } = await loadConfig();
        const lines = [''];

        if (validation.errors.length > 0) {
          lines.push('✗ Configuration errors:');
          for (const e of validation.errors) lines.push(`  - ${e.message}`);
          lines.push('');
          return { handled: true, output: lines.join('\n') };
        }

        if (validation.warnings.length > 0) {
          lines.push('⚠ Configuration warnings:');
          for (const w of validation.warnings) lines.push(`  - ${w.message}`);
        }

        // 不修改 ctx.provider：runtime 仍持有旧 provider/model，改了展示字段只会让状态栏说谎。
        const configuredName = newConfig.provider?.name ?? ctx.provider.name;
        const configuredModel = newConfig.provider?.model ?? ctx.provider.model;
        lines.push('✓ Configuration validated.');
        lines.push('');
        lines.push(`Runtime (unchanged): ${ctx.provider.name} | ${ctx.provider.model}`);
        lines.push(`Configured:          ${configuredName} | ${configuredModel}`);
        lines.push('');
        lines.push(
          'Note: provider/model, plugins and permission policy are NOT reloaded. Restart Vessel to apply.',
        );
        lines.push('');
        return { handled: true, output: lines.join('\n') };
      } catch (e) {
        return {
          handled: true,
          output: `\n✗ Failed to reload: ${e instanceof Error ? e.message : e}\n`,
        };
      }
    },
  };
}

// ── /exit ─────────────────────────────────────────

function exitCommand(): CommandEntry {
  return {
    name: 'exit',
    description: t('command.exit.description'),
    usage: '/exit',
    category: 'system',
    keywords: ['quit', 'exit'],
    run: (_args, ctx, _state) => {
      ctx.onExit();
      return { handled: true, output: '\nGoodbye!\n', nextState: { running: false } };
    },
  };
}
