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
  MemoryPluginHost,
  MemoryToolRegistry,
  type Message,
  OpenAICompatibleProvider,
  type Plugin,
  SQLiteSessionBackend,
} from '../packages/core/src/index';
import { type ReplContext, startRepl } from '../packages/tui/src/index';
import {
  ToolPermissionChecker,
  createPermissionGuardrail,
} from '../packages/tui/src/renderer/tool-confirm';
import { runSetupWizard } from '../packages/tui/src/wizard/setup-wizard';

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
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      sessionArg = next;
      i++;
    }
    // 无值或下一个是 flag → sessionArg 保持 null，shell 会用 newSessionId()
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

if (headless && !useMock && !config.apiKey) {
  console.error('No API key configured. Run `vessel` interactively first to set up.');
  process.exit(1);
}

if (!useMock && !headless && !config.apiKey) {
  console.log('\n🔑 首次使用需要配置 API 连接\n');
  const userConfig = await runSetupWizard();
  if (userConfig.apiKey) {
    config.apiKey = userConfig.apiKey;
    if (userConfig.providers) {
      const p = Object.values(userConfig.providers)[0];
      if (p) {
        config.provider = {
          name: userConfig.defaultProvider ?? 'openai',
          apiKey: p.apiKey,
          baseUrl: p.baseUrl ?? config.provider?.baseUrl,
          model: userConfig.defaultModel ?? p.model ?? config.provider?.model,
        };
      }
    }
  } else {
    console.error('未配置 API Key，退出。');
    process.exit(1);
  }
}

// ── 插件加载 ────────────────────────────────────

/** Plugin name → module path 映射（约定：插件放在 plugins/{category}/{name}/src/index.ts） */
const PLUGIN_IMPORT_MAP: Record<string, string> = {
  'meta-tools': '../plugins/tools/meta-tools/src/index',
  'skills-loader': '../plugins/tools/skills-loader/src/index',
  'file-ops': '../plugins/tools/file-ops/src/index',
  'provider-openai': '../plugins/provider/openai/src/index',
  'provider-anthropic': '../plugins/provider/anthropic/src/index',
  'memory-project': '../plugins/memory/project/src/index',
  'memory-auto': '../plugins/memory/auto/src/index',
  'guardrail-pii': '../plugins/security/guardrail-pii/src/index',
  'redact-secrets': '../plugins/security/redact-secrets/src/index',
  'tool-policy': '../plugins/security/tool-policy/src/index',
  'mcp-client': '../plugins/integration/mcp-client/src/index',
  'hook-logging': '../plugins/observability/hook-logging/src/index',
};

