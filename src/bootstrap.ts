/**
 * 应用引导模块
 *
 * 负责：config → provider → plugins → runtime → ReplContext
 * 从 cli.ts 中提取，解决 #16 issue
 */

import {
  buildConfigSnapshot,
  DEFAULT_CONFIG,
  loadConfig,
  type VesselConfig,
} from '../packages/config/src/index';
import {
  AgentRuntime,
  type AgentStatus,
  MemoryContextManager,
  MemoryPluginHost,
  MemorySessionBackend,
  pruneTrace,
  type ReadTraceOptions,
  type RunEvent,
  type RunnableAgent,
  type RunOptions,
  type RunStore,
  type RuntimeHost,
  readTraceEvents,
  rebuildMetrics,
  resolveTenantPaths,
  type TenantPaths,
  type TraceRedactor,
} from '../packages/core/src/index';
import {
  type ConfigSnapshotLike,
  createLocalRpcDispatcher,
  type LocalRpcDispatcher,
} from '../packages/serve/src/index';
import type { ReplContext } from '../packages/tui/src/index';
import type {
  FeishuChannelLike,
  MetricsControlLike,
  WorkflowEngineLike,
} from './control-plane-types';
import { resolveDataDir } from './data-paths';
import type { DeferredTransport } from './deferred-transport';
import {
  type DurableRunHandleLike,
  type DurableRunsControlLike,
  listRunSummaries,
  loadResumableCheckpoint,
  resumeError,
  routeResume,
} from './durable-wiring';
import type { McpControl } from './mcp-wiring';
import { createEventStream, type MetricsFactory } from './observability-wiring';
import { resolveWorkflowDefPathSync } from './path-resolution';
import { PluginLoader } from './plugin-loader';
import { createHttpRpcClient, createLocalRpcClient, type RpcClient } from './rpc/index';
import { resolveGatewayAuth } from './serve-auth';
import type { SessionControl } from './session-control';
import { createTenantControl } from './tenant-command';
import { acquireTenantLock, type TenantLock, TenantLockError, withTenantLock } from './tenant-lock';
import { buildTenantRuntime, type TenantRuntimeBundle } from './tenant-runtime-factory';
import { pruneTenantTrace, type TraceControl, type TraceRecorderFactory } from './trace-wiring';
import { readPackageVersion } from './version';
import { adaptWorkflowsControl } from './workflow-wiring';

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
  /** 项目配置文件路径（默认 ./vessel.yaml）；嵌入/测试用 */
  configPath?: string;
  /** 用户配置文件路径（默认 ~/.vessel/config.yaml）；嵌入/测试用 */
  userConfigPath?: string;
  /** 0.5：显式 tenant id（CLI --tenant / RuntimeOptions）；缺省按 VESSEL_TENANT → config 解析 */
  tenantId?: string;
  /** 0.5：tenant id 来源（CLI / env）；由调用方标注，缺省按解析结果 */
  tenantSource?: 'cli' | 'env';
  /**
   * 0.5：是否获取 tenant 写锁。默认 false（由调用方按写意图传入）；
   * CLI 的 run/REPL/serve/feishu 入口传 true。
   */
  acquireLock?: boolean;
  /** 0.5：`--connect <url>` / VESSEL_CONNECT；设置时不加锁、不写本地 store */
  connect?: string;
  /** 0.5：测试注入 data_dir（缺省 config.dataDir → VESSEL_DATA_DIR → 默认值） */
  dataDir?: string;
  /** 0.5：trace recorder 工厂（测试） */
  traceFactory?: TraceRecorderFactory;
  /** 0.5：额外 trace redactor（ext redact-secrets） */
  redactor?: TraceRedactor;
  /** 0.5：锁 / 服务测试时钟 */
  clock?: () => number;
  /** 测试注入：connect 模式的 RPC client（缺省 createHttpRpcClient） */
  rpcClientFactory?: (opts: {
    baseUrl: string;
    token: string;
  }) => RpcClient & { close(): Promise<void> };
  /** 测试注入口：MCP 模块加载器；缺省用 PluginLoader 动态 import */
  loadMcpModule?: () => Promise<unknown | null>;
  /** 0.4 测试注入口：workflow / feishu 模块加载器 */
  loadWorkflowModule?: () => Promise<unknown | null>;
  loadFeishuModule?: () => Promise<unknown | null>;
  /** 0.4 测试/示例注入口：飞书 mock transport */
  feishuTransport?: unknown;
  /** 0.4 测试注入口：metrics 工厂（默认 core MetricsCollector） */
  metricsFactory?: MetricsFactory;
  /**
   * 配置错误时的退出码：默认 1（0.3 行为）；`--feishu` 传 2（Addendum C/D）。
   */
  configErrorExitCode?: number;
}

