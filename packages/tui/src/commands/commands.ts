/**
 * 斜杠命令（扁平结构：`/<command> [args]`）
 * @module @vessel/tui
 *
 * 所有命令均为顶层：/sessions /resume /new /history /delete /tools /help /clear /setup /reload /exit
 * 全部从 ReplContext 取数；切会话经 ctx.context.clear() + ctx.onSessionChange()。
 * /resume 照搬 Hermes pending one-shot：无参->编号列表 + 置 pending；下一行裸数字->恢复。
 */

import type { ReplContext } from '../repl-context.js';

// ── 类型 ──────────────────────────────────────────

/** REPL 运行态--命令读写，REPL 主循环持有 */
export interface ReplState {
  /** 当前会话 ID--/new、/resume 会改；chat 传它给 runtime.run() */
  currentSessionId: string;
  /** /resume 无参后置位；下一行裸数字触发按编号恢复 */
  pendingResume: boolean;
  /** /delete 无参后置位；下一行裸数字触发按编号删除 */
  pendingDelete: boolean;
  /** 主循环运行标志--/exit 置 false 退出 */
  running: boolean;
}

/** 命令执行结果 */
export interface CommandResult {
  /** 是否已识别并处理（false = 未知命令，由调用方提示） */
  handled: boolean;
  /** 命令输出文本（可选，Ink 版本用于显示） */
  output?: string;
}

/** 命令执行函数签名 */
type Run = (
  args: string[],
  ctx: ReplContext,
  state: ReplState,
) => Promise<CommandResult> | CommandResult;

/** 顶层命令 */
export interface CommandEntry {
  name: string;
  description: string;
  usage?: string;
  run: Run;
}

// ── 命令注册表 ────────────────────────────────────

/**
 * 扁平命令注册表。execute 解析 `/<command> [args...]`：
 * - 命令命中 -> 跑 run
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

  async execute(input: string, ctx: ReplContext, state: ReplState): Promise<CommandResult> {
    const tokens = input.trim().split(/\s+/).filter(Boolean);
    const raw = tokens[0];
    if (!raw) return { handled: false };

    const name = raw.startsWith('/') ? raw.slice(1) : raw;
    const entry = this.entries.get(name);
    if (!entry) return { handled: false };

    const result = await entry.run(tokens.slice(1), ctx, state);
    return result || { handled: true };
  }
}

/** 创建并填充命令注册表。ctx 在 execute 时传入，注册表本身无状态。 */
export function createCommands(): CommandRegistry {
  const reg = new CommandRegistry();
  reg.register(sessionsCommand());
  reg.register(resumeCommand());
  reg.register(newSessionCommand());
  reg.register(historyCommand());
  reg.register(deleteCommand());
  reg.register(toolsCommand());
  reg.register(helpCommand(reg));
  reg.register(clearCommand());
  reg.register(setupCommand());
  reg.register(reloadCommand());
  reg.register(exitCommand());
  return reg;
}

// ── /sessions ─────────────────────────────────────

function sessionsCommand(): CommandEntry {
  return {
    name: 'sessions',
    description: '列出所有会话',
    usage: '/sessions',
    run: async (_args, ctx, state) => {
      const sessions = await ctx.session.listRich();
      if (sessions.length === 0) {
        const output = '\nNo sessions.\n';
        console.log(output);
        return { handled: true, output };
      }
      const lines = ['', 'Recent sessions:'];
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        if (!s) continue;
        const cur = s.session_id === state.currentSessionId ? ' *' : '';
        const preview = s.preview || s.title || '(no preview)';
        lines.push(`  ${i + 1}. ${preview}  [${s.message_count} msgs]${cur}`);
        lines.push(`     id: ${s.session_id}`);
      }
      lines.push('');
      const output = lines.join('\n');
      console.log(output);
      return { handled: true, output };
    },
  };
}

// ── /resume ──────────────────────────────────────