async function loadPlugin(name: string): Promise<Plugin | null> {
  const importPath = PLUGIN_IMPORT_MAP[name];
  if (!importPath) {
    console.warn(`Unknown plugin "${name}" — not in import map. Skipping.`);
    return null;
  }
  try {
    const mod = (await import(importPath)) as { default?: Plugin };
    const plugin = mod.default;
    if (!plugin || typeof plugin.install !== 'function') {
      console.warn(`Plugin "${name}" has no default export with install().`);
      return null;
    }
    return plugin;
  } catch (e) {
    console.warn(`Failed to load plugin "${name}": ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// ── Provider（注册制——task 2）──────────────────

// 先加载所有 provider 插件，安装到临时 host 以构建 provider registry
const providerHost = new MemoryPluginHost();
const providerPluginNames = Object.keys(PLUGIN_IMPORT_MAP).filter((k) => k.startsWith('provider-'));
for (const name of providerPluginNames) {
  const p = await loadPlugin(name);
  if (p) p.install(providerHost);
}

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
  providerBaseUrl = config.provider?.baseUrl ?? '';

  const factory = providerHost.getProvider(providerName);
  if (factory) {
    provider = factory({
      api_key: config.apiKey ?? '',
      base_url: providerBaseUrl,
      model: providerModel,
      temperature: config.provider?.temperature,
      max_tokens: config.provider?.maxTokens,
    });
  } else {
    // 未注册的 provider（如首启向导对未知 BaseURL 产出的 "custom"）
    // -> 按 OpenAI 兼容处理（恢复 provider 注册制之前的默认行为），warn 不 exit
    console.warn(
      `Provider "${providerName}" not registered; treating as OpenAI-compatible` +
        ` (base_url: ${providerBaseUrl || 'default'}, model: ${providerModel}).`,
    );
    provider = new OpenAICompatibleProvider({
      api_key: config.apiKey ?? '',
      base_url: providerBaseUrl,
      model: providerModel,
      temperature: config.provider?.temperature,
      max_tokens: config.provider?.maxTokens,
    });
  }
}

// ── 组件 ────────────────────────────────────────

const tools = new MemoryToolRegistry();
const context = new MemoryContextManager({
  maxTokens: config.context?.maxTokens,
  maxMessages: config.context?.maxMessages,
  autoCompact: config.context?.autoCompact,
  compactThreshold: config.context?.compactThreshold,
});
const events = new MemoryEventStream();
const session = new SQLiteSessionBackend(config.session?.storagePath ?? './vessel.db');

// ── 会话 ────────────────────────────────────────

function newSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 6);
  return `${ts}_${hex}`;
}

let currentSessionId = sessionArg ?? newSessionId();

// ── 业务插件（task 1）───────────────────────────

// config.plugins 未配时加载默认插件；provider 插件已在前一步加载，此处跳过
const configuredPlugins = config.plugins?.filter((p) => p.enabled !== false) ?? [];
const defaultPluginNames =
  configuredPlugins.length > 0
    ? configuredPlugins.map((p) => p.name)
    : [
        'meta-tools',
        'skills-loader',
        'file-ops',
        'memory-project',
        'memory-auto',
        'guardrail-pii',
        'redact-secrets',
        'tool-policy',
        'mcp-client',
      ];
// VESSEL_DEBUG 时加 hook-logging（事件日志，便于调试；默认不开避免污染输出）
if (process.env.VESSEL_DEBUG) defaultPluginNames.push('hook-logging');
const plugins: Plugin[] = [];
for (const name of defaultPluginNames) {
  if (name.startsWith('provider-')) continue; // provider 已在临时 host 中加载
  const p = await loadPlugin(name);
  if (p) plugins.push(p);
}

// 工具权限确认 guardrail（仅交互模式--headless 不弹 readline confirm）
// 走 ADR-003/004 正路：包成 Plugin 注入 PluginHost，不塞 runtime 构造函数
// checker 提升到外层，传入 ReplContext 供 REPL 注入 promptFn（复用其 readline）
let permissionChecker: ToolPermissionChecker | undefined;
if (!headless) {
  permissionChecker = new ToolPermissionChecker({ enabled: true });
  const guardrail = createPermissionGuardrail(permissionChecker);
  plugins.push({
    name: 'tool-permission',
    install: (host) => {
      host.registerGuardrail(guardrail);
    },
  });
}

// ── Runtime ─────────────────────────────────────

const runtime = new AgentRuntime({
  provider,
  model: providerModel,
  tools,
  context,
  events,
  limits: config.limits ?? { requestLimit: 100, toolCallsLimit: 50 },
  termination: {
    maxIterations: config.termination?.maxIterations ?? 50,
    maxRuntimeSeconds: config.termination?.maxRuntimeSeconds,
  },
  session,
  plugins,
  systemPrompt: config.agent?.systemPrompt ?? '你是一个有用的 AI 助手。',
});

await runtime.ready;

// 采集插件注册的工具定义到 tools 注册表，供 /tool list 显示。
// 原因：runtime 内部 pluginHost 不对外暴露（core 冻结），插件工具只进 pluginHost；
// 必须在 runtime 构造之后做--构造时会把 tools.list() 复制进 pluginHost，若预先放入
// 插件工具会与插件 install 的同名工具冲突抛错。仅交互模式需要（headless 无 /tool list）。
if (!headless) {
  const displayHost = new MemoryPluginHost();
  const origLog = console.log;
  const origErr = console.error;
  // 抑制采集遍历的副作用日志（runtime 构造时已打印过）
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    for (const p of plugins) {
      try {
        await p.install(displayHost);
      } catch {
        // 采集失败不阻塞--runtime 已安装
      }
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  for (const t of displayHost.listTools()) {
    try {
      tools.register(t);
    } catch {
      // 重名工具跳过
    }
  }
}

// ── 构造 ReplContext（接缝契约）──────────────────

function buildReplContext(): ReplContext {
  return {
    runtime,
    tools,
    session,
    events,
    context,
    permissionChecker,
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
