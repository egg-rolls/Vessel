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
 *
 * 壳/REPL 接缝（task 0）：壳负责 config→runtime→plugins→ctx→dispatch；
 * REPL 在 @vessel/tui startRepl(ctx) 内实现。
 */

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
} from '../packages/core/src/index';
import { runSetupWizard } from '../packages/tui/src/wizard/setup-wizard';
import { startRepl, type ReplContext } from '../packages/tui/src/index';

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
    if (next !== undefined && !next.startsWith('-')) {
      runArg = next;
      i++;
    } else {
      runArg = '';
    }
  } else if (a === '--pipe') {
    pipeMode = true;
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

const useMock = process.env.VESSEL_MOCK === '1' || process.env.VESSEL_MOCK === 'true';

if (!useMock && validation.errors.length > 0) {
  for (const e of validation.errors) console.error(`✗ ${e.message}`);
  process.exit(1);
}

if (validation.warnings.length > 0) {
  for (const w of validation.warnings) console.warn(`⚠ ${w.message}`);
}

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

// TODO(task 2): Provider 注册制——接 plugins/provider/* 的 registerProvider，
// 按 config.provider.name 选 provider，消掉硬编码。
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

// ── 会话 ────────────────────────────────────────

function newSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 6);
  return `${ts}_${hex}`;
}

let currentSessionId = sessionArg ?? newSessionId();

// ── 插件 ────────────────────────────────────────

// TODO(task 1): 插件加载机制——vessel.yaml plugins: [...] → 动态 import → inject runtime。
const plugins: Plugin[] = [metaToolsPlugin, skillsLoaderPlugin];

// ── Runtime ─────────────────────────────────────

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

// ── 构造 ReplContext（接缝契约）──────────────────

function buildReplContext(): ReplContext {
  return {
    runtime,
    tools,
    session,
    events,
    currentSessionId,
    onSessionChange: (id) => {
      currentSessionId = id;
    },
    provider: { name: providerName, model: providerModel, baseUrl: providerBaseUrl },
    plugins: plugins.map((p) => p.name),
    config,
    newSessionId,
    onExit: () => {
      runtime.dispose();
      process.exit(0);
    },
  };
}

// ── 入口分发 ────────────────────────────────────

if (headless) {
  await runHeadless();
} else {
  await startRepl(buildReplContext());
  // startRepl 返回 = /exit 触发 onExit——不走到此处
}

// ── headless：单轮，stdout 只放响应，状态走 stderr ─────────

async function runHeadless(): Promise<void> {
  const readStdin = runArg === '' || (runArg === null && pipeMode);
  let input: string;

  if (readStdin) {
    input = await Bun.stdin.text();
  } else if (runArg?.startsWith('@')) {
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

/** @file.json：多轮 seeding——历史存 session backend，最后一条 user 作输入 */
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
