/**
 * Vessel CLI 入口
 *
 * 运行方式：
 *   bun run src/cli.ts                           交互式 REPL（直进对话）
 *   bun run src/cli.ts --run "<prompt>"            headless 单轮（文本参数）
 *   bun run src/cli.ts --run @path                 headless：.json=多轮 seeding，其它=文本 prompt
 *   echo "..." | bun run src/cli.ts --run          headless 单轮（stdin）
 *   bun run src/cli.ts --session <id> --run "..."  续接指定会话
 *
 * --run 是唯一 headless 入口：有参=文本/@file，无参=stdin。--pipe 保留为隐藏别名（= --run 无参）。
 * 首次运行无 API Key 时自动触发首启向导（仅交互模式）。
 */

import * as readline from 'node:readline';
import { loadConfig } from '../packages/config/src/index';
import {
  AgentRuntime,
  type LLMProvider,
  MemoryContextManager,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryToolRegistry,
  type Message,
  OpenAICompatibleProvider,
  type Plugin,
  SQLiteSessionBackend,
  type SessionInfo,
} from '../packages/core/src/index';
import { buildBanner, divider, infoPanel } from '../packages/tui/src/rich-renderer';
import { runSetupWizard } from '../packages/tui/src/wizard/setup-wizard';

import { metaToolsPlugin } from '../plugins/tools/meta-tools/src/index';
import { skillsLoaderPlugin } from '../plugins/tools/skills-loader/src/index';

// ── argv 解析 ────────────────────────────────────

const argv = process.argv.slice(2);
// runArg: null=非 headless；''=无参（读 stdin）；非空=文本 prompt 或 @file
let runArg: string | null = null;
let pipeMode = false; // --pipe 隐藏别名，等价 --run 无参（读 stdin）
let sessionArg: string | null = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--run' || a === '-r') {
    const next = argv[i + 1];
    // 仅当下一个 token 存在且不像 flag 时，才当作 prompt 参数；否则按"无参"读 stdin
    if (next !== undefined && !next.startsWith('-')) {
      runArg = next;
      i++;
    } else {
      runArg = '';
    }
  } else if (a === '--pipe') {
    pipeMode = true; // 隐藏别名，等价 --run 无参
  } else if (a === '--session' || a === '-s') {
    sessionArg = argv[++i] ?? '';
  } else if (a === '--help' || a === '-h') {
    console.log(`Vessel CLI

  bun run src/cli.ts                              交互式 REPL（直进对话）
  bun run src/cli.ts --run "<prompt>"               headless 单轮（文本参数）
  bun run src/cli.ts --run @path                    headless：.json=多轮 seeding，其它=文本 prompt
  echo "..." | bun run src/cli.ts --run             headless 单轮（stdin）
  bun run src/cli.ts --session <id> --run "..."     续接会话
  VESSEL_MOCK=1 bun run src/cli.ts --run "x"        mock 模式（不调 API）`);
    process.exit(0);
  }
}
const headless = runArg !== null || pipeMode;

// ── 加载配置 ────────────────────────────────────

const { config, validation } = await loadConfig();

// VESSEL_MOCK=1 时使用内存 Provider，跳过 API Key 检查（用于测试/调试）
const useMock = process.env.VESSEL_MOCK === '1' || process.env.VESSEL_MOCK === 'true';

// mock 模式跳过 provider 配置校验；否则 fail-fast（缺 model 等不再静默）
if (!useMock && validation.errors.length > 0) {
  for (const e of validation.errors) console.error(`✗ ${e.message}`);
  process.exit(1);
}

if (validation.warnings.length > 0) {
  for (const w of validation.warnings) console.warn(`⚠ ${w.message}`);
}

// headless 模式下无 Key 直接报错（不能弹向导）
if (headless && !useMock && !config.api_key) {
  console.error('No API key configured. Run `vessel` interactively first to set up.');
  process.exit(1);
}

if (!useMock && !headless && !config.api_key) {
  console.log('\n🔑 首次使用需要配置 API 连接\n');
  const userConfig = await runSetupWizard();
  if (userConfig.api_key) {
    config.api_key = userConfig.api_key;
    if (userConfig.providers) {
      const p = Object.values(userConfig.providers)[0];
      if (p) {
        config.provider = {
          name: userConfig.default_provider ?? 'openai',
          api_key: p.api_key,
          base_url: p.base_url ?? config.provider?.base_url,
          model: userConfig.default_model ?? p.model ?? config.provider?.model,
        };
      }
    }
  } else {
    console.error('未配置 API Key，退出。');
    process.exit(1);
  }
}