function resumeCommand(): CommandEntry {
  return {
    name: 'resume',
    description: '恢复会话：无参=选择列表，N/id=直接恢复',
    usage: '/resume [number|id]',
    run: async (args, ctx, state) => {
      if (args.length === 0) {
        const sessions = await ctx.session.listRich();
        if (sessions.length === 0) {
          const output = '\nNo sessions to resume.\n';
          console.log(output);
          return { handled: true, output };
        }
        const lines = ['', 'Resume which session? Enter its number:'];
        for (let i = 0; i < sessions.length; i++) {
          const s = sessions[i];
          if (!s) continue;
          const cur = s.session_id === state.currentSessionId ? ' *' : '';
          const preview = s.preview || s.title || '(no preview)';
          lines.push(`  ${i + 1}. ${preview}  [${s.message_count} msgs]${cur}`);
          lines.push(`     id: ${s.session_id}`);
        }
        lines.push('');
        state.pendingResume = true;
        const output = lines.join('\n');
        console.log(output);
        return { handled: true, output };
      }
      const resolved = await resolveResumeTarget(args[0] ?? '', ctx);
      if (!resolved.ok) {
        const output = `\n${resolved.message}\n`;
        console.log(output);
        return { handled: true, output };
      }
      await doResume(ctx, state, resolved.sessionId);
      return { handled: true };
    },
  };
}

// ── /new ─────────────────────────────────────────

function newSessionCommand(): CommandEntry {
  return {
    name: 'new',
    description: '开启新会话（丢弃当前空会话）',
    usage: '/new',
    run: async (_args, ctx, state) => {
      const oldId = state.currentSessionId;
      try {
        const old = await ctx.session.load(oldId);
        if (old && old.messages.length === 0) {
          await ctx.session.delete(oldId);
        }
      } catch {
        // 丢弃失败不阻塞开新会话
      }
      ctx.context.clear();
      const newId = ctx.newSessionId();
      state.currentSessionId = newId;
      ctx.onSessionChange(newId);
      const output = `\nNew session started: ${newId}\n`;
      console.log(output);
      return { handled: true, output };
    },
  };
}

// ── /history ─────────────────────────────────────

function historyCommand(): CommandEntry {
  return {
    name: 'history',
    description: '显示当前会话的对话历史',
    usage: '/history',
    run: async (_args, ctx, state) => {
      const loaded = await ctx.session.load(state.currentSessionId);
      if (!loaded || loaded.messages.length === 0) {
        const output = '\nNo conversation history.\n';
        console.log(output);
        return { handled: true, output };
      }
      const lines = ['', `History (${loaded.messages.length} messages):`];
      for (const msg of loaded.messages) {
        const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
        lines.push('');
        lines.push(`[${role}]`);
        lines.push(msg.content);
      }
      lines.push('');
      const output = lines.join('\n');
      console.log(output);
      return { handled: true, output };
    },
  };
}

// ── /delete ──────────────────────────────────────

function deleteCommand(): CommandEntry {
  return {
    name: 'delete',
    description: '删除会话：无参=选择列表，N/id=直接删除',
    usage: '/delete [number|id]',
    run: async (args, ctx, state) => {
      if (args.length === 0) {
        const sessions = await ctx.session.listRich();
        if (sessions.length === 0) {
          const output = '\nNo sessions to delete.\n';
          console.log(output);
          return { handled: true, output };
        }
        const lines = ['', 'Delete which session? Enter its number:'];
        for (let i = 0; i < sessions.length; i++) {
          const s = sessions[i];
          if (!s) continue;
          const cur = s.session_id === state.currentSessionId ? ' *' : '';
          const preview = s.preview || s.title || '(no preview)';
          lines.push(`  ${i + 1}. ${preview}  [${s.message_count} msgs]${cur}`);
          lines.push(`     id: ${s.session_id}`);
        }
        lines.push('');
        state.pendingDelete = true;
        const output = lines.join('\n');
        console.log(output);
        return { handled: true, output };
      }
      const resolved = await resolveResumeTarget(args[0] ?? '', ctx);
      if (!resolved.ok) {
        const output = `\n${resolved.message}\n`;
        console.log(output);
        return { handled: true, output };
      }
      await ctx.session.delete(resolved.sessionId);
      const output = `\nDeleted session "${resolved.sessionId}".\n`;
      console.log(output);
      if (resolved.sessionId === state.currentSessionId) {
        ctx.context.clear();
        const newId = ctx.newSessionId();
        state.currentSessionId = newId;
        ctx.onSessionChange(newId);
        console.log(`Started new session: ${newId}\n`);
      }
      return { handled: true, output };
    },
  };
}