export interface BootstrapResult {
  /** 外壳消费面：legacy 时是 AgentRuntime，host 时是 OwnerRuntimeFacade */
  runtime: RunnableAgent;
  ctx: ReplContext;
  config: Awaited<ReturnType<typeof loadConfig>>['config'];
  /** 0.5：解析后的 tenant 与目录 */
  tenantId: string;
  tenantPaths: TenantPaths;
  /** 0.5：非 connect 且请求写时持有 */
  tenantLock?: TenantLock;
  /** 0.5 A-6：本地 tenant 的执行面；connect 模式为 undefined */
  bundle?: TenantRuntimeBundle;
  /** 0.5：trace 控制面（disabled/off 或 connect 模式为 undefined） */
  trace?: TraceControl;
  /** 0.5：session rename/delete 控制面 */
  sessionControl?: SessionControl;
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
  /** 0.3 durable：checkpoint store（durable 关闭时为 undefined） */
  runStore?: RunStore;
  /** 0.3 durable：TUI `/runs` 控制面（durable 关闭时为 undefined） */
  runs?: DurableRunsControlLike;
  /** 0.4：workflow 引擎（路径版 controls + close/interruptAll）；未启用为 undefined */
  workflows?: WorkflowEngineLike;
  /** 0.4：飞书渠道（enabled 时构造，不自动 start）；未启用为 undefined */
  feishu?: FeishuChannelLike;
  /** 0.4：metrics 控制面；observability 块缺省或 metrics:false 时为 undefined */
  metrics?: MetricsControlLike;
  /** 0.4：SIGINT/SIGTERM 时调用 workflow.interruptAll()（落 interrupted） */
  interruptWorkflows: () => Promise<void>;
  /**
   * 恢复一次 run 并等待完成（CLI `--resume-run` 使用）。
   * 失败抛带稳定 code 的错误：run_not_found / run_not_resumable /
   * run_already_running / durable_disabled / agent_not_found。
   */
  resumeRun(
    runId: string,
    opts?: RunOptions,
  ): Promise<{
    sessionId: string;
    result: string;
    mode: 'host' | 'single-agent';
  }>;
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRunEventValue(value: unknown): value is RunEvent {
  return (
    isRecordValue(value) &&
    typeof value.type === 'string' &&
    typeof value.run_id === 'string' &&
    typeof value.ts === 'number'
  );
}

/**
 * connect 模式（A-4 §11.6）：不获取 tenant 写锁、不写本地 store/trace。
 * 本地 session 使用内存后端；run 走 canonical `runs.start`。
 */
async function bootstrapConnect(input: {
  config: VesselConfig;
  nodeId: string;
  tenantId: string;
  tenantPaths: TenantPaths;
  url: string;
  rpcClientFactory?: (opts: {
    baseUrl: string;
    token: string;
  }) => RpcClient & { close(): Promise<void> };
}): Promise<BootstrapResult> {
  // 连接 token：VESSEL_CONNECT_TOKEN → VESSEL_GATEWAY_TOKEN →
  // config 的 serve.token / token_env → transport.token；永不打印。
  const token =
    nonEmptyString(process.env.VESSEL_CONNECT_TOKEN) ??
    nonEmptyString(process.env.VESSEL_GATEWAY_TOKEN) ??
    nonEmptyString(input.config.serve?.token) ??
    nonEmptyString(
      input.config.serve?.tokenEnv ? process.env[input.config.serve.tokenEnv] : undefined,
    ) ??
    nonEmptyString(input.config.transport?.token) ??
    '';
  let client: RpcClient & { close(): Promise<void> };
  try {
    client = input.rpcClientFactory
      ? input.rpcClientFactory({ baseUrl: input.url, token })
      : createHttpRpcClient({ baseUrl: input.url, token });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const events = createEventStream(input.config);
  const pluginHost = new MemoryPluginHost();
  const session = new MemorySessionBackend();
  const context = new MemoryContextManager({
    maxTokens: input.config.context?.maxTokens,
    maxMessages: input.config.context?.maxMessages,
    autoCompact: input.config.context?.autoCompact,
    compactThreshold: input.config.context?.compactThreshold,
  });

  let currentSessionId = newSessionId();
  let shuttingDown = false;

  const unsubscribe = client.subscribe((notification) => {
    if (!isRunEventValue(notification.params)) return;
    try {
      events.publish(notification.params);
    } catch {
      // 订阅者异常不影响连接
    }
  });

  const runtime: RunnableAgent = {
    events,
    pluginHost,
    async run(inputValue, sessionId, opts) {
      const prompt = typeof inputValue === 'string' ? inputValue : String(inputValue.content);
      const result = await client.request<unknown>('runs.start', {
        input: prompt,
        session_id: sessionId ?? currentSessionId,
        ...(opts?.messages ? { messages: opts.messages } : {}),
      });
      if (typeof result === 'string') return result;
      if (isRecordValue(result) && typeof result.result === 'string') return result.result;
      return '';
    },
    dispose() {
      unsubscribe();
      void client.close();
    },
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    unsubscribe();
    try {
      await client.close();
    } catch {
      // best-effort
    }
  };

  const ctx: ReplContext = {
    runtime,
    pluginHost,
    session,
    events,
    context,
    currentSessionId,
    onSessionChange: (id) => {
      currentSessionId = id;
    },
    provider: {
      name: input.config.provider?.name ?? 'openai',
      model: input.config.provider?.model ?? '',
      baseUrl: input.config.provider?.baseUrl ?? '',
    },
    plugins: [],
    rpc: client,
    tenant: { tenant_id: input.tenantId, data_dir: input.tenantPaths.root },
    config: input.config,
    newSessionId,
    onExit: () => {
      void shutdown().finally(() => process.exit(0));
    },
  };

  return {
    runtime,
    ctx,
    config: input.config,
    tenantId: input.tenantId,
    tenantPaths: input.tenantPaths,
    nodeId: input.nodeId,
    interruptWorkflows: async () => {},
    resumeRun: async (runId) => {
      const result = await client.request<unknown>('runs.resume', { run_id: runId });
      const record = isRecordValue(result) ? result : {};
      return {
        sessionId: typeof record.session_id === 'string' ? record.session_id : currentSessionId,
        result: typeof record.result === 'string' ? record.result : '',
        mode: 'single-agent' as const,
      };
    },
    shutdown,
    cleanup: () => {
      void shutdown();
    },
  };
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
    configErrorExitCode = 1,
  } = options;

  // ── 加载配置 ────────────────────────────────────
  const loaded = await loadConfig({
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.userConfigPath !== undefined ? { userConfigPath: options.userConfigPath } : {}),
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
  });
  const { config, validation, tenantId } = loaded;