// ── Provider ────────────────────────────────────

let provider: LLMProvider;
let providerName: string;
let providerModel: string;
let providerBaseUrl: string;

if (useMock) {
  providerName = 'mock';
  providerModel = 'mock-model';
  providerBaseUrl = 'memory';
  provider = new MemoryLLMProvider();
} else {
  providerName = config.provider?.name ?? 'openai';
  providerModel = config.provider?.model ?? 'gpt-4';
  providerBaseUrl = config.provider?.base_url ?? 'https://api.openai.com/v1';
  provider = new OpenAICompatibleProvider({
    api_key: config.api_key ?? '',
    base_url: providerBaseUrl,
    model: providerModel,
    temperature: config.provider?.temperature,
    max_tokens: config.provider?.max_tokens,
  });
}

// ── 组件 ────────────────────────────────────────

const tools = new MemoryToolRegistry();
const context = new MemoryContextManager({
  maxTokens: config.context?.max_tokens,
  maxMessages: config.context?.max_messages,
  autoCompact: config.context?.auto_compact,
  compactThreshold: config.context?.compact_threshold,
});
const events = new MemoryEventStream();
const session = new SQLiteSessionBackend(config.session?.storage_path ?? './vessel.db');

let currentSessionId = sessionArg ?? newSessionId();
const plugins: Plugin[] = [metaToolsPlugin, skillsLoaderPlugin];

const runtime = new AgentRuntime({
  provider,
  model: providerModel,
  tools,
  context,
  events,
  limits: config.limits ?? { request_limit: 100, tool_calls_limit: 50 },
  termination: {
    max_iterations: config.termination?.max_iterations ?? 50,
    max_runtime_seconds: config.termination?.max_runtime_seconds,
    stop_on_no_tool_calls: config.termination?.stop_on_no_tool_calls ?? true,
  },
  session,
  plugins,
  systemPrompt: config.agent?.system_prompt ?? '你是一个有用的 AI 助手。',
});

await runtime.ready;

// ── 入口分发 ────────────────────────────────────

if (headless) {
  await runHeadless();
} else {
  await runInteractive();
}

// ── headless：单轮，stdout 只放响应，状态走 stderr ─────────

async function runHeadless(): Promise<void> {
  // stdin：--run 无参，或 --pipe 别名
  const readStdin = runArg === '' || (runArg === null && pipeMode);
  let input: string;

  if (readStdin) {
    input = await Bun.stdin.text();
  } else if (runArg?.startsWith('@')) {
    // @file：.json = messages 数组（多轮 seeding）；其它扩展名 = 文本 prompt
    const filePath = runArg.slice(1);
    if (filePath.endsWith('.json')) {
      input = await seedFromMessagesFile(filePath, currentSessionId);
    } else {
      input = await Bun.file(filePath).text();
    }
  } else {
    input = runArg ?? '';
  }

  input = input.trim();
  if (!input) {
    console.error('No input.');
    process.exit(1);
  }
  console.error(`[vessel] ${providerName} | ${providerModel} | session ${currentSessionId}`);
  try {
    const resp = await runtime.run(input, currentSessionId);
    console.log(resp);
    runtime.dispose?.();
    process.exit(0);
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    runtime.dispose?.();
    process.exit(1);
  }
}

/**
 * 从 messages 文件 seeding 多轮历史（`--run @file.json`）。
 * 把除最后一条 user 外的历史存入 session backend，run() 经已测好的恢复路径加载，
 * 再以最后一条 user 作为本次输入。零 core 改动。
 * @returns 最后一条 user 消息的 content（作为 run() 的输入）
 */
async function seedFromMessagesFile(filePath: string, sessionId: string): Promise<string> {
  let raw: string;
  try {
    raw = await Bun.file(filePath).text();
  } catch {
    console.error(`Error: cannot read file "${filePath}".`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`Error: "${filePath}" is not valid JSON.`);
    process.exit(1);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.error(`Error: "${filePath}" must contain a non-empty JSON array of messages.`);
    process.exit(1);
  }
  const msgs = parsed as Message[];
  for (const m of msgs) {
    if (!m || typeof m.role !== 'string' || typeof m.content !== 'string') {
      console.error(`Error: each message in "${filePath}" needs {role, content} (both strings).`);
      process.exit(1);
    }
  }
  const last = msgs[msgs.length - 1];
  if (!last) {
    // unreachable：msgs 非空已校验；noUncheckedIndexedAccess 下需显式收窄
    console.error(`Error: "${filePath}" contains no messages.`);
    process.exit(1);
  }
  if (last.role !== 'user') {
    console.error(`Error: last message in "${filePath}" must be role "user" (got "${last.role}").`);
    process.exit(1);
  }

  const history = msgs.slice(0, -1);
  if (history.length > 0) {
    await session.save({
      run_id: crypto.randomUUID(),
      session_id: sessionId,
      messages: history,
      started_at: Date.now(),
      status: 'completed',
    });
  }
  return last.content;
}

