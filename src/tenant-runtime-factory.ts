/**
 * 每 tenant 执行面（0.5 A-6 / DECISION-010 §13.2）。
 *
 * `buildTenantRuntime()` 构造一个 tenant 的独立 bundle：
 *   config / provider / session / runStore / context / pluginHost + plugins /
 *   trace / metrics / redactor / sessionControl / workflow / feishu / MCP。
 *
 * `createTenantRuntimeFactory()` 为 `--serve` 预构建全部 active tenant：
 * - 每个 tenant 独立 EventStream；事件桥接到 gateway 共享流并补 `tenant_id`；
 * - trace / metrics 只订阅本 tenant 流；
 * - 每个 tenant 持有自己的 writer lock；启动失败回滚已获取的锁。
 *
 * 本地单 tenant 模式复用 `buildTenantRuntime()`，只是只创建一个 bundle。
 *
 * @module vessel/tenant-runtime-factory
 */

import { join } from 'node:path';
import {
  type ConfigSources,
  DEFAULT_CONFIG,
  loadConfig,
  type VesselConfig,
} from '../packages/config/src/index';
import {
  AgentRuntime,
  type AgentStatus,
  createDefaultTraceRedactor,
  type EventStream,
  type LLMProvider,
  MemoryContextManager,
  MemoryPluginHost,
  type Message,
  type Plugin,
  type PluginHost,
  type RunnableAgent,
  type RunStore,
  type RuntimeHost,
  type RuntimePermissionConfig,
  resolveTenantPaths,
  type SessionBackend,
  type TenantPaths,
  type TraceRedactor,
} from '../packages/core/src/index';
import { createDelegateTaskPlugin } from '../plugins/tools/delegate-task/src/index';
import { createTeamPlugin } from '../plugins/tools/team/src/index';
import type {
  FeishuChannelLike,
  MetricsControlLike,
  WorkflowEngineLike,
} from './control-plane-types';
import { resolveDataDir } from './data-paths';
import { DeferredTransport } from './deferred-transport';
import { planFactoryPlugins } from './factory-plugins';
import {
  assertUniqueFeishuAppIds,
  createFeishuFromConfig,
  stopFeishuChannel,
} from './feishu-wiring';
import { installMcp, type McpControl, type McpPluginLike } from './mcp-wiring';
import type { MockScenarioName } from './mock/scenarios';
import {
  createEventBus,
  createEventStream,
  createMetricsCollector,
  disposeMetrics,
  type MetricsFactory,
} from './observability-wiring';
import {
  buildPluginConfigMap,
  buildTeamMemberHost,
  declarativePluginEntries,
  installWithConfig,
  withPluginConfig,
} from './plugin-config';
import { PluginLoader } from './plugin-loader';
import { resolvePluginSelection, warnExternalPluginsOnce } from './plugin-selection';
import { createProvider } from './provider-factory';
import { closeRunStore, createRunStore } from './run-store-factory';
import { isHostEnabled, tryCreateHostRuntime } from './runtime-factory';
import { createSessionControl, type SessionControl } from './session-control';
import { createSessionBackend } from './session-factory';
import { acquireTenantLock, type TenantLock } from './tenant-lock';
import {
  composeTraceRedactors,
  installTrace,
  pruneTenantTrace,
  type TraceControl,
  type TraceRecorderFactory,
} from './trace-wiring';
import { createWorkflowFromConfig } from './workflow-wiring';

/** 构造一个 tenant 执行面的输入 */
export interface BuildTenantRuntimeOptions {
  tenantId: string;
  /** 已合并 tenant overlay 的配置 */
  config: VesselConfig;
  tenantPaths: TenantPaths;
  /** config.loaded 事件的来源（缺省空） */
  configSources?: ConfigSources;
  /** 用户/项目配置路径（config.get.paths） */
  configPaths?: { user: string; project: string };
  /** tenant overlay 命中的叶子键（config snapshot） */
  tenantOverlayKeys?: string[];
  /** 已持有的锁；缺省且 acquireLock=true 时由本函数获取并负责释放 */
  lock?: TenantLock;
  acquireLock?: boolean;
  /**
   * 是否安装 trace（本地写意图）。false 时不创建 trace / 不写 events。
   * 默认 false：仅供 --serve 的只读执行面显式开启。
   */
  writeTrace?: boolean;
  /** 启动前按 trace 保留策略 prune；默认 false（本地 bootstrap 自己处理） */
  pruneTrace?: boolean;
  useMock?: boolean;
  /** mock 场景（仅 useMock）；缺省时 provider-factory 走 MemoryLLMProvider */
  mockScenario?: MockScenarioName;
  headless?: boolean;
  /** ask_user 仅交互 REPL 注册；serve / headless 必须 false */
  registerAskUser?: boolean;
  loader?: PluginLoader;
  nodeId: string;
  /** host owner 的初始 sessionId；缺省随机 UUID（serve 每 tenant 独立） */
  sessionId?: string;
  /** team 晚绑定 transport（loopback/remote；仅本地主 tenant） */
  transport?: DeferredTransport;
  /** team + loopback/remote 时由本函数创建 DeferredTransport */
  createLoopbackTransport?: boolean;
  metricsFactory?: MetricsFactory;
  traceFactory?: TraceRecorderFactory;
  /** 测试注入的 ext redactor */
  redactor?: TraceRedactor;
  clock?: () => number;
  loadMcpModule?: () => Promise<unknown | null>;
  loadWorkflowModule?: () => Promise<unknown | null>;
  loadFeishuModule?: () => Promise<unknown | null>;
  feishuTransport?: unknown;
  /** gateway 共享事件流；tenant 事件镜像到此处（补 tenant_id） */
  sharedEvents?: EventStream;
}

