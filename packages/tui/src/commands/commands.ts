/**
 * 斜杠命令（二层分层：`/<domain> <action> [args]`）
 * @module @vessel/tui
 *
 * domain：/session（list|resume|new|history）、/tool（list）
 * 顶层：/help /clear /setup /exit
 * 全部从 ReplContext 取数；切会话经 ctx.context.clear() + ctx.onSessionChange()。
 * /session resume 照搬 Hermes pending one-shot：无参->编号列表 + 置 pending；下一行裸数字->恢复。
 */

import type { ReplContext } from '../repl-context.js';

// ── 类型 ──────────────────────────────────────────

/** REPL 运行态--命令读写，REPL 主循环持有 */
export interface ReplState {
  /** 当前会话 ID--/session new、/session resume 会改；chat 传它给 runtime.run() */
  currentSessionId: string;
  /** /session resume 无参后置位；下一行裸数字触发按编号恢复 */
  pendingResume: boolean;
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

/** 子命令执行函数签名 */
type Run = (
  args: string[],
  ctx: ReplContext,
  state: ReplState,
) => Promise<CommandResult> | CommandResult;

/** 子命令（domain 下的 action） */
export interface SubCommand {
  name: string;
  description: string;
  usage?: string;
  run: Run;
}

/** 顶层命令 或 域 */
export interface CommandEntry {
  name: string;
  description: string;
  usage?: string;
  /** 顶层命令的执行（无子命令时） */
  run?: Run;
  /** 域的子命令 */
  subcommands?: Map<string, SubCommand>;
}

// ── 命令注册表 ────────────────────────────────────

/**
 * 二层分层命令注册表。execute 解析 `/<domain> <action> <args...>`：
 * - domain 有子命令且 action 命中 -> 跑子命令
 * - domain 无 action 或 action 未命中 -> 显示域帮助
 * - 顶层命令（有 run） -> 跑 run
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
    const rawDomain = tokens[0];
    if (!rawDomain) return { handled: false };

    // 去掉开头的斜杠（如果用户输入了 /help，domain 应该是 help）
    const domain = rawDomain.startsWith('/') ? rawDomain.slice(1) : rawDomain;

    const entry = this.entries.get(domain);
    if (!entry) return { handled: false };

    const action = tokens[1];
    if (action && entry.subcommands?.has(action)) {
      const sub = entry.subcommands.get(action);
      if (!sub) return { handled: false };
      await sub.run(tokens.slice(2), ctx, state);
      return { handled: true };
    }

    // 顶层命令
    if (entry.run) {
      const result = await entry.run(tokens.slice(1), ctx, state);
      return result || { handled: true };
    }

    // 域无（有效）action -> 显示域帮助
    renderDomainHelp(entry);
    return { handled: true };
  }
}

/** 创建并填充命令注册表。ctx 在 execute 时传入，注册表本身无状态。 */
export function createCommands(): CommandRegistry {
  const reg = new CommandRegistry();
  reg.register(sessionDomain());
  reg.register(toolDomain());
  reg.register(helpCommand(reg));
  reg.register(clearCommand());
  reg.register(setupCommand());
  reg.register(reloadCommand());
  reg.register(exitCommand());
  return reg;
}

// ── 帮助渲染 ──────────────────────────────────────

function renderDomainHelp(entry: CommandEntry): void {
  console.log(`\n/${entry.name}  - ${entry.description}`);
  if (entry.subcommands && entry.subcommands.size > 0) {
    console.log('Subcommands:');
    for (const sub of entry.subcommands.values()) {
      console.log(`  /${entry.name} ${sub.name.padEnd(8)} - ${sub.description}`);
    }
  }
  console.log('');
}

// ── /session ──────────────────────────────────────

function sessionDomain(): CommandEntry {
  const subcommands = new Map<string, SubCommand>();

  subcommands.set('list', {
    name: 'list',
    description: '列出会话（编号，可用于 resume）',
    usage: '/session list',
    run: async (_args, ctx, state) => {
      const sessions = await ctx.session.listRich();
      if (sessions.length === 0) {
        console.log('\nNo sessions.\n');
        return { handled: true };
      }
      console.log('\nRecent sessions:');
      renderNumberedSessions(sessions, state.currentSessionId);
      console.log('');
      return { handled: true };
    },
  });

  subcommands.set('resume', {
    name: 'resume',
    description: '恢复会话：无参=列表+pending，N/id=直接恢复',
    usage: '/session resume [number|id]',
    run: async (args, ctx, state) => {
      if (args.length === 0) {
        const sessions = await ctx.session.listRich();
        if (sessions.length === 0) {
          console.log('\nNo sessions to resume.\n');
          return { handled: true };
        }
        console.log('\nResume which session? Enter its number:');
        renderNumberedSessions(sessions, state.currentSessionId);
        console.log('');
        state.pendingResume = true;
        return { handled: true };
      }
      const resolved = await resolveResumeTarget(args[0] ?? '', ctx);
      if (!resolved.ok) {
        console.log(`\n${resolved.message}\n`);
        return { handled: true };
      }
      await doResume(ctx, state, resolved.sessionId);
      return { handled: true };
    },
  });

  subcommands.set('new', {
    name: 'new',
    description: '开启新会话（丢弃当前空会话）',
    usage: '/session new',
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
      console.log(`\nNew session started: ${newId}\n`);
      return { handled: true };
    },
  });

