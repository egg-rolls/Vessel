/**
 * 斜杠命令（扁平结构：`/<command> [args]`）
 * @module @vessel/tui
 *
 * 命令清单（ADR-020）：
 * /tools - 工具浏览器
 * /plugins - 插件浏览器
 * /mcp - MCP 浏览器
 * /skills - Skills 浏览器
 * /assets - 资产总览仪表盘
 * /resume - 恢复会话
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
 * state 应用与 output 打印集中在 CommandRegistry.execute()（兼容既有 test / simple-mode 契约）。
 */

import type { ReplContext } from '../repl-context.js';

// ── 类型 ──────────────────────────────────────────

/** REPL 运行态--命令只读，execute 按 nextState 统一应用 */
export interface ReplState {
  /** 当前会话 ID--/new、/resume 会改；chat 传它给 runtime.run() */
  currentSessionId: string;
  /** /resume 无参后置位；下一行裸数字触发按编号恢复 */
  pendingResume: boolean;
  /** /resume 无参时显示交互式选择器（Ink 模式） */
  showResumePicker: boolean;
  /** 主循环运行标志--/exit 置 false 退出 */
  running: boolean;
}

/** 命令执行结果 */
export interface CommandResult {
  /** 是否已识别并处理（false = 未知命令，由调用方提示） */
  handled: boolean;
  /** 命令输出文本（调用方显示；simple 模式由 execute 打印） */
  output?: string;
  /** 命令请求的 state 变更（execute 统一应用到 state） */
  nextState?: Partial<ReplState>;
  /** /clear 等需要 REPL 层清屏的命令置 true（替代硬编码字符串匹配） */
  clearScreen?: boolean;
}

/** 命令执行函数签名 */
type Run = (
  args: string[],
  ctx: ReplContext,
  state: ReplState,
) => Promise<CommandResult> | CommandResult;

/** 命令条目 */
export interface CommandEntry {
  name: string;
  description: string;
  usage?: string;
  /** 命令执行函数 */
  run: Run;
}

/** execute 选项：Ink 模式传 print:false，改由调用方消费 result.output */
export interface ExecuteOptions {
  /** 是否在执行层打印 output（simple 模式/测试默认 true） */
  print?: boolean;
}

/** 恢复会话结果（doResume 纯函数返回） */
export interface ResumeResult {
  message: string;
  nextState: Partial<ReplState>;
}

/** state 唯一 mutation 点：把 nextState 合并进 state（兼容既有 test/simple-mode 契约） */
function applyNextState(state: ReplState, nextState: Partial<ReplState>): void {
  Object.assign(state, nextState);
}

// ── 命令注册表 ────────────────────────────────────

/**
 * 扁平命令注册表。execute 解析 `/<command> <args...>`：
 * - 命令已注册 -> 跑 run -> 应用 nextState -> 按需打印 output
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

  async execute(
    input: string,
    ctx: ReplContext,
    state: ReplState,
    options: ExecuteOptions = {},
  ): Promise<CommandResult> {
    const tokens = input.trim().split(/\s+/).filter(Boolean);
    const rawCommand = tokens[0];
    if (!rawCommand) return { handled: false };

    // 去掉开头的斜杠（如果用户输入了 /help，command 应该是 help）
    const command = rawCommand.startsWith('/') ? rawCommand.slice(1) : rawCommand;

    const entry = this.entries.get(command);
    if (!entry) return { handled: false };

    const result = (await entry.run(tokens.slice(1), ctx, state)) || { handled: true };
    if (options.print !== false && result.output) {
      console.log(result.output);
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
  reg.register(mcpCommand());
  reg.register(skillsCommand());
  reg.register(assetsCommand());
  reg.register(resumeCommand());
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

function renderHelp(reg: CommandRegistry): string {
  const lines: string[] = ['', 'Available commands:'];

  for (const entry of reg.list()) {
    const usage = entry.usage || `/${entry.name}`;
    lines.push(`  ${usage.padEnd(26)} ${entry.description}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ── /resume ──────────────────────────────────────

function resumeCommand(): CommandEntry {
  return {
    name: 'resume',
    description: '恢复会话：无参=交互式选择器，N/id=直接恢复',
    usage: '/resume [number|id]',
    run: async (args, ctx, _state) => {
      if (args.length === 0) {
        const sessions = await ctx.session.listRich();
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
      const resolved = await resolveResumeTarget(args[0] ?? '', ctx);
      if (!resolved.ok) {
        return { handled: true, output: `\n${resolved.message}\n` };
      }
      const { message, nextState } = await doResume(ctx, resolved.sessionId);
      return { handled: true, output: message, nextState };
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
    console.log(output);
    applyNextState(state, { pendingResume: false });
    return { handled: true, output };
  }
  const sessions = await ctx.session.listRich();
  const target = sessions[num - 1];
  if (!target) {
    const output = `\nNo session #${num}. Cancelled.\n`;
    console.log(output);
    applyNextState(state, { pendingResume: false });
    return { handled: true, output };
  }
  const { message, nextState } = await doResume(ctx, target.session_id);
  console.log(`\n${message}\n`);
  applyNextState(state, { ...nextState, pendingResume: false });
  return { handled: true, output: message };
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

/** 实际切会话：清 context -> 通知壳 -> 下次 run() 自动载入历史。
 *  纯函数：只返回确认消息 + 请求的 state 变更，不直接改 state、不打印。 */