/** 一个 tenant 的完整执行面 */
export interface TenantRuntimeBundle {
  tenantId: string;
  config: VesselConfig;
  tenantPaths: TenantPaths;
  configSources: ConfigSources;
  configPaths?: { user: string; project: string };
  tenantOverlayKeys: string[];
  provider: LLMProvider;
  providerName: string;
  providerModel: string;
  providerBaseUrl: string;
  /** tenant 独立事件流（trace / metrics 只订阅它） */
  events: EventStream;
  /** runtime 事件出口；host 模式下同 tenant 流（host bus 已桥接） */
  runtimeEvents: EventStream;
  session: SessionBackend;
  context: MemoryContextManager;
  pluginHost: PluginHost;
  runtime: RunnableAgent;
  host?: RuntimeHost;
  agentRuntime?: AgentRuntime;
  runStore?: RunStore;
  trace?: TraceControl;
  metrics?: MetricsControlLike;
  redactor: TraceRedactor;
  sessionControl: SessionControl;
  plugins: Plugin[];
  mcpPlugin?: McpPluginLike;
  mcp?: McpControl;
  workflows?: WorkflowEngineLike;
  feishu?: FeishuChannelLike;
  transport?: DeferredTransport;
  spawnAgent?: (request: {
    name?: string;
    model?: string;
    systemPrompt?: string;
  }) => Promise<AgentStatus>;
  lock?: TenantLock;
  close(): Promise<void>;
}

/** 内部：锁所有权 */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function tenantSessionsDbPath(tenantRoot: string): string {
  return join(tenantRoot, 'sessions.db');
}

/** core 0.6.1 E3 的 summarizer 形状（本 worktree 的 core 尚未导出该类型） */
type ContextSummarizer = (messages: Message[], options: { maxTokens: number }) => Promise<string>;

/**
 * 用当前 provider 生成真实上下文摘要（0.6.1 E3）。
 * 失败由 core 捕获并回退占位符；这里不吞错，便于测试/观测。
 */
export function createContextSummarizer(provider: LLMProvider, model: string): ContextSummarizer {
  return async (messages, options) => {
    const transcript = messages
      .map((message) => `[${message.role}] ${message.content}`)
      .join('\n\n');
    const response = await provider.chat({
      model,
      messages: [
        {
          role: 'system',
          content:
            'Summarize the conversation for context compaction. Preserve decisions, file paths, tool results, and open tasks. Output only the summary.',
        },
        { role: 'user', content: transcript },
      ],
      max_tokens: Math.max(128, Math.min(options.maxTokens, 2048)),
      temperature: 0,
    });
    return typeof response.content === 'string' ? response.content : '';
  };
}

/** 每 tenant 的上下文配置（含真实 summarizer）；供 owner 与成员共用。 */
function contextConfigFor(config: VesselConfig, summarizer: ContextSummarizer) {
  return {
    maxTokens: config.context?.maxTokens,
    maxMessages: config.context?.maxMessages,
    autoCompact: config.context?.autoCompact,
    compactThreshold: config.context?.compactThreshold,
    summarizer,
  };
}

/** 0.8.2 Wave 2B1：runtime / delegate / workflow 共用的 resolved 权限配置。 */
export function resolveRuntimePermission(
  config: VesselConfig,
  headless: boolean,
): RuntimePermissionConfig {
  return {
    default: headless ? 'allow' : 'ask',
    // E7：配置持久化的 always 规则 + 运行时始终免确认的 ask_user。
    autoApprove: [...new Set([...(config.permission?.autoApprove ?? []), 'ask_user'])],
  };
}

/** delegate 工厂插件 options；ext 0.8.2 起识别 `permission`。 */
export type DelegateTaskOptionsWithPermission = Parameters<typeof createDelegateTaskPlugin>[0] & {
  permission: RuntimePermissionConfig;
};