// ── 交互：直进对话，不弹会话选择门 ───────────────────────

async function runInteractive(): Promise<void> {
  // 仅交互模式创建 readline：headless 不抢占 stdin，且避免 rl 在声明前被访问（TDZ）
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(buildBanner());
  const statusText = `${providerName}  |  ${providerBaseUrl}  |  ${providerModel}  |  session: ${currentSessionId}  |  plugins: ${plugins.map((p) => p.name).join(', ')}`;
  console.log(infoPanel('Status', statusText));
  console.log('Type /help for commands. /resume 找回历史会话。\n');
  startChat(rl);
}

// ── REPL ────────────────────────────────────────

/** pending resume：bare /resume 列出后，下一个裸数字即恢复对应会话（one-shot） */
let pendingResume: SessionInfo[] | null = null;

function showHelp() {
  console.log(divider());
  console.log(`
Commands:
  /resume [n|id|title]  找回历史会话（无参进选择界面）
  /sessions             列出所有会话
  /new [id]             开新会话
  /history              当前会话历史
  /tools                列出可用工具
  /clear                清屏
  /setup                重新配置 API 连接
  /exit                 退出
`);
}

async function startChat(rl: readline.Interface) {
  const prompt = () => {
    rl.question('vessel> ', async (input) => {
      const t = input.trim();
      if (!t) {
        prompt();
        return;
      }

      // pending resume：bare /resume 后下一个裸数字 -> 恢复（one-shot，非数字则放行）
      if (pendingResume) {
        const list = pendingResume;
        pendingResume = null;
        if (/^\d+$/.test(t)) {
          const idx = Number(t);
          if (idx < 1 || idx > list.length) {
            console.log(`  Resume index ${idx} out of range (1-${list.length}).`);
          } else {
            const target = list[idx - 1];
            if (target) await resumeSession(target.session_id);
          }
          prompt();
          return;
        }
        // 非数字 -> 继续当命令/聊天处理
      }

      if (['/exit', '/quit', 'exit', 'quit'].includes(t)) {
        console.log('Goodbye.\n');
        runtime.dispose?.();
        rl.close();
        return;
      }
      if (t === '/help') {
        showHelp();
        prompt();
        return;
      }
      if (t === '/tools') {
        const list = tools.list();
        console.log(divider());
        for (const tool of list) console.log(`  ${tool.name}  -  ${tool.description}`);
        console.log();
        prompt();
        return;
      }
      if (t === '/sessions') {
        await printSessionList();
        prompt();
        return;
      }
      if (t === '/resume' || t.startsWith('/resume ')) {
        await handleResume(t.slice('/resume'.length).trim());
        prompt();
        return;
      }
      if (t === '/history') {
        await showHistory();
        prompt();
        return;
      }
      if (t.startsWith('/new')) {
        const id = t.slice(4).trim() || newSessionId();
        await discardIfEmpty(currentSessionId);
        currentSessionId = id;
        console.log(`New session: ${currentSessionId}\n`);
        prompt();
        return;
      }
      if (t === '/clear') {
        console.clear();
        prompt();
        return;
      }
      if (t === '/setup') {
        await runSetupWizard();
        console.log('Restart to apply.\n');
        prompt();
        return;
      }

      // 普通对话
      try {
        console.log('\nThinking...');
        const response = await runtime.run(t, currentSessionId);
        console.log(`\n${divider()}`);
        console.log(response);
        console.log(`\n${divider()}\n`);
      } catch (error) {
        console.error(`Error: ${error}\n`);
      }
      prompt();
    });
  };
  prompt();
}

// ── session 辅助 ────────────────────────────────

/** 生成 session id：{YYYYMMDD_HHMMSS}_{6hex}（照搬 Hermes） */
function newSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 6);
  return `${ts}_${hex}`;
}