export async function doResume(ctx: ReplContext, sessionId: string): Promise<ResumeResult> {
  ctx.context.clear();
  ctx.onSessionChange(sessionId);
  const loaded = await ctx.session.load(sessionId);
  const msgCount = loaded?.messages.length ?? 0;
  return {
    message: `Resumed session "${sessionId}" (${msgCount} messages).`,
    nextState: { currentSessionId: sessionId },
  };
}

// ── /new ─────────────────────────────────────────

function newCommand(): CommandEntry {
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

function historyCommand(): CommandEntry {
  return {
    name: 'history',
    description: '显示当前会话的对话历史',
    usage: '/history',
    run: async (_args, ctx, state) => {
      const loaded = await ctx.session.load(state.currentSessionId);
      if (!loaded || loaded.messages.length === 0) {
        return { handled: true, output: '\nNo conversation history.\n' };
      }
      const lines = ['', `History (${loaded.messages.length} messages):`];
      for (const msg of loaded.messages) {
        const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
        lines.push('');
        lines.push(`[${role}]`);
        lines.push(msg.content);
      }
      lines.push('');
      return { handled: true, output: lines.join('\n') };
    },
  };
}

// ── /tools ───────────────────────────────────────

function toolsCommand(): CommandEntry {
  return {
    name: 'tools',
    description: '列出已注册工具',
    usage: '/tools',
    run: (_args, ctx, _state) => {
      const list = ctx.tools.list();
      if (list.length === 0) {
        return { handled: true, output: '\nNo tools registered.\n' };
      }
      const lines = ['', `Available tools (${list.length}):`];
      for (const t of list) lines.push(`  - ${t.name}: ${t.description}`);
      lines.push('');
      return { handled: true, output: lines.join('\n') };
    },
  };
}

// ── /plugins ─────────────────────────────────────

function pluginsCommand(): CommandEntry {
  return {
    name: 'plugins',
    description: '列出已加载插件',
    usage: '/plugins',
    run: (_args, ctx, _state) => {
      const plugins = ctx.plugins;
      if (plugins.length === 0) {
        return { handled: true, output: '\nNo plugins loaded.\n' };
      }
      const lines = ['', `Loaded plugins (${plugins.length}):`];
      for (const p of plugins) lines.push(`  - ${p}`);
      lines.push('');
      return { handled: true, output: lines.join('\n') };
    },
  };
}

// ── /mcp ─────────────────────────────────────────

function mcpCommand(): CommandEntry {
  return {
    name: 'mcp',
    description: '列出 MCP 服务器状态',
    usage: '/mcp',
    run: (_args, ctx, _state) => {
      const mcpTools = ctx.tools.list().filter((t) => t.name.startsWith('mcp_'));
      const clientPlugins = ctx.plugins.filter((p) => p.toLowerCase().includes('mcp'));
      if (mcpTools.length === 0) {
        const via = clientPlugins.length > 0 ? '' : '（mcp-client 插件未加载）';
        return { handled: true, output: `\nNo MCP tools loaded${via}.\n` };
      }
      const via = clientPlugins.length > 0 ? ` via ${clientPlugins.join(', ')}` : '';
      const lines = ['', `MCP (${mcpTools.length} tools${via}):`];
      for (const t of mcpTools) lines.push(`  - ${t.name}: ${t.description}`);
      lines.push('');
      return { handled: true, output: lines.join('\n') };
    },
  };
}

// ── /skills ──────────────────────────────────────

function skillsCommand(): CommandEntry {
  return {
    name: 'skills',
    description: '列出可用 Skills',
    usage: '/skills',
    run: (_args, ctx, _state) => {
      const skillTools = ctx.tools.list().filter((t) => t.name.includes('skill'));
      const loaderPlugins = ctx.plugins.filter((p) => p.toLowerCase().includes('skill'));
      if (skillTools.length === 0) {
        const via = loaderPlugins.length > 0 ? '' : '（skills-loader 插件未加载）';
        return { handled: true, output: `\nNo skills loaded${via}.\n` };
      }
      const via = loaderPlugins.length > 0 ? ` via ${loaderPlugins.join(', ')}` : '';
      const lines = ['', `Skills (${skillTools.length} tools${via}):`];
      for (const t of skillTools) lines.push(`  - ${t.name}: ${t.description}`);
      lines.push('');
      return { handled: true, output: lines.join('\n') };
    },
  };
}

// ── /assets ──────────────────────────────────────

function assetsCommand(): CommandEntry {
  return {
    name: 'assets',
    description: '资产总览仪表盘',
    usage: '/assets',
    run: (_args, ctx, _state) => {
      const assetTools = ctx.tools.list().filter((t) => t.name.includes('asset'));
      const lines = [
        '',
        `Assets (${assetTools.length} asset tools registered):`,
        ...assetTools.map((t) => `  - ${t.name}: ${t.description}`),
        '',
      ];
      return { handled: true, output: lines.join('\n') };
    },
  };
}

// ── /help ─────────────────────────────────────────

function helpCommand(reg: CommandRegistry): CommandEntry {
  return {
    name: 'help',
    description: '显示可用命令',
    usage: '/help',
    run: (_args, _ctx, _state) => ({ handled: true, output: renderHelp(reg) }),
  };
}

// ── /clear ────────────────────────────────────────

function clearCommand(): CommandEntry {
  return {
    name: 'clear',
    description: '清屏',
    usage: '/clear',
    run: () => ({ handled: true, clearScreen: true }),
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
      return { handled: true, output: lines.join('\n') };
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
    description: '退出',
    usage: '/exit',
    run: (_args, ctx, _state) => {
      ctx.onExit();
      return { handled: true, output: '\nGoodbye!\n', nextState: { running: false } };
    },
  };
}