export interface BuildDelegateTaskOptionsInput {
  config: VesselConfig;
  providerFactory: () => LLMProvider;
  tenantId: string;
  providerModel: string;
  headless: boolean;
  permission: RuntimePermissionConfig;
  runtimeHost?: RuntimeHost;
}

/**
 * 构造 delegate 工厂插件 options（纯函数，便于测试）。
 * `permissionMode` 保持原逻辑：显式配置优先，否则交互 bridge / headless allow。
 */
export function buildDelegateTaskOptions(
  input: BuildDelegateTaskOptionsInput,
): DelegateTaskOptionsWithPermission {
  return {
    providerFactory: input.providerFactory,
    tenantId: input.tenantId,
    model: input.config.delegate?.model ?? input.providerModel,
    maxDepth: input.config.delegate?.maxDepth,
    disallowed: input.config.delegate?.disallowed,
    limits: input.config.delegate?.limits,
    termination: input.config.delegate?.termination
      ? {
          maxIterations: input.config.delegate.termination.maxIterations ?? 10,
          maxRuntimeSeconds: input.config.delegate.termination.maxRuntimeSeconds,
        }
      : undefined,
    permissionMode: input.config.delegate?.permissionMode ?? (input.headless ? 'allow' : 'bridge'),
    readOnlyTools: input.config.delegate?.readOnlyTools,
    permission: input.permission,
    ...(input.runtimeHost !== undefined ? { runtimeHost: input.runtimeHost } : {}),
  };
}

/**
 * 构造一个 tenant 的独立执行面。
 * 失败时释放本函数获取的锁；调用方负责释放传入的锁。
 */
