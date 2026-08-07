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
import {
  createPermissionGuardrail,
  ToolPermissionChecker,
} from '../packages/tui/src/renderer/tool-confirm';
import { AskUserBridge, createAskUserPlugin } from '../plugins/tools/ask-user/src/index';
import { PluginRegistry } from './plugin-registry';

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
  const pluginRegistry = new PluginRegistry();
  const providerHost = new MemoryPluginHost();
  const providerPluginNames = pluginRegistry.getNames().filter((k) => k.startsWith('provider-'));
  for (const name of providerPluginNames) {
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
  if (process.env.VESSEL_DEBUG) defaultPluginNames.push('hook-logging');

  const plugins: Plugin[] = [];
  for (const name of defaultPluginNames) {
    if (name.startsWith('provider-')) continue;
    const p = await pluginRegistry.loadPlugin(name);
    if (p) plugins.push(p);
  }

  // 工具权限确认 guardrail（仅交互模式）
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

  // ask-user 交互工具（仅交互模式）
  let askUserBridge: AskUserBridge | undefined;
  if (!headless) {
    askUserBridge = new AskUserBridge();
    plugins.push(createAskUserPlugin(askUserBridge));
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
  });

  // 采集插件注册的工具定义（仅交互模式）
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
    permissionChecker,
    askUserBridge,
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