/** 相对时间（照搬 Hermes _relative_time） */
function relativeTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d > 1 ? 's' : ''} ago`;
}

/** 打印会话列表（编号，照搬 Hermes _show_recent_sessions 格式） */
async function printSessionList(): Promise<void> {
  const sessions = await session.listRich();
  if (sessions.length === 0) {
    console.log('  No sessions yet.\n');
    return;
  }
  console.log('\n  Recent sessions:\n');
  console.log(
    `  ${'#'.padEnd(4)} ${'Session ID'.padEnd(24)} ${'Msgs'.padEnd(5)} ${'Status'.padEnd(11)} ${'Last Active'.padEnd(13)} Preview`,
  );
  console.log(
    `  ${'─'.repeat(3)}  ${'─'.repeat(22)} ${'─'.repeat(4)}  ${'─'.repeat(9)}  ${'─'.repeat(11)}  ${'─'.repeat(24)}`,
  );
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (!s) continue;
    const id = s.session_id.padEnd(22);
    const msgs = String(s.message_count).padEnd(4);
    const status = s.status.padEnd(9);
    const last = relativeTime(s.updated_at).padEnd(11);
    const preview = (s.preview || '').slice(0, 38);
    console.log(`  ${String(i + 1).padEnd(3)} ${id} ${msgs} ${status} ${last} ${preview}`);
  }
  console.log('\n  Use /resume <number> or /resume <session id> to continue.');
  console.log('  Example: /resume 2\n');
}

/** /resume 解析：无参列表+arm pending / 数字 / id / title 模糊（照搬 Hermes） */
async function handleResume(arg: string): Promise<void> {
  // 去掉用户可能照打的 <>
  let name = arg;
  if (name.length >= 2) {
    const pairs: [string, string][] = [
      ['<', '>'],
      ['[', ']'],
      ['"', '"'],
      ["'", "'"],
    ];
    for (const [a, b] of pairs) {
      if (name[0] === a && name[name.length - 1] === b) {
        name = name.slice(1, -1).trim();
        break;
      }
    }
  }

  if (!name) {
    const sessions = await session.listRich();
    if (sessions.length === 0) {
      console.log('  No resumable sessions.\n');
      return;
    }
    await printSessionList();
    pendingResume = sessions; // arm：下一个裸数字即恢复
    console.log('  (输入编号恢复，或输入其它内容继续当前对话)\n');
    return;
  }

  // 数字 -> 按列表编号
  if (/^\d+$/.test(name)) {
    const sessions = await session.listRich();
    const idx = Number(name);
    if (idx < 1 || idx > sessions.length) {
      console.log(`  Resume index ${idx} out of range (1-${sessions.length}).\n`);
      return;
    }
    const target = sessions[idx - 1];
    if (target) await resumeSession(target.session_id);
    return;
  }

  // 精确 id
  const byId = await session.load(name);
  if (byId) {
    await resumeSession(name);
    return;
  }

  // title / id 子串模糊
  const sessions = await session.listRich();
  const lower = name.toLowerCase();
  const match = sessions.find(
    (s) => s.title.toLowerCase().includes(lower) || s.session_id.toLowerCase().includes(lower),
  );
  if (match) {
    await resumeSession(match.session_id);
    return;
  }

  console.log(`  No session matching "${name}". Use /resume to list.\n`);
}

/** 恢复会话：切 currentSessionId（历史由 run() 从 backend 加载） */
async function resumeSession(sessionId: string): Promise<void> {
  const state = await session.load(sessionId);
  if (!state) {
    console.log(`  Session "${sessionId}" not found.\n`);
    return;
  }
  await discardIfEmpty(currentSessionId);
  currentSessionId = sessionId;
  console.log(
    `  Resumed session "${sessionId}" (${state.messages.length} messages). /history 查看\n`,
  );
}

/** 丢弃空会话（照搬 Hermes _discard_session_if_empty，避免空会话堆满 /resume） */
async function discardIfEmpty(sessionId: string): Promise<void> {
  const state = await session.load(sessionId);
  if (state && state.messages.length === 0) {
    await session.delete(sessionId);
  }
}

/** 显示当前会话历史 */
async function showHistory(): Promise<void> {
  const state = await session.load(currentSessionId);
  const msgs = state?.messages ?? [];
  if (msgs.length === 0) {
    console.log('No history.\n');
    return;
  }
  console.log(divider());
  for (const m of msgs) {
    const role =
      m.role === 'assistant' ? '🤖' : m.role === 'user' ? '👤' : m.role === 'system' ? '⚙️' : '🔧';
    const content = (m.content ?? '').slice(0, 200);
    console.log(`${role} ${content}${m.content && m.content.length > 200 ? '...' : ''}`);
  }
  console.log();
}