export async function buildTenantRuntime(
  options: BuildTenantRuntimeOptions,
): Promise<TenantRuntimeBundle> {
  const { tenantId, config, tenantPaths } = options;
  const useMock = options.useMock ?? false;
  const headless = options.headless ?? false;
  const loader = options.loader ?? new PluginLoader();

  let ownedLock: TenantLock | undefined;
  if (options.lock === undefined && options.acquireLock === true) {
    ownedLock = await acquireTenantLock({
      tenantDir: tenantPaths.root,
      tenantId,
      ...(options.clock ? { now: options.clock } : {}),
    });
  }
  const lock = options.lock ?? ownedLock;

  try {
    if (options.pruneTrace === true) {
      try {
        await pruneTenantTrace({ config, tenantPaths });
      } catch (error) {
        console.warn(
          `⚠ Failed to prune trace for tenant "${tenantId}": ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }

    const runStore = createRunStore(config, {
      tenantRunsDir: tenantPaths.runs_dir,
      tenantId,
    });
    const resolvedProvider = await createProvider(config, loader, useMock, options.mockScenario);
    const { provider, providerName, providerModel, providerBaseUrl } = resolvedProvider;

    const summarizer = createContextSummarizer(provider, providerModel);
    const context = new MemoryContextManager(contextConfigFor(config, summarizer));
    const events = createEventStream(config);

    // 本 tenant 事件 → gateway 共享流（事件带 tenant_id；SSE/WS 过滤靠它）。
    const unsubShared = options.sharedEvents
      ? events.subscribe((event) => {
          const withTenant =
            event.tenant_id === undefined ? { ...event, tenant_id: tenantId } : event;
          try {
            options.sharedEvents?.publish(withTenant);
          } catch {
            // 共享流订阅者异常不影响 tenant 执行
          }
        })
      : undefined;

    const session = createSessionBackend(config.session, {
      tenantSessionsDir: tenantPaths.sessions_dir,
      tenantSessionsDbPath: tenantSessionsDbPath(tenantPaths.root),
      tenantId,
    });
    const sessionControl = createSessionControl({
      session,
      paths: tenantPaths,
      events,
      tenantId,
      ...(runStore ? { runStore } : {}),
    });

    // ── 插件 ──────────────────────────────────────
    const declarativePlugins = declarativePluginEntries(config);
    /** E1：插件名 → 安装配置（显式 plugins[].config 覆盖声明式条目） */
    const pluginConfigs = buildPluginConfigMap(config.plugins, declarativePlugins);
    const pluginSelection = resolvePluginSelection(
      loader,
      config.plugins,
      Boolean(process.env.VESSEL_DEBUG),
      declarativePlugins,
    );
    // 默认集里的外部插件以完整进程权限运行：启动时告警一次（stderr）。
    warnExternalPluginsOnce(pluginSelection.external);
    const defaultPluginNames = pluginSelection.names;

    const plugins: Plugin[] = [];
    const pluginLoadEvents: Array<{
      type: 'plugin.loaded' | 'plugin.failed';
      data: Record<string, unknown>;
    }> = [];
    for (const name of defaultPluginNames) {
      const descriptor = loader.list().find((candidate) => candidate.name === name);
      const category = descriptor?.category ?? 'unknown';
      const plugin = await loader.load(name);
      if (plugin) {
        // E1：配置在 install 时透传（host 路径直接传；非 host 路径见 AgentRuntime）。
        plugins.push(plugin);
        pluginLoadEvents.push({
          type: 'plugin.loaded',
          data: {
            name: plugin.name,
            category,
            version: plugin.version ?? descriptor?.version ?? '',
            tenant_id: tenantId,
          },
        });
      } else {
        pluginLoadEvents.push({
          type: 'plugin.failed',
          data: { name, category, reason: 'load_failed', tenant_id: tenantId },
        });
      }
    }

    if (options.registerAskUser === true) {
      const { createAskUserTool } = await import('../packages/tui/src/renderer/ask-user');
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

    let internalTeamHost: RuntimeHost | undefined;
    let deferredTransport = options.transport;
    if (
      deferredTransport === undefined &&
      options.createLoopbackTransport === true &&
      isHostEnabled(config) &&
      config.team?.enabled === true &&
      (config.transport?.kind === 'loopback' || config.transport?.kind === 'remote')
    ) {
      deferredTransport = new DeferredTransport();
    }

    // runtime / delegate / workflow 共用的 resolved 权限配置（0.8.2 Wave 2B1）。
    const permission = resolveRuntimePermission(config, headless);

    const buildFactoryPlugins = async (
      runtimeHost?: RuntimeHost,
      transport?: DeferredTransport,
    ): Promise<Plugin[]> => {
      const plan = planFactoryPlugins(config, runtimeHost !== undefined);
      for (const warning of plan.warnings) console.warn(`⚠ ${warning}`);

      const factory: Plugin[] = [];
      if (plan.delegate) {
        // 0.8.2 Wave 2B1：子 runtime 继承父 resolved 权限（default + autoApprove）。
        factory.push(
          createDelegateTaskPlugin(
            buildDelegateTaskOptions({
              config,
              providerFactory: () => provider,
              tenantId,
              providerModel,
              headless,
              permission,
              ...(plan.delegate.useHost && runtimeHost ? { runtimeHost } : {}),
            }),
          ),
        );
      }

      if (plan.team) {
        let teamHost = plan.team.useHost ? runtimeHost : undefined;
        if (!teamHost) {
          const { createRuntime } = await import('../packages/core/src/kernel/create-runtime.js');
          internalTeamHost ??= await createRuntime({ session });
          teamHost = internalTeamHost;
        }

        factory.push(
          createTeamPlugin({
            providerFactory: () => provider,
            tenantId,
            model: config.team?.model ?? providerModel,
            events: runtimeHost?.events ?? events,
            host: teamHost,
            ...(transport
              ? {
                  transport,
                  nodeId: options.nodeId,
                  ownerRef: `${options.nodeId}:${config.team?.ownerId ?? 'owner'}`,
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

    // ── Runtime ───────────────────────────────────
    const limits = config.limits ?? DEFAULT_CONFIG.limits ?? {};
    const termination = {
      maxIterations:
        config.termination?.maxIterations ?? DEFAULT_CONFIG.termination?.maxIterations ?? 20,
      maxRuntimeSeconds:
        config.termination?.maxRuntimeSeconds ?? DEFAULT_CONFIG.termination?.maxRuntimeSeconds,
    };
    const systemPrompt = config.agent?.systemPrompt ?? '你是一个有用的 AI 助手。';

    let runtime: RunnableAgent | undefined;
    let host: RuntimeHost | undefined;
    let agentRuntime: AgentRuntime | undefined;
    let selectedPluginHost: PluginHost | undefined;
    let spawnAgent: TenantRuntimeBundle['spawnAgent'];
    let unsubHostBridge: (() => void) | undefined;

    const contextFactory = () => new MemoryContextManager(contextConfigFor(config, summarizer));

    if (isHostEnabled(config)) {
      const hostPluginHost = new MemoryPluginHost();
      for (const plugin of plugins) {
        await installWithConfig(plugin, hostPluginHost, pluginConfigs[plugin.name]);
      }

      const hostEvents = createEventBus(config);
      // host runtime 事件先进入 host bus，再桥接到本 tenant 流。
      unsubHostBridge = hostEvents.subscribe((event) => {
        try {
          events.publish(event);
        } catch {
          // tenant 流订阅者异常不影响 host
        }
      });

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
        sessionId: options.sessionId ?? crypto.randomUUID(),
        ...(runStore ? { runStore } : {}),
        ...(hostEvents ? { events: hostEvents } : {}),
        contextFactory,
        beforeSpawn: async (createdHost) => {
          const factoryPlugins = await buildFactoryPlugins(createdHost, deferredTransport);
          for (const plugin of factoryPlugins) await plugin.install(hostPluginHost);
          plugins.push(...factoryPlugins);
        },
      });

      if (hostResult.ok) {
        runtime = hostResult.runtime;
        host = hostResult.host;
        selectedPluginHost = hostPluginHost;
        const selectedHost = hostResult.host;
        // E10：跨节点 spawn 与本机 spawn 使用同一成员隔离与限额。
        const memberLimits = config.team?.memberLimits;
        const memberTermination = config.team?.memberTermination
          ? {
              maxIterations: config.team.memberTermination.maxIterations ?? 10,
              maxRuntimeSeconds: config.team.memberTermination.maxRuntimeSeconds,
            }
          : undefined;
        spawnAgent = async (request) => {
          const handle = await selectedHost.spawn({
            provider,
            model: request.model ?? providerModel,
            // 成员不能反向调用 team_*（复用 ext 的 buildChildHost）。
            pluginHost: buildTeamMemberHost(hostPluginHost),
            ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
            ...(request.name !== undefined ? { name: request.name } : {}),
            ...(memberLimits ? { limits: { run: memberLimits } } : {}),
            ...(memberTermination ? { termination: memberTermination } : {}),
          });
          return handle.status();
        };
      } else {
        plugins.length = staticPluginCount;
        deferredTransport = options.transport;
        console.warn(
          `⚠ Host runtime unavailable (${hostResult.error}); falling back to the single-agent runtime.`,
        );
      }
    }

    if (!runtime) {
      plugins.push(...(await buildFactoryPlugins(undefined, deferredTransport)));
      agentRuntime = await AgentRuntime.create({
        provider,
        model: providerModel,
        context,
        events,
        limits,
        termination,
        session,
        // core 0.6.1：pluginConfigs 按名透传；本 worktree 的 core 尚未有该字段，
        // 同时用 wrapper 绑定配置，保证 core 合并前后行为一致。
        plugins: plugins.map((plugin) => withPluginConfig(plugin, pluginConfigs[plugin.name])),
        systemPrompt,
        permission,
        ...(Object.keys(pluginConfigs).length > 0 ? { pluginConfigs } : {}),
        ...(runStore ? { runStore } : {}),
      } as Parameters<typeof AgentRuntime.create>[0] & {
        pluginConfigs?: Record<string, Record<string, unknown>>;
      });
      runtime = agentRuntime;
      selectedPluginHost = agentRuntime.pluginHost;
    }

    const activeRuntime = runtime;
    const finalPluginHost = selectedPluginHost ?? activeRuntime.pluginHost;

    // ── Trace ─────────────────────────────────────
    const extRedactor = options.redactor ?? (await loadRedactSecrets(loader));
    const redactor = composeTraceRedactors(createDefaultTraceRedactor(), extRedactor);
    const trace =
      options.writeTrace === true
        ? installTrace({
            events,
            config,
            tenantPaths,
            tenantId,
            ...(extRedactor ? { redactor: extRedactor } : {}),
            ...(options.traceFactory ? { factory: options.traceFactory } : {}),
          })
        : undefined;

    // asm 事件：不含值、不含密钥。
    try {
      const nowTs = options.clock ?? Date.now;
      events.publish({
        type: 'config.loaded',
        run_id: 'config',
        data: {
          sources: [...new Set(Object.values(options.configSources ?? {}))],
          keys: Object.keys(config),
          tenant_id: tenantId,
        },
        ts: nowTs(),
      });
      for (const event of pluginLoadEvents) {
        events.publish({ type: event.type, run_id: 'plugins', data: event.data, ts: nowTs() });
      }
    } catch {
      // 事件投递失败不阻断启动
    }

    // ── MCP ───────────────────────────────────────
    let mcpPlugin: McpPluginLike | undefined;
    let mcpControl: McpControl | undefined;
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      const wiring = await installMcp(
        {
          config,
          events,
          tenantId,
          loader,
          ...(options.loadMcpModule ? { loadModule: options.loadMcpModule } : {}),
        },
        finalPluginHost,
      );
      if (wiring) {
        mcpPlugin = wiring.plugin;
        mcpControl = wiring.control;
      }
    }

    // ── Workflow / Feishu / Metrics ───────────────
    const workflowEngine = await createWorkflowFromConfig({
      config,
      events,
      pluginHost: finalPluginHost,
      tenantDir: tenantPaths.root,
      tenantId,
      permission,
      ...(host ? { host } : { runtime: activeRuntime }),
      loader,
      ...(options.loadWorkflowModule ? { loadModule: options.loadWorkflowModule } : {}),
    });

    const feishuChannel = await createFeishuFromConfig({
      config,
      provider,
      model: providerModel,
      pluginHost: finalPluginHost,
      session,
      events,
      tenantId,
      env: {},
      ...(runStore ? { runStore } : {}),
      contextFactory,
      ...(options.feishuTransport !== undefined ? { transport: options.feishuTransport } : {}),
      loader,
      ...(options.loadFeishuModule ? { loadModule: options.loadFeishuModule } : {}),
    });

    const metrics = createMetricsCollector(events, config, options.metricsFactory);

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;

      await stopFeishuChannel(feishuChannel);

      if (workflowEngine) {
        try {
          await workflowEngine.close();
        } catch (error) {
          console.warn(
            `⚠ Failed to close workflow engine: ${error instanceof Error ? error.message : error}`,
          );
        }
      }

      disposeMetrics(metrics);

      if (mcpPlugin) {
        try {
          await mcpPlugin.close();
        } catch (error) {
          console.warn(
            `⚠ Failed to close MCP client: ${error instanceof Error ? error.message : error}`,
          );
        }
      }

      try {
        if (host) await host.close();
      } catch (error) {
        console.warn(
          `⚠ Failed to close runtime host: ${error instanceof Error ? error.message : error}`,
        );
      }

      // 0.9：AgentRuntime.dispose() 返回 Promise（逆序调插件 dispose）；
      // 必须等待，否则进程退出会截断插件清理。dispose 自身幂等且不外抛。
      try {
        await activeRuntime.dispose();
      } catch (error) {
        console.warn(
          `⚠ Failed to dispose runtime: ${error instanceof Error ? error.message : error}`,
        );
      }

      try {
        if (internalTeamHost && internalTeamHost !== host) await internalTeamHost.close();
      } catch {
        // best-effort
      }

      if (trace) {
        try {
          await trace.flush();
        } catch (error) {
          console.warn(
            `⚠ Failed to flush trace: ${error instanceof Error ? error.message : error}`,
          );
        }
        try {
          await trace.close();
        } catch (error) {
          console.warn(
            `⚠ Failed to close trace: ${error instanceof Error ? error.message : error}`,
          );
        }
      }

      await closeRunStore(runStore);

      try {
        session.close?.();
      } catch {
        // best-effort
      }

      unsubHostBridge?.();
      unsubShared?.();

      if (ownedLock) {
        try {
          await ownedLock.release();
        } catch (error) {
          console.warn(
            `⚠ Failed to release tenant lock: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    };

    return {
      tenantId,
      config,
      tenantPaths,
      configSources: options.configSources ?? {},
      ...(options.configPaths ? { configPaths: options.configPaths } : {}),
      tenantOverlayKeys: options.tenantOverlayKeys ?? [],
      provider,
      providerName,
      providerModel,
      providerBaseUrl,
      events,
      runtimeEvents: events,
      session,
      context,
      pluginHost: finalPluginHost,
      runtime: activeRuntime,
      ...(host ? { host } : {}),
      ...(agentRuntime ? { agentRuntime } : {}),
      ...(runStore ? { runStore } : {}),
      ...(trace ? { trace } : {}),
      ...(metrics ? { metrics } : {}),
      redactor,
      sessionControl,
      plugins,
      ...(mcpPlugin ? { mcpPlugin } : {}),
      ...(mcpControl ? { mcp: mcpControl } : {}),
      ...(workflowEngine ? { workflows: workflowEngine } : {}),
      ...(feishuChannel ? { feishu: feishuChannel } : {}),
      ...(deferredTransport ? { transport: deferredTransport } : {}),
      ...(spawnAgent ? { spawnAgent } : {}),
      ...(lock ? { lock } : {}),
      close,
    };
  } catch (error) {
    if (ownedLock) {
      try {
        await ownedLock.release();
      } catch {
        // best-effort
      }
    }
    throw error;
  }
}

/** ext redact-secrets 的结构镜像 */
interface RedactSecretsModuleLike {
  createTraceRedactor(config?: unknown): TraceRedactor;
}

/** 动态加载 ext redactor；缺失只 warn，不阻断启动 */
async function loadRedactSecrets(loader: PluginLoader): Promise<TraceRedactor | undefined> {
  try {
    const mod = (await loader.loadModule('redact-secrets')) as RedactSecretsModuleLike | null;
    if (!mod || typeof mod.createTraceRedactor !== 'function') {
      console.warn('⚠ redact-secrets unavailable; trace uses the core default redactor.');
      return undefined;
    }
    return mod.createTraceRedactor();
  } catch (error) {
    console.warn(
      `⚠ Failed to load redact-secrets: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

// ── 多租户工厂（--serve） ─────────────────────────

/** 工厂注入 */
export interface TenantRuntimeFactoryOptions {
  /** 基础配置（用于 data_dir / tenant 列表） */
  config: VesselConfig;
  configPath?: string;
  userConfigPath?: string;
  dataDir?: string;
  useMock?: boolean;
  /** mock 场景（仅 useMock）；逐 tenant 透传 */
  mockScenario?: MockScenarioName;
  headless?: boolean;
  loader?: PluginLoader;
  nodeId: string;
  /** gateway 共享事件流（所有 tenant 事件镜像到这里） */
  sharedEvents?: EventStream;
  metricsFactory?: MetricsFactory;
  traceFactory?: TraceRecorderFactory;
  redactor?: TraceRedactor;
  clock?: () => number;
  /** 默认 true：serve 为每个 active tenant 持锁 */
  acquireLocks?: boolean;
  /** 默认 true：serve 安装每 tenant trace */
  writeTrace?: boolean;
  /**
   * 已由 bootstrap 构建的 tenant（serve 的默认 tenant）。
   * 工厂不重复构建、不关闭；调用方负责其生命周期。
   */
  seededTenants?: TenantRuntimeBundle[];
  loadMcpModule?: () => Promise<unknown | null>;
  loadWorkflowModule?: () => Promise<unknown | null>;
  loadFeishuModule?: () => Promise<unknown | null>;
}

/** 工厂（启动完成后访问器是同步的，匹配 gateway 的注入面） */
export interface TenantRuntimeFactory {
  /** 已成功构建的 tenant id */
  tenantIds(): string[];
  runtimeFor(tenantId: string): RunnableAgent | undefined;
  sessionFor(tenantId: string): SessionBackend | undefined;
  contextFor(tenantId: string): MemoryContextManager | undefined;
  pluginHostFor(tenantId: string): PluginHost | undefined;
  metricsFor(tenantId: string): MetricsControlLike | undefined;
  pluginsFor(tenantId: string): Array<{ name: string; enabled: boolean }> | undefined;
  bundleFor(tenantId: string): TenantRuntimeBundle | undefined;
  closeAll(): Promise<void>;
}

/** `status` 缺省视为 active；包含显式 default tenant（隐式配置）。 */
export function listActiveTenantIds(config: VesselConfig): string[] {
  const configured = config.tenant?.tenants ?? {};
  const ids = Object.entries(configured)
    .filter(([, settings]) => settings.status !== 'disabled')
    .map(([id]) => id);
  const fallback = nonEmpty(config.tenant?.default) ?? 'default';
  const fallbackSettings = configured[fallback];
  if (fallbackSettings?.status !== 'disabled' && !ids.includes(fallback)) ids.push(fallback);
  return ids;
}

/** 载入一个 tenant 的合并配置；禁用 tenant 返回 null。 */
export async function loadTenantRuntimeConfig(
  tenantId: string,
  options: Pick<TenantRuntimeFactoryOptions, 'configPath' | 'userConfigPath' | 'dataDir'>,
): Promise<{
  config: VesselConfig;
  sources: ConfigSources;
  tenantPaths: TenantPaths;
  paths: { user: string; project: string };
  tenantOverlayKeys: string[];
} | null> {
  const loaded = await loadConfig({
    tenantId,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.userConfigPath !== undefined ? { userConfigPath: options.userConfigPath } : {}),
  });
  if (loaded.validation.errors.length > 0) {
    throw new Error(
      `tenant "${tenantId}" config invalid: ${loaded.validation.errors
        .map((error) => error.message)
        .join('; ')}`,
    );
  }
  if (loaded.config.tenant?.tenants?.[tenantId]?.status === 'disabled') return null;
  const tenantPaths = resolveTenantPaths(
    options.dataDir ?? resolveDataDir(loaded.config),
    tenantId,
  );
  return {
    config: loaded.config,
    sources: loaded.sources,
    tenantPaths,
    paths: loaded.paths,
    tenantOverlayKeys: loaded.tenantOverlayKeys,
  };
}

/**
 * 预构建全部 active tenant；任一 tenant 失败 → 释放已建 bundle 的锁并抛出。
 * 同一 app_id 跨 tenant → 装配期拒绝启动（A-6 §13.4）。
 */
export async function createTenantRuntimeFactory(
  options: TenantRuntimeFactoryOptions,
): Promise<TenantRuntimeFactory> {
  const bundles = new Map<string, TenantRuntimeBundle>();
  const owned = new Set<string>();
  for (const seeded of options.seededTenants ?? []) {
    bundles.set(seeded.tenantId, seeded);
  }
  const loader = options.loader ?? new PluginLoader();
  const acquireLocks = options.acquireLocks ?? true;
  const writeTrace = options.writeTrace ?? true;

  try {
    const activeIds = listActiveTenantIds(options.config);
    const loadedTenants = new Map<
      string,
      {
        config: VesselConfig;
        sources: ConfigSources;
        tenantPaths: TenantPaths;
        paths: { user: string; project: string };
        tenantOverlayKeys: string[];
      }
    >();

    for (const tenantId of activeIds) {
      const seeded = bundles.get(tenantId);
      if (seeded) {
        // 不重新加载：bootstrap 可能已合并首启向导写入的内存配置。
        loadedTenants.set(tenantId, {
          config: seeded.config,
          sources: seeded.configSources,
          tenantPaths: seeded.tenantPaths,
          paths: seeded.configPaths ?? { user: '', project: 'vessel.yaml' },
          tenantOverlayKeys: seeded.tenantOverlayKeys,
        });
        continue;
      }
      const loaded = await loadTenantRuntimeConfig(tenantId, options);
      if (!loaded) continue;
      loadedTenants.set(tenantId, loaded);
    }

    assertUniqueFeishuAppIds(
      [...loadedTenants.entries()].map(([tenantId, loaded]) => ({
        tenantId,
        config: loaded.config,
      })),
    );

    for (const [tenantId, loaded] of loadedTenants) {
      // serve 的默认 tenant 已由 bootstrap 构建。
      if (bundles.has(tenantId)) continue;
      const bundle = await buildTenantRuntime({
        tenantId,
        config: loaded.config,
        tenantPaths: loaded.tenantPaths,
        configSources: loaded.sources,
        configPaths: loaded.paths,
        tenantOverlayKeys: loaded.tenantOverlayKeys,
        acquireLock: acquireLocks,
        writeTrace,
        pruneTrace: writeTrace,
        ...(options.useMock !== undefined ? { useMock: options.useMock } : {}),
        ...(options.mockScenario !== undefined ? { mockScenario: options.mockScenario } : {}),
        ...(options.headless !== undefined ? { headless: options.headless } : {}),
        loader,
        nodeId: options.nodeId,
        ...(options.sharedEvents ? { sharedEvents: options.sharedEvents } : {}),
        ...(options.metricsFactory ? { metricsFactory: options.metricsFactory } : {}),
        ...(options.traceFactory ? { traceFactory: options.traceFactory } : {}),
        ...(options.redactor ? { redactor: options.redactor } : {}),
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.loadMcpModule ? { loadMcpModule: options.loadMcpModule } : {}),
        ...(options.loadWorkflowModule ? { loadWorkflowModule: options.loadWorkflowModule } : {}),
        ...(options.loadFeishuModule ? { loadFeishuModule: options.loadFeishuModule } : {}),
      });
      bundles.set(tenantId, bundle);
      owned.add(tenantId);
    }

    let closed = false;
    return {
      tenantIds: () => [...bundles.keys()],
      runtimeFor: (tenantId) => bundles.get(tenantId)?.runtime,
      sessionFor: (tenantId) => bundles.get(tenantId)?.session,
      contextFor: (tenantId) => bundles.get(tenantId)?.context,
      pluginHostFor: (tenantId) => bundles.get(tenantId)?.pluginHost,
      metricsFor: (tenantId) => bundles.get(tenantId)?.metrics,
      pluginsFor: (tenantId) => {
        const bundle = bundles.get(tenantId);
        if (!bundle) return undefined;
        const loaded = new Set(bundle.plugins.map((plugin) => plugin.name));
        const listed = bundle.plugins.map((plugin) => ({ name: plugin.name, enabled: true }));
        // 配置里显式 disabled 的插件不加载，但仍要出现在 plugins.list 中。
        for (const configured of bundle.config.plugins ?? []) {
          if (configured.enabled === false && !loaded.has(configured.name)) {
            listed.push({ name: configured.name, enabled: false });
          }
        }
        return listed;
      },
      bundleFor: (tenantId) => bundles.get(tenantId),
      closeAll: async () => {
        if (closed) return;
        closed = true;
        // 逆序关闭本工厂构建的 tenant；seed 由调用方关闭。
        const entries = [...bundles.entries()].filter(([id]) => owned.has(id)).reverse();
        for (const [, bundle] of entries) {
          try {
            await bundle.close();
          } catch (error) {
            console.warn(
              `⚠ Failed to close tenant "${bundle.tenantId}": ${
                error instanceof Error ? error.message : error
              }`,
            );
          }
        }
        bundles.clear();
        owned.clear();
      },
    };
  } catch (error) {
    for (const [id, bundle] of [...bundles.entries()].reverse()) {
      if (!owned.has(id)) continue;
      try {
        await bundle.close();
      } catch {
        // best-effort rollback
      }
    }
    throw error;
  }
}
