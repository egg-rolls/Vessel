/**
 * 应用引导模块
 *
 * 负责：config → provider → plugins → runtime → ReplContext
 * 从 cli.ts 中提取，解决 #16 issue
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
  OpenAICompatibleProvider,
  type Plugin,
  SQLiteSessionBackend,
} from '../packages/core/src/index';
import type { ReplContext } from '../packages/tui/src/index';
import { createAskUserTool } from '../packages/tui/src/renderer/ask-user';
import { type PluginProvider, StaticRegistry } from './plugin-registry';

export interface BootstrapOptions {
  /** 使用 mock 模式 */
  useMock?: boolean;
  /** 会话 ID */
  sessionId?: string;
  /** 是否为 headless 模式 */
  headless?: boolean;
}

export interface BootstrapResult {
  runtime: AgentRuntime;
  ctx: ReplContext;
  config: Awaited<ReturnType<typeof loadConfig>>['config'];
  cleanup: () => void;
}

/**
 * 生成会话 ID
 */
export function newSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 6);
  return `${ts}_${hex}`;
}

/**
 * 引导应用启动
 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  const { useMock = false, sessionId, headless = false } = options;

  // ── 加载配置 ────────────────────────────────────
  const { config, validation } = await loadConfig();

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

  // ── Provider ────────────────────────────────────
  const pluginRegistry: PluginProvider = new StaticRegistry();
  const providerHost = new MemoryPluginHost();
  for (const name of pluginRegistry.getProviders()) {
    const p = await pluginRegistry.loadPlugin(name);
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

  let currentSessionId = sessionId ?? newSessionId();

  // ── 插件 ────────────────────────────────────────
  const configuredPlugins = config.plugins?.filter((p) => p.enabled !== false) ?? [];
  const defaultPluginNames =
    configuredPlugins.length > 0
      ? configuredPlugins.map((p) => p.name)
      : pluginRegistry.getAvailablePlugins().filter((name) => name !== 'hook-logging');
  // hook-logging 默认关闭，仅调试时启用
  if (process.env.VESSEL_DEBUG && !defaultPluginNames.includes('hook-logging')) {
    defaultPluginNames.push('hook-logging');
  }

  const plugins: Plugin[] = [];
  for (const name of defaultPluginNames) {
    if (name.startsWith('provider-')) continue;
    const p = await pluginRegistry.loadPlugin(name);
    if (p) plugins.push(p);
  }

  // ask-user 交互工具——普通工具对象（ADR-029，不再合成注册 + bridge）。
  // 仅交互模式注册；headless 无 TUI 订阅者，注册只会 waitFor 超时挂起。
  if (!headless) {
    tools.register(createAskUserTool());
  }

  // ── Runtime ─────────────────────────────────────
  const runtime = await AgentRuntime.create({
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
    // 默认权限策略（ADR-029）：交互模式 'ask'（未声明 checkPermission 的工具经事件流确认），
    // headless 'allow'（无 TUI 订阅者，工具自带 checkPermission 的 'ask' 由 headless-runner 自动允许）。
    permission: {
      default: headless ? 'allow' : 'ask',
      autoApprove: ['ask_user'],
    },
  });

  // 采集插件注册的工具定义（仅交互模式，供 /tools 展示）。
  // 注意：displayHost 与 runtime pluginHost 是各自 install 出的不同工具对象，这里只用于展示，
  // 不在此挂 checkPermission——默认权限策略由 runtime 统一判定（ADR-029，见 AgentRuntime.permission）。
  if (!headless) {
    const displayHost = new MemoryPluginHost();
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      for (const p of plugins) {
        try {
          await p.install(displayHost);
        } catch {
          // 采集失败不阻塞
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

  // ── ReplContext ─────────────────────────────────
  const ctx: ReplContext = {
    runtime,
    tools,
    session,
    events,
    context,
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

  return {
    runtime,
    ctx,
    config,
    cleanup: () => runtime.dispose(),
  };
}
