/**
 * 应用引导模块
 *
 * 负责：config → provider → plugins → runtime → ReplContext
 * 从 cli.ts 中提取，解决 #16 issue
 */

import { DEFAULT_CONFIG, defaultModelForProvider, loadConfig } from '../packages/config/src/index';
import {
  AgentRuntime,
  type LLMProvider,
  MemoryContextManager,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  OpenAICompatibleProvider,
  type Plugin,
} from '../packages/core/src/index';
import type { ReplContext } from '../packages/tui/src/index';
import { createAskUserTool } from '../packages/tui/src/renderer/ask-user';
import { createDelegateTaskPlugin } from '../plugins/tools/delegate-task/src/index';
import { PluginLoader } from './plugin-loader';
import { resolvePluginNames } from './plugin-selection';
import { createSessionBackend } from './session-factory';

export interface BootstrapOptions {
  /** 使用 mock 模式 */
  useMock?: boolean;
  /** 会话 ID */
  sessionId?: string;
  /** 是否为 headless 模式 */
  headless?: boolean;
  /**
   * 是否实际进入交互式 REPL 且 stdin 是 TTY。
   * 非交互（headless / serve-only / 管道）时无 Key 必须快速失败，不能进首启向导。
   */
  interactive?: boolean;
  /** 是否注册 ask_user（默认 = interactive；headless 下注册只会让 waitFor 超时） */
  registerAskUser?: boolean;
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
  const {
    useMock = false,
    sessionId,
    headless = false,
    interactive = !headless,
    registerAskUser = interactive,
  } = options;

  // ── 加载配置 ────────────────────────────────────
  const { config, validation } = await loadConfig();

  if (!useMock && validation.errors.length > 0) {
    for (const e of validation.errors) console.error(`✗ ${e.message}`);
    process.exit(1);
  }

  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) console.warn(`⚠ ${w.message}`);
  }

  if (!useMock && !interactive && !config.apiKey) {
    console.error('No API key configured. Run `vessel` interactively first to set up.');
    process.exit(1);
  }

  // ── 插件发现 ────────────────────────────────────
  // 唯一的发现机制：运行时扫描 plugins/<category>/<name>/（PluginLoader，ADR-028）。
  const loader = new PluginLoader();

  // ── Provider ────────────────────────────────────
  // provider 类插件单独装配（不进 plugins 列表）：它们只 registerProvider，贡献工厂。
  const providerHost = new MemoryPluginHost();
  for (const name of loader.getProviders()) {
    const p = await loader.load(name);
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
    const configuredModel = config.provider?.model ?? defaultModelForProvider(providerName);
    if (!configuredModel) {
      console.error(
        `Provider "${providerName}" has no model configured. ` +
          'Set provider.model in vessel.yaml or ~/.vessel/config.yaml.',
      );
      process.exit(1);
    }
    providerModel = configuredModel;
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
  const context = new MemoryContextManager({
    maxTokens: config.context?.maxTokens,
    maxMessages: config.context?.maxMessages,
    autoCompact: config.context?.autoCompact,
    compactThreshold: config.context?.compactThreshold,
  });
  const events = new MemoryEventStream();
  const session = createSessionBackend(config.session);

  let currentSessionId = sessionId ?? newSessionId();

  // ── 插件 ────────────────────────────────────────
  // 插件选择与 `--tools` 共用同一策略，避免默认集漂移。
  const defaultPluginNames = resolvePluginNames(
    loader,
    config.plugins,
    Boolean(process.env.VESSEL_DEBUG),
  );

  const plugins: Plugin[] = [];
  for (const name of defaultPluginNames) {
    const p = await loader.load(name);
    if (p) plugins.push(p);
  }

  // 子 agent 分派（delegate_task）：工厂式插件，需注入 provider 工厂 + model，
  // 不走通用注册表（其 default export 是 createDelegateTaskPlugin 工厂而非 Plugin 实例）。
  // `delegate.enabled: false` 时不注册，运行期工具从 4 个变为 3 个。
  if (config.delegate?.enabled !== false) {
    plugins.push(
      createDelegateTaskPlugin({
        providerFactory: () => provider,
        model: config.delegate?.model ?? providerModel,
        maxDepth: config.delegate?.maxDepth,
        disallowed: config.delegate?.disallowed,
        limits: config.delegate?.limits,
        termination: config.delegate?.termination
          ? {
              maxIterations: config.delegate.termination.maxIterations ?? 10,
              maxRuntimeSeconds: config.delegate.termination.maxRuntimeSeconds,
            }
          : undefined,
      }),
    );
  }

  // ask-user 交互工具——以插件形式注册（唯一工具入口是 PluginHost）。
  // 只有"实际进入 REPL 且 stdin 是 TTY"才注册；headless / serve-only / 管道
  // 都没有 TUI 订阅者，注册只会让 waitFor 超时挂起。
  if (registerAskUser) {
    plugins.push({
      name: 'ask-user',
      version: '0.1.0',
      description: 'Ask-user interactive tool (ADR-029)',
      install(host) {
        host.registerTool(createAskUserTool());
      },
    });
  }

  // ── Runtime ─────────────────────────────────────
  const runtime = await AgentRuntime.create({
    provider,
    model: providerModel,
    context,
    events,
    // 默认值只在 DEFAULT_CONFIG 一处定义，这里不再写第二份数字。
    limits: config.limits ?? DEFAULT_CONFIG.limits ?? {},
    termination: {
      maxIterations:
        config.termination?.maxIterations ?? DEFAULT_CONFIG.termination?.maxIterations ?? 20,
      maxRuntimeSeconds:
        config.termination?.maxRuntimeSeconds ?? DEFAULT_CONFIG.termination?.maxRuntimeSeconds,
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

  // ── ReplContext ─────────────────────────────────
  // 工具/插件的唯一来源是 runtime.pluginHost（插件在 install() 里注册，
  // 与 runtime 用的是同一个 host）——/tools、/plugins 直接读它，不再二次 install。
  const ctx: ReplContext = {
    runtime,
    pluginHost: runtime.pluginHost,
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