/** /delete 的裸数字 one-shot--由 REPL 主循环在 pendingDelete 时调入 */
export async function consumePendingDelete(
  input: string,
  ctx: ReplContext,
  state: ReplState,
): Promise<CommandResult> {
  state.pendingDelete = false;
  const num = Number.parseInt(input.trim(), 10);
  if (Number.isNaN(num) || num < 1) {
    console.log('\nCancelled delete (not a number).\n');
    return { handled: true };
  }
  const sessions = await ctx.session.listRich();
  const target = sessions[num - 1];
  if (!target) {
    console.log(`\nNo session #${num}. Cancelled.\n`);
    return { handled: true };
  }
  await ctx.session.delete(target.session_id);
  console.log(`\nDeleted session "${target.session_id}".\n`);
  if (target.session_id === state.currentSessionId) {
    ctx.context.clear();
    const newId = ctx.newSessionId();
    state.currentSessionId = newId;
    ctx.onSessionChange(newId);
    console.log(`Started new session: ${newId}\n`);
  }
  return { handled: true };
}

/** /session resume 的裸数字 one-shot--由 REPL 主循环在 pendingResume 时调入 */
export async function consumePendingResume(
  input: string,
  ctx: ReplContext,
  state: ReplState,
): Promise<CommandResult> {
  state.pendingResume = false;
  const num = Number.parseInt(input.trim(), 10);
  if (Number.isNaN(num) || num < 1) {
    console.log('\nCancelled resume (not a number).\n');
    return { handled: true };
  }
  const sessions = await ctx.session.listRich();
  const target = sessions[num - 1];
  if (!target) {
    console.log(`\nNo session #${num}. Cancelled.\n`);
    return { handled: true };
  }
  await doResume(ctx, state, target.session_id);
  return { handled: true };
}

/** 解析 resume/delete 参数：纯数字=按编号，否则按精确 session_id */
async function resolveResumeTarget(
  arg: string,
  ctx: ReplContext,
): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> {
  const num = /^\d+$/.test(arg) ? Number.parseInt(arg, 10) : Number.NaN;
  if (!Number.isNaN(num) && num >= 1) {
    const sessions = await ctx.session.listRich();
    const target = sessions[num - 1];
    if (!target) return { ok: false, message: `No session #${num}.` };
    return { ok: true, sessionId: target.session_id };
  }
  const loaded = await ctx.session.load(arg);
  if (!loaded) return { ok: false, message: `Session "${arg}" not found.` };
  return { ok: true, sessionId: arg };
}

/** 实际切会话：清 context -> 通知壳 -> 下次 run() 自动载入历史 */
async function doResume(ctx: ReplContext, state: ReplState, sessionId: string): Promise<void> {
  ctx.context.clear();
  state.currentSessionId = sessionId;
  ctx.onSessionChange(sessionId);
  const loaded = await ctx.session.load(sessionId);
  const msgCount = loaded?.messages.length ?? 0;
  console.log(`\nResumed session "${sessionId}" (${msgCount} messages).\n`);
}

// ── /tools ────────────────────────────────────────