  // nodeId 唯一来源（U3）：host.node_id，缺省进程内生成；team/transport/PeerInfo 共用。
  const nodeId =
    config.host?.nodeId ?? `vessel-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

  if (!useMock && validation.errors.length > 0) {
    for (const e of validation.errors) console.error(`✗ ${e.message}`);
    process.exit(configErrorExitCode);
  }

  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) console.warn(`⚠ ${w.message}`);
  }

  // ── tenant / data_dir / connect（0.5）───────────
  if (config.tenant?.tenants?.[tenantId]?.status === 'disabled') {
    console.error(`forbidden: tenant "${tenantId}" is disabled`);
    process.exit(1);
  }

  const dataDir = options.dataDir ?? resolveDataDir(config);
  const tenantPaths = resolveTenantPaths(dataDir, tenantId);
  const connectUrl = options.connect ?? process.env.VESSEL_CONNECT;
  const connectMode = typeof connectUrl === 'string' && connectUrl.trim() !== '';

  // connect 模式：不获取写锁、不写本地 store/trace；配置仍加载用于 tenant/token 选择。
  if (connectMode) {
    return bootstrapConnect({
      config,
      nodeId,
      tenantId,
      tenantPaths,
      url: connectUrl,
      ...(options.rpcClientFactory ? { rpcClientFactory: options.rpcClientFactory } : {}),
    });
  }

  if (!useMock && !interactive && !config.apiKey) {
    console.error('No API key configured. Run `vessel` interactively first to set up.');
    process.exit(configErrorExitCode);
  }

  // ── tenant 写锁（0.5）───────────────────────────
  // 默认由调用方按写意图传入 acquireLock；connect 模式已在上面短路。
  let tenantLock: TenantLock | undefined;
  if (options.acquireLock === true) {
    try {
      tenantLock = await acquireTenantLock({
        tenantDir: tenantPaths.root,
        tenantId,
        ...(options.clock ? { now: options.clock } : {}),
      });
    } catch (error) {
      if (error instanceof TenantLockError) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
    // exit 兜底：同步释放（仅持有锁的真实写入口注册）。
    process.once('exit', () => {
      tenantLock?.releaseSync();
    });
  }

  // 启动 prune：best-effort，失败只 warn（无写意图时不触碰磁盘）。
  const localWrites = options.acquireLock === true || options.dataDir !== undefined;
  if (localWrites) {
    try {
      await pruneTenantTrace({ config, tenantPaths });
    } catch (error) {
      console.warn(
        `⚠ Failed to prune trace: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ── 每 tenant 执行面（0.5 A-6）──────────────────
  // 本地模式复用同一工厂，只构建当前 tenant；provider / 插件 / trace /
  // metrics 全部由 bundle 持有。bootstrap 只负责入口、RPC 与生命周期。
  const loader = new PluginLoader();
  let currentSessionId = sessionId ?? newSessionId();
  const bundle = await buildTenantRuntime({
    tenantId,
    config,
    tenantPaths,
    configSources: loaded.sources,
    configPaths: loaded.paths,
    tenantOverlayKeys: loaded.tenantOverlayKeys,
    ...(tenantLock ? { lock: tenantLock } : {}),
    useMock,
    headless,
    registerAskUser,
    loader,
    nodeId,
    sessionId: currentSessionId,
    createLoopbackTransport: true,
    writeTrace: localWrites,
    pruneTrace: false,
    ...(options.metricsFactory ? { metricsFactory: options.metricsFactory } : {}),
    ...(options.traceFactory ? { traceFactory: options.traceFactory } : {}),
    ...(options.redactor ? { redactor: options.redactor } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.loadMcpModule ? { loadMcpModule: options.loadMcpModule } : {}),
    ...(options.loadWorkflowModule ? { loadWorkflowModule: options.loadWorkflowModule } : {}),
    ...(options.loadFeishuModule ? { loadFeishuModule: options.loadFeishuModule } : {}),
    ...(options.feishuTransport !== undefined ? { feishuTransport: options.feishuTransport } : {}),
  }).catch((error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : error}`);
    process.exit(configErrorExitCode);
  });

  const {
    provider,
    providerName,
    providerModel,
    providerBaseUrl,
    context,
    session,
    sessionControl,
    plugins,
    runtime: activeRuntime,
    host,
    pluginHost: finalPluginHost,
    runtimeEvents,
    trace,
    metrics,
    runStore,
    workflows: workflowEngine,
    feishu: feishuChannel,
    transport: deferredTransport,
    spawnAgent,
  } = bundle;

  // MCP 控制面（bundle 内已安装；保留局部名以兼容后续注入）。
  const mcpControl = bundle.mcp;

  // 非成员 resume 回退 runtime 的构造参数（与 bundle 内保持一致）。
  const limits = config.limits ?? DEFAULT_CONFIG.limits ?? {};
  const termination = {
    maxIterations:
      config.termination?.maxIterations ?? DEFAULT_CONFIG.termination?.maxIterations ?? 20,
    maxRuntimeSeconds:
      config.termination?.maxRuntimeSeconds ?? DEFAULT_CONFIG.termination?.maxRuntimeSeconds,
  };
  const systemPrompt = config.agent?.systemPrompt ?? '你是一个有用的 AI 助手。';
  const permission = {
    default: headless ? ('allow' as const) : ('ask' as const),
    autoApprove: ['ask_user'],
  };

  // ── Durable resume（0.3）─────────────────────────
  // 路由按 checkpoint.agent_id：缺失/owner/宿主成员 → host.resume；
  // 非宿主成员 → 单 agent AgentRuntime.resume（不注入合成消息）。
  const ownerId = config.team?.ownerId ?? 'owner';
  let fallbackRuntime: AgentRuntime | undefined;

  const getSingleAgentRuntime = async (): Promise<RunnableAgent> => {
    if (!host) return activeRuntime;
    // host 模式下的非成员恢复：按需构造一个共享 port 的单 agent runtime。
    fallbackRuntime ??= await AgentRuntime.create({
      provider,
      model: providerModel,
      context,
      events: runtimeEvents,
      limits,
      termination,
      session,
      pluginHost: finalPluginHost,
      systemPrompt,
      permission,
      ...(runStore ? { runStore } : {}),
    });
    return fallbackRuntime;
  };

  const startResume = async (
    runId: string,
    opts?: RunOptions,
  ): Promise<DurableRunHandleLike & { mode: 'host' | 'single-agent' }> => {
    if (!runStore) {
      throw resumeError('durable_disabled', runId, 'durable.enabled is false');
    }

    const checkpoint = await loadResumableCheckpoint(runStore, runId);
    const route = routeResume(checkpoint, host, ownerId);

    if (route === 'host' && host?.resume) {
      // agent_not_found 等错误原样上报，不回退（避免与 Host 内的 run 双跑）。
      const handle = await host.resume(runId);
      let cancelled = false;
      const done = handle.result.then(
        (message) => ({ status: 'completed' as const, message }),
        (error) =>
          cancelled ? { status: 'cancelled' as const } : { status: 'failed' as const, error },
      );
      return {
        runId,
        sessionId: handle.sessionId ?? checkpoint.session_id,
        done,
        cancel: () => {
          cancelled = true;
          handle.cancel('resume cancelled');
        },
        mode: 'host',
      };
    }

    const resumeRuntime = await getSingleAgentRuntime();
    if (typeof resumeRuntime.resume !== 'function') {
      throw resumeError('resume_unavailable', runId, 'runtime does not support resume');
    }

    const controller = new AbortController();
    const promise = resumeRuntime.resume(runId, { ...opts, signal: controller.signal });
    const done = promise.then(
      (message) => ({ status: 'completed' as const, message }),
      (error) =>
        controller.signal.aborted
          ? { status: 'cancelled' as const }
          : { status: 'failed' as const, error },
    );

    return {
      runId,
      sessionId: checkpoint.session_id,
      done,
      cancel: () => controller.abort(),
      mode: 'single-agent',
    };
  };

  const runs: DurableRunsControlLike | undefined = runStore
    ? {
        list: (listOptions) => listRunSummaries(runStore, listOptions),
        resume: (runId) => startResume(runId),
      }
    : undefined;

  const resumeRun: BootstrapResult['resumeRun'] = async (runId, opts) => {
    const started = await startResume(runId, opts);
    const outcome = await started.done;
    if (outcome.status === 'cancelled') {
      throw resumeError('resume_cancelled', runId);
    }
    if (outcome.status === 'failed') {
      throw outcome.error instanceof Error
        ? outcome.error
        : resumeError('resume_failed', runId, String(outcome.error));
    }
    return {
      sessionId: started.sessionId,
      result: outcome.message ?? '',
      mode: started.mode,
    };
  };

  // ── Local RPC dispatcher（0.5 A-5）───────────────
  // 本地模式不监听端口；CLI/TUI 通过 ctx.rpc 走与 gateway 相同的方法表。
  const localAuth = resolveGatewayAuth(config, {
    hostname: '127.0.0.1',
    allowRemote: false,
    env: process.env,
  });
  const localDispatcher: LocalRpcDispatcher = createLocalRpcDispatcher({
    events: runtimeEvents,
    session,
    runtime: activeRuntime,
    context,
    pluginHost: finalPluginHost,
    ...(localAuth.ok ? { auth: localAuth.auth } : {}),
    version: readPackageVersion(),
    nodeId,
    defaultTenantId: tenantId,
    config: {
      snapshot: async (requestedTenant: string): Promise<ConfigSnapshotLike> => {
        if (requestedTenant === tenantId) {
          return buildConfigSnapshot({
            config,
            sources: loaded.sources,
            paths: loaded.paths,
            tenantId,
            tenantOverlayKeys: loaded.tenantOverlayKeys,
          }) as unknown as ConfigSnapshotLike;
        }
        const other = await loadConfig({
          ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
          ...(options.userConfigPath !== undefined
            ? { userConfigPath: options.userConfigPath }
            : {}),
          tenantId: requestedTenant,
        });
        return buildConfigSnapshot({
          config: other.config,
          sources: other.sources,
          paths: other.paths,
          tenantId: other.tenantId,
          tenantOverlayKeys: other.tenantOverlayKeys,
        }) as unknown as ConfigSnapshotLike;
      },
    },
    tenants: createTenantControl(dataDir, {
      ...(config.tenant?.tenants ? { configured: config.tenant.tenants } : {}),
    }),
    plugins: () => plugins.map((plugin) => ({ name: plugin.name, enabled: true })),
    ...(metrics ? { metrics: () => metrics.snapshot() } : {}),
    metricsControl: {
      ...(typeof (metrics as unknown as { reset?: unknown })?.reset === 'function'
        ? { reset: () => (metrics as unknown as { reset: () => void }).reset() }
        : {}),
      rebuild: (requestedTenant: string) =>
        rebuildMetrics(resolveTenantPaths(dataDir, requestedTenant).events_dir),
    },
    trace: {
      // A-6 §13.3：web 传 ctx.tenantId；本地 dispatcher 按 tenant 路由。
      readEvents: (filter: Record<string, unknown>, requestedTenant?: string) => {
        const eventsDir =
          requestedTenant === undefined || requestedTenant === tenantId
            ? tenantPaths.events_dir
            : resolveTenantPaths(dataDir, requestedTenant).events_dir;
        return readTraceEvents(eventsDir, filter as ReadTraceOptions);
      },
      prune: (params: Record<string, unknown>) => {
        const requestedTenant =
          typeof params.tenant_id === 'string' && params.tenant_id !== ''
            ? params.tenant_id
            : tenantId;
        const paths = resolveTenantPaths(dataDir, requestedTenant);
        const pruneOptions = {
          ...(typeof params.older_than_days === 'number'
            ? { retentionDays: params.older_than_days }
            : {}),
          ...(typeof params.max_runs === 'number' ? { maxRuns: params.max_runs } : {}),
          ...(typeof params.max_bytes === 'number' ? { maxBytes: params.max_bytes } : {}),
        };
        return withTenantLock({ tenantDir: paths.root, tenantId: requestedTenant }, () =>
          pruneTrace(paths.events_dir, pruneOptions),
        );
      },
    },
    sessionData: {
      // A-6 §13.3：本地模式只有当前 tenant 的 session backend。
      deleteSessionData: (sessionId: string, requestedTenant?: string) => {
        if (requestedTenant !== undefined && requestedTenant !== tenantId) {
          return Promise.reject(
            Object.assign(
              new Error(`forbidden: tenant "${requestedTenant}" is not available in local mode`),
              { code: 'forbidden' },
            ),
          );
        }
        return withTenantLock({ tenantDir: tenantPaths.root, tenantId }, () =>
          sessionControl.delete(sessionId),
        );
      },
    },
    redactor: bundle.redactor,
    runtimeFor: (requestedTenant: string) =>
      requestedTenant === tenantId ? activeRuntime : undefined,
    sessionFor: (requestedTenant: string) => (requestedTenant === tenantId ? session : undefined),
    contextFor: (requestedTenant: string) => (requestedTenant === tenantId ? context : undefined),
    pluginHostFor: (requestedTenant: string) =>
      requestedTenant === tenantId ? finalPluginHost : undefined,
    ...(runStore
      ? {
          durable: {
            store: runStore,
            ...(runs
              ? {
                  resume: async (runId: string) => {
                    const handle = await runs.resume(runId);
                    void handle?.done;
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(mcpControl ? { mcp: { listServers: () => mcpControl.list() } } : {}),
    ...(workflowEngine
      ? {
          workflows: {
            ...adaptWorkflowsControl(workflowEngine, config),
            resolveDefinition: (name: string) => resolveWorkflowDefPathSync(config, name),
          },
        }
      : {}),
    ...(feishuChannel ? { feishu: { status: () => feishuChannel.status() } } : {}),
  });
  const localRpcClient = createLocalRpcClient({ dispatch: localDispatcher.dispatch });

  // ── 关闭 ────────────────────────────────────────
  let shuttingDown = false;

  /** SIGINT/SIGTERM：workflow 在跑 run 落 interrupted（不是用户 cancel） */
  const interruptWorkflows = async (): Promise<void> => {
    if (!workflowEngine) return;
    try {
      await workflowEngine.interruptAll();
    } catch (e) {
      console.warn(`⚠ Failed to interrupt workflows: ${e instanceof Error ? e.message : e}`);
    }
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      localDispatcher.dispose();
    } catch {
      // dispatcher 释放是 best-effort
    }

    try {
      fallbackRuntime?.dispose();
    } catch {
      // 单 agent 回退 runtime 的清理同样是 best-effort
    }

    // bundle 关闭顺序：feishu → workflow → metrics → MCP → host/runtime
    // → trace → runStore → session；锁由 bootstrap 在最后释放。
    await bundle.close();

    // 锁最后释放。
    if (tenantLock) {
      try {
        await tenantLock.release();
      } catch (e) {
        console.warn(`⚠ Failed to release tenant lock: ${e instanceof Error ? e.message : e}`);
      }
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
    rpc: localRpcClient,
    tenant: { tenant_id: tenantId, data_dir: tenantPaths.root },
    config,
    // 0.3 注入面：未启用时保持 undefined，既有行为不变。
    ...(mcpControl ? { mcp: mcpControl } : {}),
    ...(runs ? { runs } : {}),
    // 0.4 注入面：未启用时保持 undefined。
    ...(workflowEngine ? { workflows: adaptWorkflowsControl(workflowEngine, config) } : {}),
    ...(metrics ? { metrics: () => metrics.snapshot() } : {}),
    ...(feishuChannel ? { feishu: { status: () => feishuChannel.status() } } : {}),
    newSessionId,
    onExit: () => {
      void shutdown().finally(() => process.exit(0));
    },
  };

  return {
    runtime: activeRuntime,
    ctx,
    config,
    tenantId,
    tenantPaths,
    bundle,
    ...(tenantLock ? { tenantLock } : {}),
    ...(trace ? { trace } : {}),
    sessionControl,
    host,
    nodeId,
    spawnAgent,
    transport: deferredTransport,
    mcp: mcpControl,
    runStore,
    runs,
    workflows: workflowEngine,
    feishu: feishuChannel,
    metrics,
    interruptWorkflows,
    resumeRun,
    shutdown,
    cleanup: () => {
      void shutdown();
    },
  };
}
