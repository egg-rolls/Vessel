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
import { DeferredTransport } from './deferred-transport';
import { planFactoryPlugins } from './factory-plugins';
import { installMcp, type McpControl, type McpPluginLike } from './mcp-wiring';
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
  /**
   * team loopback 的晚绑定 transport（仅 host + team + loopback）。
   * cli 在 gateway 启动、真实 loopback 构造后调用 resolve/fail。
   */
  transport?: DeferredTransport;
  /** 0.3：MCP 控制面（未配置 mcp_servers 时为 undefined） */
  mcp?: McpControl;
  /**
   * 幂等关闭：MCP close → Host/runtime dispose → RunStore close。
   * 新代码应 await 本函数；`cleanup()` 仅供旧调用点兼容。
   */
  shutdown: () => Promise<void>;
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
  const staticPluginCount = plugins.length;

  /**
   * 工厂式插件（delegate_task / team）：
   * - host 开启：都装到共享 Host；
   * - host 关闭：delegate 用专用 Host、team 用内嵌 Host，并告警。
   */
  const buildFactoryPlugins = (
    runtimeHost?: RuntimeHost,
    transport?: DeferredTransport,
  ): Plugin[] => {
    const plan = planFactoryPlugins(config, runtimeHost !== undefined);
    for (const warning of plan.warnings) console.warn(`⚠ ${warning}`);

    const factory: Plugin[] = [];

    if (plan.delegate) {
      factory.push(
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
          ...(plan.delegate.useHost && runtimeHost ? { runtimeHost } : {}),
        }),
      );
    }

    if (plan.team) {
      factory.push(
        createTeamPlugin({
          providerFactory: () => provider,
          model: config.team?.model ?? providerModel,
          events: runtimeHost?.events ?? events,
          ...(plan.team.useHost && runtimeHost ? { host: runtimeHost } : {}),
          ...(transport
            ? {
                transport,
                nodeId,
                ownerRef: `${nodeId}:${config.team?.ownerId ?? 'owner'}`,
              }
            : {}),
          ownerId: config.team?.ownerId,
          memberLimits: config.team?.memberLimits,
          memberTermination: config.team?.memberTermination
            ? {
                maxIterations: config.team.memberTermination.maxIterations ?? 10,
                maxRuntimeSeconds: config.team.memberTermination.maxRuntimeSeconds,
              }
            : undefined,
        }),
      );
    }

    return factory;
  };

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
  let deferredTransport: DeferredTransport | undefined;

  // 0.2 host 路径：opt-in。只有 host.enabled=true 才动态加载 kernel/createRuntime。
  if (isHostEnabled(config)) {
    const hostPluginHost = new MemoryPluginHost();
    for (const plugin of plugins) await plugin.install(hostPluginHost);

    // team + loopback：transport 要等 gateway 启动后才能构造，用 DeferredTransport 占位。
    if (config.team?.enabled === true && config.transport?.kind === 'loopback') {
      deferredTransport = new DeferredTransport();
    }

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
      // Host 创建后、owner spawn 前，把 delegate/team 装到同一个 Host/PluginHost。
      beforeSpawn: async (createdHost) => {
        const factoryPlugins = buildFactoryPlugins(createdHost, deferredTransport);
        for (const plugin of factoryPlugins) await plugin.install(hostPluginHost);
        plugins.push(...factoryPlugins);
      },
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
      // beforeSpawn 可能已把工厂插件推进数组（但 Host 最终没建成）——回退前清掉
      plugins.length = staticPluginCount;
      deferredTransport = undefined;
      console.warn(
        `⚠ Host runtime unavailable (${hostResult.error}); falling back to the single-agent runtime.`,
      );
    }
  }

  // 0.1 单 agent 路径（默认；也是 host 构造失败的回退）。
  if (!runtime) {
    // host 关闭/回退：delegate 用专用 Host、team 用内嵌 Host；必要时告警。
    plugins.push(...buildFactoryPlugins());
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
  const finalPluginHost = selectedPluginHost ?? activeRuntime.pluginHost;

  // ── MCP（0.3）───────────────────────────────────
  // 在 runtime 就绪后安装：host 模式下 host.events 只有这时才存在；
  // PluginHost 是可变注册表，工具在每轮 loop 重新读取，后装对 owner/子 agent 立即生效。
  let mcpPlugin: McpPluginLike | undefined;
  let mcpControl: McpControl | undefined;
  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    try {
      const wiring = await installMcp({ config, events: runtimeEvents, loader }, finalPluginHost);
      if (wiring) {
        mcpPlugin = wiring.plugin;
        mcpControl = wiring.control;
      }
    } catch (e) {
      // 配置了 mcp_servers 但插件不可用属配置错误：启动即失败，不静默。
      console.error(`✗ ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
  }

  // ── 关闭 ────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (mcpPlugin) {
      try {
        await mcpPlugin.close();
      } catch (e) {
        console.warn(`⚠ Failed to close MCP client: ${e instanceof Error ? e.message : e}`);
      }
    }

    try {
      if (host) await host.close();
    } catch (e) {
      console.warn(`⚠ Failed to close runtime host: ${e instanceof Error ? e.message : e}`);
    }

    try {
      activeRuntime.dispose();
    } catch {
      // dispose 是同步契约；失败不阻断退出
    }
  };

  // ── ReplContext ─────────────────────────────────
  // 工具/插件的唯一来源是同一个 PluginHost（插件在 install() 里注册）。
  const ctx: ReplContext = {
    runtime: activeRuntime,
    pluginHost: finalPluginHost,
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
      void shutdown().finally(() => process.exit(0));
    },
  };

  return {
    runtime: activeRuntime,
    ctx,
    config,
    host,
    nodeId,
    spawnAgent,
    transport: deferredTransport,
    mcp: mcpControl,
    shutdown,
    cleanup: () => {
      void shutdown();
    },
  };
}