function toolsCommand(): CommandEntry {
  return {
    name: 'tools',
    description: '列出已注册工具',
    usage: '/tools',
    run: (_args, ctx, _state) => {
      const list = ctx.tools.list();
      if (list.length === 0) {
        const output = '\nNo tools registered.\n';
        console.log(output);
        return { handled: true, output };
      }
      const lines = ['', `Available tools (${list.length}):`];
      for (const t of list) lines.push(`  - ${t.name}: ${t.description}`);
      lines.push('');
      const output = lines.join('\n');
      console.log(output);
      return { handled: true, output };
    },
  };
}

// ── /help ─────────────────────────────────────────

function helpCommand(reg: CommandRegistry): CommandEntry {
  return {
    name: 'help',
    description: '显示可用命令',
    usage: '/help',
    run: (_args, _ctx, _state) => {
      const lines: string[] = ['', 'Available commands:'];

      for (const entry of reg.list()) {
        const usage = entry.usage || `/${entry.name}`;
        lines.push(`  ${usage.padEnd(16)} ${entry.description}`);
      }

      lines.push('');

      for (const line of lines) {
        console.log(line);
      }

      return { handled: true, output: lines.join('\n') };
    },
  };
}

// ── /clear ────────────────────────────────────────

function clearCommand(): CommandEntry {
  return {
    name: 'clear',
    description: '清屏',
    usage: '/clear',
    run: () => {
      console.clear();
      return { handled: true, output: '' };
    },
  };
}

// ── /setup ────────────────────────────────────────

function setupCommand(): CommandEntry {
  return {
    name: 'setup',
    description: '重新运行首启配置向导',
    usage: '/setup',
    run: async (_args, _ctx, _state) => {
      const { runSetupWizard } = await import('../wizard/setup-wizard.js');
      const lines = ['', 'Running setup wizard...'];
      const userConfig = await runSetupWizard();
      if (userConfig.apiKey) {
        lines.push('Configuration saved. Restart Vessel for the new provider/key to take effect.');
        lines.push('');
        lines.push('Tip: Use /reload to reload configuration without restarting.');
      } else {
        lines.push('Setup cancelled.');
      }
      lines.push('');
      const output = lines.join('\n');
      console.log(output);
      return { handled: true, output };
    },
  };
}

// ── /reload ───────────────────────────────────────

function reloadCommand(): CommandEntry {
  return {
    name: 'reload',
    description: '重新加载配置（不重启）',
    usage: '/reload',
    run: async (_args, ctx, _state) => {
      try {
        const { loadConfig } = await import('../../../config/src/index.js');
        const { config: newConfig, validation } = await loadConfig();
        const lines = [''];

        if (validation.errors.length > 0) {
          lines.push('✗ Configuration errors:');
          for (const e of validation.errors) lines.push(`  - ${e.message}`);
          lines.push('');
          const output = lines.join('\n');
          console.log(output);
          return { handled: true, output };
        }

        if (validation.warnings.length > 0) {
          lines.push('⚠ Configuration warnings:');
          for (const w of validation.warnings) lines.push(`  - ${w.message}`);
        }

        // 更新 provider 信息
        if (newConfig.provider) {
          ctx.provider.name = newConfig.provider.name ?? ctx.provider.name;
          ctx.provider.model = newConfig.provider.model ?? ctx.provider.model;
          ctx.provider.baseUrl = newConfig.provider.baseUrl ?? ctx.provider.baseUrl;
        }

        lines.push('✓ Configuration reloaded.');
        lines.push('');
        lines.push(`Provider: ${ctx.provider.name} | ${ctx.provider.model}`);
        lines.push('');
        const output = lines.join('\n');
        console.log(output);
        return { handled: true, output };
      } catch (e) {
        const output = `\n✗ Failed to reload: ${e instanceof Error ? e.message : e}\n`;
        console.log(output);
        return { handled: true, output };
      }
    },
  };
}

// ── /exit ─────────────────────────────────────────

function exitCommand(): CommandEntry {
  return {
    name: 'exit',
    description: '退出',
    usage: '/exit',
    run: (_args, ctx, state) => {
      state.running = false;
      ctx.onExit();
      return { handled: true, output: '\nGoodbye!\n' };
    },
  };
}