  subcommands.set('history', {
    name: 'history',
    description: '显示当前会话的对话历史',
    usage: '/session history',
    run: async (_args, ctx, state) => {
      const loaded = await ctx.session.load(state.currentSessionId);
      if (!loaded || loaded.messages.length === 0) {
        console.log('\nNo conversation history.\n');
        return { handled: true };
      }
      console.log(`\nHistory (${loaded.messages.length} messages):`);
      for (const msg of loaded.messages) {
        const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
        console.log(`\n[${role}]`);
        console.log(msg.content);
      }
      console.log('');
      return { handled: true };
    },
  });

  return {
    name: 'session',
    description: '会话管理：list / resume / new / history',
    usage: '/session [list|resume|new|history]',
    subcommands,
  };
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

/** 解析 resume 参数：纯数字=按编号，否则按精确 session_id */
async function resolveResumeTarget(
  arg: string,
  ctx: ReplContext,
): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> {
  const num = Number.parseInt(arg, 10);
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

/** 编号渲染会话列表（resume 选择用） */
function renderNumberedSessions(
  sessions: { session_id: string; preview?: string; title?: string; message_count: number }[],
  currentId: string,
): void {
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (!s) continue;
    const cur = s.session_id === currentId ? ' *' : '';
    const preview = s.preview || s.title || '(no preview)';
    console.log(`  ${i + 1}. ${preview}  [${s.message_count} msgs]${cur}`);
    console.log(`     id: ${s.session_id}`);
  }
}

// ── /tool ─────────────────────────────────────────

function toolDomain(): CommandEntry {
  const subcommands = new Map<string, SubCommand>();

  subcommands.set('list', {
    name: 'list',
    description: '列出已注册工具',
    usage: '/tool list',
    run: (_args, ctx, _state) => {
      const list = ctx.tools.list();
      if (list.length === 0) {
        console.log('\nNo tools registered.\n');
        return { handled: true };
      }
      console.log(`\nAvailable tools (${list.length}):`);
      for (const t of list) console.log(`  - ${t.name}: ${t.description}`);
      console.log('');
      return { handled: true };
    },
  });

  return {
    name: 'tool',
    description: '工具：list',
    usage: '/tool [list]',
    subcommands,
  };
}

// ── /help ─────────────────────────────────────────

function helpCommand(reg: CommandRegistry): CommandEntry {
  return {
    name: 'help',
    description: '显示可用命令',
    usage: '/help [domain]',
    run: (args, _ctx, _state) => {
      const lines: string[] = ['', 'Available commands:'];

      // 动态生成帮助文本
      for (const entry of reg.list()) {
        if (entry.subcommands && entry.subcommands.size > 0) {
          // 有子命令的域
          for (const sub of entry.subcommands.values()) {
            const usage = sub.usage || `/${entry.name} ${sub.name}`;
            lines.push(`  ${usage.padEnd(26)} ${sub.description}`);
          }
        } else {
          // 顶层命令
          const usage = entry.usage || `/${entry.name}`;
          lines.push(`  ${usage.padEnd(26)} ${entry.description}`);
        }
      }

      lines.push('');
      if (args.length > 0) {
        const domain = reg.list().find((e) => e.name === args[0]);
        if (domain) {
          if (domain.subcommands && domain.subcommands.size > 0) {
            lines.push(`/${domain.name}  - ${domain.description}`);
            lines.push('Subcommands:');
            for (const sub of domain.subcommands.values()) {
              lines.push(`  /${domain.name} ${sub.name.padEnd(8)} - ${sub.description}`);
            }
          }
        } else {
          lines.push(`Unknown command: ${args[0]}`);
        }
      }

      // 输出到控制台（readline 版本）
      for (const line of lines) {
        console.log(line);
      }

      // 返回帮助文本（Ink 版本可以使用）
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
      return { handled: true };
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
      console.log('\nRunning setup wizard...');
      const userConfig = await runSetupWizard();
      if (userConfig.apiKey) {
        console.log(
          'Configuration saved. Restart Vessel for the new provider/key to take effect.\n',
        );
        console.log('Tip: Use /reload to reload configuration without restarting.\n');
      } else {
        console.log('Setup cancelled.\n');
      }
      return { handled: true };
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

        if (validation.errors.length > 0) {
          console.log('\n✗ Configuration errors:');
          for (const e of validation.errors) console.log(`  - ${e.message}`);
          console.log('');
          return { handled: true };
        }

        if (validation.warnings.length > 0) {
          console.log('\n⚠ Configuration warnings:');
          for (const w of validation.warnings) console.log(`  - ${w.message}`);
        }

        // 更新 provider 信息
        if (newConfig.provider) {
          ctx.provider.name = newConfig.provider.name ?? ctx.provider.name;
          ctx.provider.model = newConfig.provider.model ?? ctx.provider.model;
          ctx.provider.baseUrl = newConfig.provider.baseUrl ?? ctx.provider.baseUrl;
        }

        console.log('\n✓ Configuration reloaded.\n');
        console.log(`Provider: ${ctx.provider.name} | ${ctx.provider.model}`);
        console.log('');
      } catch (e) {
        console.log(`\n✗ Failed to reload: ${e instanceof Error ? e.message : e}\n`);
      }
      return { handled: true };
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
      return { handled: true };
    },
  };
}
