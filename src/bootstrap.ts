/**
 * 应用引导模块
 *
 * 负责：config → provider → plugins → runtime → ReplContext
 * 从 cli.ts 中提取，解决 #16 issue
 */

import * as path from 'node:path';
import {
  buildConfigSnapshot,
  DEFAULT_CONFIG,
  getUserConfigPath,
  loadConfig,
  resolveEffectiveApiKey,
  type VesselConfig,
} from '../packages/config/src/index';
import {
  AgentRuntime,
  type AgentStatus,
  type Logger,
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
import { formatConfigErrors } from './config-error-format';
import { sanitizeConfigForSnapshot } from './config-snapshot';
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
import { t } from './i18n';
import { createCliLogger } from './logging';
import type { McpControl } from './mcp-wiring';
import type { MockScenarioName } from './mock/scenarios';
import { createEventStream, type MetricsFactory } from './observability-wiring';
import { resolveWorkflowDefPathSync } from './path-resolution';
import {
  addAutoApproveRule,
  listAutoApproveRules,
  removeAutoApproveRule,
} from './permission-store';
import { declarativePluginEntries } from './plugin-config';
import { PluginLoader } from './plugin-loader';
import { resolvePluginSelection, warnExternalPluginsOnce } from './plugin-selection';
import {
  createHttpRpcClient,
  createLocalRpcClient,
  normalizeConnectUrl,
  type RpcClient,
} from './rpc/index';
import { resolveGatewayAuth } from './serve-auth';
import type { SessionControl } from './session-control';
import { reportShutdownFailure } from './shutdown-report';
import { createTenantControl } from './tenant-command';
import { acquireTenantLock, type TenantLock, TenantLockError, withTenantLock } from './tenant-lock';
import { buildTenantRuntime, type TenantRuntimeBundle } from './tenant-runtime-factory';
import { pruneTenantTrace, type TraceControl, type TraceRecorderFactory } from './trace-wiring';
import { readPackageVersion } from './version';
import { adaptWorkflowsControl } from './workflow-wiring';

/**
 * tui 0.6.1 冻结的权限控制面（本 worktree 的 tui 尚未导出该类型）。
 * 合并 tui 后可改为 `import type { PermissionsControl } from '@vessel/tui'`。
 */
interface PermissionsControlLike {
  list(): Promise<string[]>;
  add(toolName: string): Promise<void>;
  remove(toolName: string): Promise<void>;
  path?(): string;
}

type ReplContextWithPermissions = ReplContext & {
  permissions?: PermissionsControlLike;
};

export interface BootstrapOptions {
  /** 使用 mock 模式 */
  useMock?: boolean;
  /** mock 场景（仅 useMock）；缺省时走 MemoryLLMProvider */
  mockScenario?: MockScenarioName;
  /** 在解析后的 data_dir 下追加隔离子目录（`vessel demo` 用 `demo`） */
  dataDirSubdir?: string;
  /** 会话 ID */
  sessionId?: string;
  /** 0.6.1：`-c/--continue`（仅 connect 模式由 bootstrapConnect 解析；本地由 CLI 解析） */
  continueLatest?: boolean;
  /** 0.6.1：`-r <id>`（仅 connect 模式由 bootstrapConnect 校验） */
  resumeSessionId?: string;
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
  /**
   * 0.8.1：CLI 显式 flag 组成的最高优先级配置层。
   * 与 env / tenant overlay / project / user / default 一起由 loader 合并。
   */
  cliOverrides?: Partial<VesselConfig>;
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
  /** 0.6：`--connect-token`（最高优先级；不回显） */
  connectToken?: string;
  /** 0.6：`--ca <path>`（自签/私有 CA，PEM） */
  caFile?: string;
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
    ca?: string;
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
  /**
   * 诊断 logger（0.10 R2-14）。CLI / serve 注入同一个 stderr logger；
   * 嵌入方缺省时由 bootstrap 按环境变量创建。
   */
  logger?: Logger;
}

export interface BootstrapResult {
  /** 外壳消费面：legacy 时是 AgentRuntime，host 时是 OwnerRuntimeFacade */
  runtime: RunnableAgent;
  ctx: ReplContext;
  config: Awaited<ReturnType<typeof loadConfig>>['config'];
  /** 0.5：解析后的 tenant 与目录 */
  tenantId: string;
  tenantPaths: TenantPaths;
  /** 0.6：connect 模式下远端 gateway 的 tenant / node（来自 health.get） */
  remote?: { tenantId: string; nodeId?: string; endpoint: string };
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
   * team 的晚绑定 transport（仅 host + team + loopback/remote）。
   * cli 在 gateway 启动、真实 transport 构造后调用 resolve/fail。
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
   * `drain: false`：调用方已 `await gateway.stop()`，避免重复限时等待。
   */
  shutdown: (options?: { drain?: boolean }) => Promise<void>;
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

/**
 * 把旧式 `connectToken` / `caFile` 选项折入 CLI 覆盖层。
 * 生产路径直接传 `cliOverrides`；这里仅为兼容既有调用方，保证只有一个合并点。
 */
function withConnectCliOverrides(
  cliOverrides: Partial<VesselConfig> | undefined,
  connectToken: string | undefined,
  caFile: string | undefined,
): Partial<VesselConfig> | undefined {
  const token = nonEmptyString(connectToken);
  const ca = nonEmptyString(caFile);
  if (token === undefined && ca === undefined) return cliOverrides;

  const legacy: NonNullable<VesselConfig['connect']> = {
    ...(token !== undefined ? { token } : {}),
    ...(ca !== undefined ? { caFile: ca } : {}),
  };
  return {
    ...cliOverrides,
    connect: { ...legacy, ...(cliOverrides?.connect ?? {}) },
  };
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
  /** headless 不显示 provider banner，无需额外查询 gateway。 */
  headless: boolean;
  /** 0.6：显式 tenant（--tenant / VESSEL_TENANT）才把 tenant_id 合并进请求。 */
  tenantExplicit: boolean;
  /** 0.10 R2-14：诊断 logger（与 bootstrap 共用） */
  logger: Logger;
  /** 0.6.1：显式 session id（`--session` / `-r <id>`） */
  sessionId?: string;
  /** 0.6.1：`-c/--continue`；经 sessions.list 选择最近的非空会话 */
  continueLatest?: boolean;
  /** 0.6.1：`-r <id>`；先用 sessions.get 校验存在 */
  resumeSessionId?: string;
  rpcClientFactory?: (opts: {
    baseUrl: string;
    token: string;
    ca?: string;
  }) => RpcClient & { close(): Promise<void> };
}): Promise<BootstrapResult> {
  // P2：--connect 接受 ws:// / wss://（归一化为 http/https）。
  const connectUrl = normalizeConnectUrl(input.url);

  // 连接 token / CA 全部来自 config loader 的单一结果：
  // CLI（cliOverrides）> env（VESSEL_CONNECT_TOKEN / VESSEL_GATEWAY_TOKEN /
  // VESSEL_CONNECT_CA）> project > user > default。此处不再读 argv / env。
  // 旧版 fallback（serve.token / transport.token）仍作为配置层回退保留。
  // 永不打印。
  const token =
    nonEmptyString(input.config.connect?.token) ??
    nonEmptyString(input.config.serve?.token) ??
    nonEmptyString(input.config.transport?.token) ??
    '';

  // CA：只读文件，错误信息不带 token。
  const caPath = nonEmptyString(input.config.connect?.caFile);
  let ca: string | undefined;
  if (caPath !== undefined) {
    try {
      ca = await Bun.file(caPath).text();
    } catch {
      console.error(t('connect.caUnreadable', { path: caPath }));
      process.exit(1);
    }
    if (ca.trim() === '') {
      console.error(t('connect.caEmpty', { path: caPath }));
      process.exit(1);
    }
  }

  let client: RpcClient & { close(): Promise<void> };
  try {
    client = input.rpcClientFactory
      ? input.rpcClientFactory({
          baseUrl: connectUrl,
          token,
          ...(ca !== undefined ? { ca } : {}),
        })
      : createHttpRpcClient({
          baseUrl: connectUrl,
          token,
          ...(ca !== undefined ? { ca } : {}),
        });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // A4：显式 --tenant / VESSEL_TENANT 时把 tenant_id 合并进每个请求；
  // 未显式指定时由 gateway token principal 决定（不发送 tenant_id）。
  const withTenant = (params: unknown): unknown => {
    if (!input.tenantExplicit) return params;
    if (isRecordValue(params)) return { ...params, tenant_id: input.tenantId };
    return { tenant_id: input.tenantId };
  };
  const rpc: RpcClient & { close(): Promise<void> } = {
    request: <T = unknown>(method: string, params?: unknown) =>
      client.request<T>(method, withTenant(params)),
    subscribe: (handler) => client.subscribe(handler),
    close: () => client.close(),
  };

  // A4：远端 tenant/node 以 health.get 为准（token principal 或 admin 覆盖）。
  let remote: BootstrapResult['remote'];
  let effectiveTenantId = input.tenantId;
  try {
    const health = await rpc.request<unknown>('health.get');
    if (isRecordValue(health)) {
      const remoteTenant =
        typeof health.tenant_id === 'string' && health.tenant_id !== ''
          ? health.tenant_id
          : input.tenantId;
      const node = isRecordValue(health.node) ? health.node : undefined;
      const remoteNodeId =
        node && typeof node.node_id === 'string' && node.node_id !== '' ? node.node_id : undefined;
      remote = {
        tenantId: remoteTenant,
        ...(remoteNodeId !== undefined ? { nodeId: remoteNodeId } : {}),
        endpoint: connectUrl,
      };
      effectiveTenantId = remoteTenant;
    }
  } catch {
    // 旧 gateway / 权限不足：保留本地 tenant，仅少展示 node。
  }

  // connect 模式下 agent 实际跑在 gateway 上：状态栏应显示 gateway 的 provider，
  // 而不是本地 config 的 provider（否则 mock/远端 gateway 会显示成误导性的本地模型）。
  let gatewayProvider = input.config.provider;
  if (!input.headless) {
    try {
      const snapshot = await rpc.request<unknown>('config.get');
      if (isRecordValue(snapshot)) {
        const configValue = isRecordValue(snapshot.config) ? snapshot.config : undefined;
        const provider =
          configValue && isRecordValue(configValue.provider) ? configValue.provider : undefined;
        if (provider) {
          const name =
            typeof provider.name === 'string' && provider.name
              ? provider.name
              : gatewayProvider?.name;
          if (name) {
            gatewayProvider = {
              ...gatewayProvider,
              name,
              ...(typeof provider.model === 'string' ? { model: provider.model } : {}),
              ...(typeof provider.baseUrl === 'string' ? { baseUrl: provider.baseUrl } : {}),
            };
          }
        }
      }
    } catch {
      // 旧 gateway / 受限权限没有 config.get：退回本地配置。
    }
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

  // ── 会话续接（0.6.1 E8）：remote 端是唯一数据源 ──
  let resolvedSessionId = input.sessionId;
  if (input.resumeSessionId !== undefined) {
    try {
      await rpc.request('sessions.get', { session_id: input.resumeSessionId });
    } catch (error) {
      console.error(
        t('connect.resumeFailed', {
          id: input.resumeSessionId,
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exit(1);
    }
    resolvedSessionId = input.resumeSessionId;
  } else if (input.continueLatest === true) {
    try {
      const raw = await rpc.request<unknown>('sessions.list');
      const list = Array.isArray(raw)
        ? raw
        : isRecordValue(raw) && Array.isArray(raw.sessions)
          ? raw.sessions
          : [];
      const sessions = list
        .filter(isRecordValue)
        .filter((entry) => typeof entry.session_id === 'string')
        .map((entry) => ({
          session_id: entry.session_id as string,
          updated_at: typeof entry.updated_at === 'number' ? entry.updated_at : 0,
          message_count: typeof entry.message_count === 'number' ? entry.message_count : 0,
        }))
        .filter((entry) => entry.message_count > 0)
        .sort((a, b) =>
          b.updated_at !== a.updated_at
            ? b.updated_at - a.updated_at
            : a.session_id.localeCompare(b.session_id),
        );
      const latest = sessions[0];
      if (!latest) {
        console.error(t('common.noSessions'));
        process.exit(1);
      }
      resolvedSessionId = latest.session_id;
    } catch (error) {
      console.error(
        t('connect.listFailed', {
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exit(1);
    }
  }

  let currentSessionId = resolvedSessionId ?? newSessionId();
  let shuttingDown = false;

  const unsubscribe = client.subscribe((notification) => {
    if (!isRunEventValue(notification.params)) return;
    try {
      events.publish(notification.params);
    } catch {
      // 订阅者异常不影响连接
    }
  });

  /**
   * A3：TUI / headless 只会在本地 events 上发布 response；
   * connect 模式下必须经 canonical RPC 回远端。失败只写 stderr。
   */
  /**
   * gateway 会把 `permission.respond` / `ask.respond` 的结果再作为事件推回来。
   * 记录已转发的 requestId，回声到达时只消费一次，避免二次 RPC。
   */
  const forwardedInteractions = new Set<string>();
  const rememberForwarded = (key: string): void => {
    forwardedInteractions.add(key);
    while (forwardedInteractions.size > 1000) {
      const first = forwardedInteractions.values().next();
      if (first.done) break;
      forwardedInteractions.delete(first.value);
    }
  };

  const unsubscribeInteractions = events.subscribe((event) => {
    const data = isRecordValue(event.data) ? event.data : undefined;
    if (!data) return;
    if (event.type === 'tool.permission.response') {
      const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;
      const decision =
        data.decision === 'allow' || data.decision === 'deny' ? data.decision : undefined;
      if (requestId === undefined || decision === undefined) return;
      const key = `permission:${requestId}`;
      if (forwardedInteractions.delete(key)) return;
      rememberForwarded(key);
      void rpc
        .request('permission.respond', {
          request_id: requestId,
          decision,
          ...(data.remember === true ? { remember: true } : {}),
        })
        .catch((error: unknown) => {
          console.error(
            `Remote permission response failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      return;
    }
    if (event.type === 'ask.user.answered') {
      const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;
      if (requestId === undefined || !Array.isArray(data.answers)) return;
      const key = `ask:${requestId}`;
      if (forwardedInteractions.delete(key)) return;
      rememberForwarded(key);
      void rpc
        .request('ask.respond', { request_id: requestId, answers: data.answers })
        .catch((error: unknown) => {
          console.error(
            `Remote ask response failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
  });

  const runtime: RunnableAgent = {
    events,
    pluginHost,
    async run(inputValue, sessionId, opts) {
      const prompt = typeof inputValue === 'string' ? inputValue : String(inputValue.content);
      const result = await rpc.request<unknown>('runs.start', {
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
      unsubscribeInteractions();
      void client.close();
    },
  };

  const shutdown = async (_options?: { drain?: boolean }): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    unsubscribe();
    unsubscribeInteractions();
    try {
      await client.close();
    } catch (error) {
      reportShutdownFailure({
        events,
        logger: input.logger,
        step: 'client.close',
        error,
        tenantId: effectiveTenantId,
      });
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
      name: gatewayProvider?.name ?? 'openai',
      model: gatewayProvider?.model ?? '',
      baseUrl: gatewayProvider?.baseUrl ?? '',
    },
    plugins: [],
    rpc,
    tenant: { tenant_id: effectiveTenantId, data_dir: input.tenantPaths.root },
    config: input.config,
    version: readPackageVersion(),
    newSessionId,
    onExit: () => {
      void shutdown().finally(() => process.exit(0));
    },
  };

  return {
    runtime,
    ctx,
    config: input.config,
    tenantId: effectiveTenantId,
    ...(remote !== undefined ? { remote } : {}),
    tenantPaths: input.tenantPaths,
    nodeId: input.nodeId,
    interruptWorkflows: async () => {},
    resumeRun: async (runId) => {
      const result = await rpc.request<unknown>('runs.resume', { run_id: runId });
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
  // 0.10 R2-14：诊断日志只写 stderr；嵌入方 / CLI 可注入自己的 sink。
  const logger = options.logger ?? createCliLogger();

  // ── 加载配置 ────────────────────────────────────
  // 单一 resolver：CLI 覆盖层（含旧式 connectToken/caFile）只在这里进入。
  const cliOverrides = withConnectCliOverrides(
    options.cliOverrides,
    options.connectToken,
    options.caFile,
  );
  const loaded = await loadConfig({
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.userConfigPath !== undefined ? { userConfigPath: options.userConfigPath } : {}),
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    ...(cliOverrides !== undefined ? { cliOverrides } : {}),
  });
  const { config, validation, tenantId, paths: configPaths } = loaded;

  // nodeId 唯一来源（U3）：host.node_id，缺省进程内生成；team/transport/PeerInfo 共用。
  const nodeId =
    config.host?.nodeId ?? `vessel-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

  if (!useMock && validation.errors.length > 0) {
    console.error(formatConfigErrors(validation.errors, { paths: configPaths }));
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

  const resolvedDataDir = options.dataDir ?? resolveDataDir(config);
  const dataDir = options.dataDirSubdir
    ? path.join(resolvedDataDir, options.dataDirSubdir)
    : resolvedDataDir;
  const tenantPaths = resolveTenantPaths(dataDir, tenantId);
  const connectUrl = options.connect ?? process.env.VESSEL_CONNECT;
  const connectMode = typeof connectUrl === 'string' && connectUrl.trim() !== '';

  // connect 模式：不获取写锁、不写本地 store/trace；配置仍加载用于 tenant/token 选择。
  if (connectMode) {
    // 只有 CLI / env 显式选择 tenant 才覆盖 token principal；config.tenant.default 不算。
    const tenantExplicit =
      options.tenantId !== undefined || (process.env.VESSEL_TENANT ?? '').trim() !== '';
    return bootstrapConnect({
      config,
      nodeId,
      tenantId,
      tenantPaths,
      url: connectUrl,
      headless,
      tenantExplicit,
      logger,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.continueLatest === true ? { continueLatest: true } : {}),
      ...(options.resumeSessionId !== undefined
        ? { resumeSessionId: options.resumeSessionId }
        : {}),
      ...(options.rpcClientFactory ? { rpcClientFactory: options.rpcClientFactory } : {}),
    });
  }

  if (!useMock && !interactive && !resolveEffectiveApiKey(config)) {
    console.error(t('common.noApiKey'));
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
  // 启动告警：默认集包含外部插件时提示信任边界（opt-out 见 VESSEL_NO_EXTERNAL_PLUGINS）。
  warnExternalPluginsOnce(
    resolvePluginSelection(
      loader,
      config.plugins,
      Boolean(process.env.VESSEL_DEBUG),
      declarativePluginEntries(config),
    ).external,
  );
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
    ...(options.mockScenario !== undefined ? { mockScenario: options.mockScenario } : {}),
    headless,
    registerAskUser,
    loader,
    nodeId,
    sessionId: currentSessionId,
    createLoopbackTransport: true,
    logger,
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
    // E7：配置持久化的 always 规则 + 运行时始终免确认的 ask_user。
    autoApprove: [...new Set([...(config.permission?.autoApprove ?? []), 'ask_user'])],
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
      logger,
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
            config: sanitizeConfigForSnapshot(config),
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
          ...(cliOverrides !== undefined ? { cliOverrides } : {}),
        });
        return buildConfigSnapshot({
          config: sanitizeConfigForSnapshot(other.config),
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
  // A1：本地 RPC ← runtimeEvents 的只读桥接。TUI 的 `/runs resume` 与
  // `/workflows run|resume` 只靠 `rpc.subscribe` 等待终态；缺少 onEvent 时
  // 订阅是 no-op，命令会一直挂起。通知只再分发，不写回事件流。
  const localRpcClient = createLocalRpcClient({
    dispatch: localDispatcher.dispatch,
    onEvent: (handler) =>
      runtimeEvents.subscribe((event) => {
        handler({ method: 'events.event', params: event });
      }),
  });

  // ── 权限控制面（0.6.1 E7；tui 的 `ReplContext.permissions`）────
  // 用户 YAML 的 permission.auto_approve；TUI "always" 与 /permissions 共用。
  const permissionConfigPath = options.userConfigPath ?? getUserConfigPath();
  const permissionsControl = {
    list: async (): Promise<string[]> => listAutoApproveRules({ configPath: permissionConfigPath }),
    add: async (toolName: string): Promise<void> => {
      addAutoApproveRule(toolName, { configPath: permissionConfigPath });
    },
    remove: async (toolName: string): Promise<void> => {
      removeAutoApproveRule(toolName, { configPath: permissionConfigPath });
    },
    path: (): string => permissionConfigPath,
  };

  // ── 权限 "always" 持久化（0.6.1 E7）────────────────
  // 只在真正交互的本地 REPL 生效：remote/connect 的授权属于远端 gateway，
  // serve/headless 的 allow 不是用户显式选择。
  let unsubPermissionPersist: (() => void) | undefined;
  if (interactive) {
    const pendingTools = new Map<string, string>();
    unsubPermissionPersist = runtimeEvents.subscribe((event) => {
      const data = isRecordValue(event.data) ? event.data : undefined;
      if (!data) return;

      if (event.type === 'tool.permission.request') {
        const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;
        const tool = typeof data.tool === 'string' ? data.tool : undefined;
        if (requestId === undefined || tool === undefined) return;
        pendingTools.set(requestId, tool);
        while (pendingTools.size > 1000) {
          const first = pendingTools.keys().next();
          if (first.done) break;
          pendingTools.delete(first.value);
        }
        return;
      }

      if (event.type !== 'tool.permission.response') return;
      const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;
      const tool = requestId === undefined ? undefined : pendingTools.get(requestId);
      if (requestId !== undefined) pendingTools.delete(requestId);
      if (tool === undefined || data.remember !== true) return;

      try {
        addAutoApproveRule(tool, { configPath: permissionConfigPath });
      } catch (error) {
        console.warn(
          `⚠ Failed to persist permission rule for "${tool}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
  }

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

  const shutdown = async (shutdownOptions: { drain?: boolean } = {}): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      unsubPermissionPersist?.();
    } catch {
      // 退订是 best-effort
    }
    unsubPermissionPersist = undefined;

    try {
      localDispatcher.dispose();
    } catch (error) {
      reportShutdownFailure({
        events: bundle.events,
        logger,
        step: 'dispatcher.dispose',
        error,
        tenantId,
      });
    }

    // 0.9：dispose 返回 Promise（插件逆序清理）；等待完成，异常不外抛。
    try {
      await fallbackRuntime?.dispose();
    } catch (error) {
      reportShutdownFailure({
        events: bundle.events,
        logger,
        step: 'fallbackRuntime.dispose',
        error,
        tenantId,
      });
    }

    // bundle 关闭顺序：feishu → workflow → metrics → MCP → host/runtime
    // → trace → runStore → session；锁由 bootstrap 在最后释放。
    await bundle.close(shutdownOptions);

    // 锁最后释放。
    if (tenantLock) {
      try {
        await tenantLock.release();
      } catch (error) {
        reportShutdownFailure({
          events: bundle.events,
          logger,
          step: 'tenantLock.release',
          error,
          tenantId,
        });
      }
    }
  };

  // ── ReplContext ─────────────────────────────────
  // 工具/插件的唯一来源是同一个 PluginHost（插件在 install() 里注册）。
  const ctx: ReplContextWithPermissions = {
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
    version: readPackageVersion(),
    // 0.6.1：TUI "always" 与 /permissions 的用户 YAML 写回面。
    permissions: permissionsControl,
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
