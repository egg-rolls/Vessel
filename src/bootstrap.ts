/**
 * 应用引导模块
 *
 * 负责：config → provider → plugins → runtime → ReplContext
 * 从 cli.ts 中提取，解决 #16 issue
 */

import { DEFAULT_CONFIG, defaultModelForProvider, loadConfig } from '../packages/config/src/index';
import {
  AgentRuntime,
  type AgentStatus,
  type LLMProvider,
  MemoryContextManager,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  OpenAICompatibleProvider,
  type Plugin,
  type PluginHost,
  type RunnableAgent,
  type RuntimeHost,
} from '../packages/core/src/index';
import type { ReplContext } from '../packages/tui/src/index';
import { createAskUserTool } from '../packages/tui/src/renderer/ask-user';
import { createDelegateTaskPlugin } from '../plugins/tools/delegate-task/src/index';
import { createTeamPlugin } from '../plugins/tools/team/src/index';
import { PluginLoader } from './plugin-loader';
import { resolvePluginNames } from './plugin-selection';
import { isHostEnabled, tryCreateHostRuntime } from './runtime-factory';
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
  /** 外壳消费面：legacy 时是 AgentRuntime，host 时是 OwnerRuntimeFacade */
  runtime: RunnableAgent;
  ctx: ReplContext;
  config: Awaited<ReturnType<typeof loadConfig>>['config'];
  /** host.enabled=true 且构造成功时存在 */
  host?: RuntimeHost;
  /** nodeId 唯一来源：config.host.nodeId，缺省进程内生成 */
  nodeId: string;
  /** gateway /v1/team/agents 的 spawn 注入（仅 host 模式） */
  spawnAgent?: (request: {
    name?: string;
    model?: string;
    systemPrompt?: string;
  }) => Promise<AgentStatus>;
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

  // nodeId 唯一来源（U3）：host.node_id，缺省进程内生成；team/transport/PeerInfo 共用。
  const nodeId =
    config.host?.nodeId ?? `vessel-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

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
        timeout_ms: config.provider?.timeoutMs,
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
        // 交互模式（TUI / web gateway）把子 agent 的权限请求桥到父事件流；
        // headless 无应答者，直接 allow，避免 120s 挂起。
        permissionMode: config.delegate?.permissionMode ?? (headless ? 'allow' : 'bridge'),
        readOnlyTools: config.delegate?.readOnlyTools,
      }),
    );
  }

  // agent team 原型：0.1.0 必须显式 opt-in（`team.enabled: true`），默认不注册。
  // 传输层/跨进程成员留给 0.2（web）。未启用时 `team` 插件的默认导出是空插件。
  if (config.team?.enabled === true) {
    plugins.push(
      createTeamPlugin({
        providerFactory: () => provider,
        model: config.team.model ?? providerModel,
        events,
        maxMembers: config.team.maxMembers,
        ownerId: config.team.ownerId,
        memberLimits: config.team.memberLimits,
        memberTermination: config.team.memberTermination
          ? {
              maxIterations: config.team.memberTermination.maxIterations ?? 10,
              maxRuntimeSeconds: config.team.memberTermination.maxRuntimeSeconds,
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
  // 默认值只在 DEFAULT_CONFIG 一处定义，这里不再写第二份数字。
  const limits = config.limits ?? DEFAULT_CONFIG.limits ?? {};
  const termination = {
    maxIterations:
      config.termination?.maxIterations ?? DEFAULT_CONFIG.termination?.maxIterations ?? 20,
    maxRuntimeSeconds:
      config.termination?.maxRuntimeSeconds ?? DEFAULT_CONFIG.termination?.maxRuntimeSeconds,
  };
  const systemPrompt = config.agent?.systemPrompt ?? '你是一个有用的 AI 助手。';
  // 默认权限策略（ADR-029）：交互模式 'ask'，headless 'allow'。
  const permission = {
    default: headless ? ('allow' as const) : ('ask' as const),
    autoApprove: ['ask_user'],
  };

  let runtime: RunnableAgent | undefined;
  let host: RuntimeHost | undefined;
  let agentRuntime: AgentRuntime | undefined;
  let selectedPluginHost: PluginHost | undefined;
  let spawnAgent: BootstrapResult['spawnAgent'];

  // 0.2 host 路径：opt-in。只有 host.enabled=true 才动态加载 kernel/createRuntime。
  if (isHostEnabled(config)) {
    const hostPluginHost = new MemoryPluginHost();
    for (const plugin of plugins) await plugin.install(hostPluginHost);

    const hostResult = await tryCreateHostRuntime({
      config,
      owner: {
        id: config.team?.ownerId ?? 'owner',
        provider,
        model: providerModel,
        pluginHost: hostPluginHost,
        context,
        session,
        systemPrompt,
        limits,
        termination,
        permission,
      },
      sessionId: currentSessionId,
      contextFactory: () =>
        new MemoryContextManager({
          maxTokens: config.context?.maxTokens,
          maxMessages: config.context?.maxMessages,
          autoCompact: config.context?.autoCompact,
          compactThreshold: config.context?.compactThreshold,
        }),
    });

    if (hostResult.ok) {
      runtime = hostResult.runtime;
      host = hostResult.host;
      selectedPluginHost = hostPluginHost;
      const selectedHost = hostResult.host;
      spawnAgent = async (request) => {
        const handle = await selectedHost.spawn({
          provider,
          model: request.model ?? providerModel,
          pluginHost: hostPluginHost,
          ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
          ...(request.name !== undefined ? { name: request.name } : {}),
        });
        return handle.status();
      };
    } else {
      console.warn(
        `⚠ Host runtime unavailable (${hostResult.error}); falling back to the single-agent runtime.`,
      );
    }
  }

  // 0.1 单 agent 路径（默认；也是 host 构造失败的回退）。
  if (!runtime) {
    agentRuntime = await AgentRuntime.create({
      provider,
      model: providerModel,
      context,
      events,
      limits,
      termination,
      session,
      plugins,
      systemPrompt,
      permission,
    });
    runtime = agentRuntime;
    selectedPluginHost = agentRuntime.pluginHost;
  }

  const activeRuntime = runtime;
  // host 模式下事件总线由 Host 提供；legacy 模式沿用原来的 EventStream。
  const runtimeEvents = host?.events ?? events;

  // ── ReplContext ─────────────────────────────────
  // 工具/插件的唯一来源是同一个 PluginHost（插件在 install() 里注册）。
  const ctx: ReplContext = {
    runtime: activeRuntime,
    pluginHost: selectedPluginHost ?? activeRuntime.pluginHost,
    session,
    events: runtimeEvents,
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
      activeRuntime.dispose();
      process.exit(0);
    },
  };

  return {
    runtime: activeRuntime,
    ctx,
    config,
    host,
    nodeId,
    spawnAgent,
    cleanup: () => activeRuntime.dispose(),
  };
}
