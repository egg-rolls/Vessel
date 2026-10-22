/**
 * 应用引导模块
 *
 * 负责：config → provider → plugins → runtime → ReplContext
 * 从 cli.ts 中提取，解决 #16 issue
 */

import * as path from 'node:path';
import type { AgentService, MemberStatus } from '@vessel-agent/agent';
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
  createGatewayEventHub,
  createLocalRpcDispatcher,
  type LocalRpcDispatcher,
} from '../packages/serve/src/index';
import type { ReplContext } from '../packages/tui/src/index';
import { type AgentOwnerServer, startAgentOwnerServer } from './agent-owner-server';
import { createAgentServiceWiring } from './agent-service-wiring';
import { type MemberPermissionMode, resolveAgentWiring } from './agent-wiring';
import { formatConfigErrors } from './config-error-format';
import { sanitizeConfigForSnapshot } from './config-snapshot';
import {
  type ConnectResumeStart,
  type ConnectRunStart,
  waitForConnectedResumeTerminal,
  waitForConnectedRun,
} from './connect-run-wait';
import type { FeishuChannelLike, MetricsControlLike } from './control-plane-types';
import { resolveDataDir } from './data-paths';
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
import {
  addAutoApproveRule,
  listAutoApproveRules,
  removeAutoApproveRule,
} from './permission-store';
import { declarativePluginEntries } from './plugin-config';
import { PluginLoader } from './plugin-loader';
import { resolvePluginSelection, warnExternalPluginsOnce } from './plugin-selection';
import { withReasoning } from './reasoning';
import {
  createHttpRpcClient,
  createLocalRpcClient,
  normalizeConnectUrl,
  type RpcClient,
} from './rpc/index';
import { ownerSelfCard } from './self-card';
import { resolveGatewayAuth } from './serve-auth';
import type { SessionControl } from './session-control';
import { acquireSessionLock, type SessionLock, SessionLockedError } from './session-lock';
import { reportShutdownFailure } from './shutdown-report';
import { createTenantControl } from './tenant-command';
import {
  acquireTenantLock,
  type TenantLock,
  TenantLockError,
  type TenantLockMode,
  withTenantLock,
} from './tenant-lock';
import { buildTenantRuntime, type TenantRuntimeBundle } from './tenant-runtime-factory';
import { pruneTenantTrace, type TraceControl, type TraceRecorderFactory } from './trace-wiring';
import { resolveConnectToken } from './transport-factory';
import { createReplSettings, type ReplSettingsControlLike } from './ui-settings';
import { readPackageVersion } from './version';

/**
 * tui 0.6.1 冻结的权限控制面（本 worktree 的 tui 尚未导出该类型）。
 * 合并 tui 后可改为 `import type { PermissionsControl } from '@vessel-agent/tui'`。
 */
/** `--connect --run` 缺省终态等待上限（10 分钟）；测试可覆盖。 */
const DEFAULT_CONNECT_RUN_TIMEOUT_MS = 10 * 60_000;

interface PermissionsControlLike {
  list(): Promise<string[]>;
  add(toolName: string): Promise<void>;
  remove(toolName: string): Promise<void>;
  path?(): string;
}

type ReplContextWithPermissions = ReplContext & {
  permissions?: PermissionsControlLike;
  /** 0.11 DECISION-021 §3.2：语言设置控制面 */
  settings?: ReplSettingsControlLike;
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
  /**
   * 是否注册 ask_user（默认 = interactive；headless 下注册只会让 waitFor 超时）。
   * 最终还会被 `ui.askUser: false` 关闭；CLI 在 gateway/serve 模式下显式传 true。
   */
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
  /** 0.15：`--exclusive` 强制 tenant 单写者锁（默认 file 后端 shared） */
  exclusive?: boolean;
  /** 0.5：`--connect <url>` / VESSEL_CONNECT；设置时不加锁、不写本地 store */
  connect?: string;
  /** 0.6：`--connect-token`（最高优先级；不回显） */
  connectToken?: string;
  /** 0.6：`--ca <path>`（自签/私有 CA，PEM） */
  caFile?: string;
  /** 0.5：测试注入 data_dir（缺省 config.dataDir → VESSEL_DATA_DIR → 默认值） */
  dataDir?: string;
  /** 0.18：connect 模式 run 的终态等待上限（缺省 10 分钟；测试注入） */
  connectRunTimeoutMs?: number;
  /** 0.18：connect 模式 `runs.get` 轮询间隔（缺省 1000ms；测试注入） */
  connectRunPollMs?: number;
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
  /** 0.4 测试注入口：feishu 模块加载器 */
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
  /**
   * 0.17 Phase A：交互入口的 AgentService（含 loopback owner 端点）。
   * headless 默认不启动；显式 `agent.enabled: true` 时存在。
   */
  agent?: {
    service: AgentService;
    owner: MemberStatus;
    ownerId: string;
    ownerServer?: AgentOwnerServer;
    dispose: () => Promise<void>;
  };
  /** 0.5：trace 控制面（disabled/off 或 connect 模式为 undefined） */
  trace?: TraceControl;
  /** 0.5：session rename/delete 控制面 */
  sessionControl?: SessionControl;
  /** host.enabled=true 且构造成功时存在 */
  host?: RuntimeHost;
  /** nodeId 唯一来源：config.host.nodeId，缺省进程内生成 */
  nodeId: string;
  /** 0.3：MCP 控制面（未配置 mcp_servers 时为 undefined） */
  mcp?: McpControl;
  /** 0.3 durable：checkpoint store（durable 关闭时为 undefined） */
  runStore?: RunStore;
  /** 0.3 durable：TUI `/runs` 控制面（durable 关闭时为 undefined） */
  runs?: DurableRunsControlLike;
  /** 0.4：飞书渠道（enabled 时构造，不自动 start）；未启用为 undefined */
  feishu?: FeishuChannelLike;
  /** 0.4：metrics 控制面；observability 块缺省或 metrics:false 时为 undefined */
  metrics?: MetricsControlLike;
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
 * `runs.resume` 的 RPC 错误 → resume 稳定码（DECISION-033）。
 * 未列出的错误归 `resume_failed`；错误消息不含 token。
 */
function resumeRpcError(error: unknown, runId: string): Error {
  const code = (error as { code?: unknown } | null)?.code;
  const details = (error as { details?: unknown } | null)?.details;
  const legacy =
    isRecordValue(details) && typeof details.legacy_code === 'string'
      ? details.legacy_code
      : undefined;
  const mapped =
    code === 'not_found'
      ? 'run_not_found'
      : code === 'forbidden'
        ? 'forbidden'
        : code === 'not_supported'
          ? 'resume_unavailable'
          : code === 'conflict' && legacy === 'run_not_resumable'
            ? 'run_not_resumable'
            : code === 'conflict' && legacy === 'run_already_running'
              ? 'run_already_running'
              : 'resume_failed';
  const message = (error instanceof Error ? error.message : String(error)) || runId;
  return Object.assign(new Error(message), { code: mapped });
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
  /** 0.11：本地用户配置路径（ui.language 写回；缺省 getUserConfigPath()） */
  userConfigPath?: string;
  /** 0.6.1：显式 session id（`--session` / `-r <id>`） */
  sessionId?: string;
  /** 0.6.1：`-c/--continue`；经 sessions.list 选择最近的非空会话 */
  continueLatest?: boolean;
  /** 0.6.1：`-r <id>`；先用 sessions.get 校验存在 */
  resumeSessionId?: string;
  /** 0.18：run 终态等待上限 / 轮询间隔（测试注入） */
  connectRunTimeoutMs?: number;
  connectRunPollMs?: number;
  rpcClientFactory?: (opts: {
    baseUrl: string;
    token: string;
    ca?: string;
  }) => RpcClient & { close(): Promise<void> };
}): Promise<BootstrapResult> {
  // P2：--connect 接受 ws:// / wss://（归一化为 http/https）。
  const connectUrl = normalizeConnectUrl(input.url);

  // 连接 token 与远程控制面共用 `resolveConnectToken`（DECISION-033）：
  // connect 专用凭据 → gateway 凭据（serve.token / token_env / admin_token(_env) /
  // VESSEL_GATEWAY_TOKEN / transport.token）。config loader 已合并 CLI / env / 文件层，
  // 因此显式 token 取合并后的 config.connect.token——不能让裸 env 覆盖 `--connect-token`。
  // 永不打印。
  const token =
    resolveConnectToken(input.config, { connectToken: input.config.connect?.token }) ?? '';

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

  /**
   * 0.17 P0：`runs.start` 只返回排队信封（`{run_id,status}`），不是最终输出。
   * 终态等待逻辑（事件匹配 + runs.get 确认 + 轮询 + 超时）在
   * `connect-run-wait.ts`，便于单测“终态事件不投递”场景。
   */
  const runtime: RunnableAgent = {
    events,
    pluginHost,
    async run(inputValue, sessionId, opts) {
      // Message 原样使用（content 已是 string）；不做 String(content) 降级。
      const prompt = typeof inputValue === 'string' ? inputValue : inputValue.content;
      const targetSession = sessionId ?? currentSessionId;
      return await waitForConnectedRun({
        events,
        prompt,
        sessionId: targetSession,
        timeoutMs: input.connectRunTimeoutMs ?? DEFAULT_CONNECT_RUN_TIMEOUT_MS,
        ...(input.connectRunPollMs !== undefined ? { pollIntervalMs: input.connectRunPollMs } : {}),
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        start: async (): Promise<ConnectRunStart> => {
          const result = await rpc.request<unknown>('runs.start', {
            input: prompt,
            session_id: targetSession,
            ...(opts?.messages ? { messages: opts.messages } : {}),
          });
          // 旧 gateway 兼容：直接返回文本 / `{result}` 时原样返回。
          if (typeof result === 'string') return { kind: 'legacy', text: result };
          if (!isRecordValue(result) || typeof result.run_id !== 'string') {
            if (isRecordValue(result) && typeof result.result === 'string') {
              return { kind: 'legacy', text: result.result };
            }
            throw new Error('runs.start returned no run_id');
          }
          return { kind: 'job', jobId: result.run_id };
        },
        getRun: (jobId) => rpc.request<unknown>('runs.get', { run_id: jobId }),
      });
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

  const ctx: ReplContextWithPermissions = {
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
    // 0.11：connect 模式同样允许写本地用户配置（远端不受影响）。
    settings: createReplSettings({
      configPath: input.userConfigPath ?? getUserConfigPath(),
      configLanguage: input.config.ui?.language,
      ...(input.config.ui?.statusBars !== undefined
        ? { configStatusBars: input.config.ui.statusBars }
        : {}),
      ...(input.config.ui?.errorLevel !== undefined
        ? { configErrorLevel: input.config.ui.errorLevel }
        : {}),
      ...(input.config.ui?.verbosity !== undefined
        ? { configVerbosity: input.config.ui.verbosity }
        : {}),
    }),
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
    resumeRun: async (runId, opts) => {
      const outcome = await waitForConnectedResumeTerminal({
        events,
        runId,
        sessionId: currentSessionId,
        timeoutMs: input.connectRunTimeoutMs ?? DEFAULT_CONNECT_RUN_TIMEOUT_MS,
        ...(input.connectRunPollMs !== undefined ? { pollIntervalMs: input.connectRunPollMs } : {}),
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        resume: async (): Promise<ConnectResumeStart> => {
          let result: unknown;
          try {
            result = await rpc.request<unknown>('runs.resume', { run_id: runId });
          } catch (error) {
            throw resumeRpcError(error, runId);
          }
          if (typeof result === 'string') return { kind: 'legacy', text: result };
          if (!isRecordValue(result)) {
            throw Object.assign(new Error('runs.resume returned no result'), {
              code: 'resume_failed',
            });
          }
          if (typeof result.result === 'string') return { kind: 'legacy', text: result.result };
          const returnedRunId = result.run_id;
          if (typeof returnedRunId !== 'string' || returnedRunId === '') {
            throw Object.assign(new Error('runs.resume returned no run_id'), {
              code: 'resume_failed',
            });
          }
          return {
            kind: 'queued',
            runId: returnedRunId,
            ...(typeof result.session_id === 'string' && result.session_id !== ''
              ? { sessionId: result.session_id }
              : {}),
          };
        },
        getRun: (targetRunId) => rpc.request<unknown>('runs.get', { run_id: targetRunId }),
      });
      return {
        sessionId: outcome.sessionId !== '' ? outcome.sessionId : currentSessionId,
        result: outcome.output,
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

  // nodeId 唯一来源（U3）：host.node_id，缺省进程内生成；transport / PeerInfo 共用。
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
      ...(options.userConfigPath !== undefined ? { userConfigPath: options.userConfigPath } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.continueLatest === true ? { continueLatest: true } : {}),
      ...(options.resumeSessionId !== undefined
        ? { resumeSessionId: options.resumeSessionId }
        : {}),
      ...(options.connectRunTimeoutMs !== undefined
        ? { connectRunTimeoutMs: options.connectRunTimeoutMs }
        : {}),
      ...(options.connectRunPollMs !== undefined
        ? { connectRunPollMs: options.connectRunPollMs }
        : {}),
      ...(options.rpcClientFactory ? { rpcClientFactory: options.rpcClientFactory } : {}),
    });
  }

  if (!useMock && !interactive && !resolveEffectiveApiKey(config)) {
    console.error(t('common.noApiKey'));
    process.exit(configErrorExitCode);
  }

  // ── tenant 写锁（0.5；0.15 双层锁）──────────────
  // 默认由调用方按写意图传入 acquireLock；connect 模式已在上面短路。
  // file / memory 后端 shared（多实例共存），sqlite 或 --exclusive 走单写者。
  const sessionBackend = config.session?.backend ?? 'file';
  const tenantLockMode: TenantLockMode =
    options.exclusive === true || sessionBackend === 'sqlite' ? 'exclusive' : 'shared';
  let tenantLock: TenantLock | undefined;
  if (options.acquireLock === true) {
    try {
      tenantLock = await acquireTenantLock({
        tenantDir: tenantPaths.root,
        tenantId,
        mode: tenantLockMode,
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
  // 0.15：REPL / headless 对显式会话持进程级写锁（`--continue` / `-r` / `--session`）。
  // serve-only 不持长锁：gateway 每次 run 取锁，避免空闲实例挡住其它前端。
  let processSessionLock: SessionLock | undefined;
  if (
    options.sessionId !== undefined &&
    sessionBackend !== 'memory' &&
    (interactive === true || headless === true)
  ) {
    try {
      processSessionLock = await acquireSessionLock({
        tenantDir: tenantPaths.root,
        kind: 'session',
        id: options.sessionId,
        ...(options.clock ? { now: options.clock } : {}),
      });
      process.once('exit', () => processSessionLock?.releaseSync());
    } catch (error) {
      if (error instanceof SessionLockedError) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
  }
  // 0.17 A4：成员工具只走 AgentService；显式 `agent.enabled: true` 才启动。
  const agentPlan = resolveAgentWiring(config, { headless });
  const agentServiceEnabled = agentPlan.agentEnabled;

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
    // 0.15：显式 ui.askUser=false 关闭；无客户端的入口不会传 true。
    registerAskUser: registerAskUser && config.ui?.askUser !== false,
    loader,
    nodeId,
    sessionId: currentSessionId,
    logger,
    writeTrace: localWrites,
    pruneTrace: false,
    ...(options.metricsFactory ? { metricsFactory: options.metricsFactory } : {}),
    ...(options.traceFactory ? { traceFactory: options.traceFactory } : {}),
    ...(options.redactor ? { redactor: options.redactor } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.loadMcpModule ? { loadMcpModule: options.loadMcpModule } : {}),
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
    eventLog,
    feishu: feishuChannel,
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

  // ── AgentService + REPL owner 端点（0.17 Phase A）──
  let agentControl: BootstrapResult['agent'];
  if (agentServiceEnabled) {
    // A3c：交互入口成员 ask 经父事件流弹现有权限卡片；headless 直接 allow。
    const memberPermissionMode: MemberPermissionMode = agentPlan.permissionMode;
    const memberTermination =
      agentPlan.termination !== undefined
        ? {
            maxIterations: agentPlan.termination.maxIterations ?? termination.maxIterations,
            maxRuntimeSeconds:
              agentPlan.termination.maxRuntimeSeconds ?? termination.maxRuntimeSeconds,
          }
        : termination;
    const wiring = await createAgentServiceWiring({
      tenantId,
      dataDir,
      sessionId: currentSessionId,
      pluginHost: finalPluginHost,
      // provider 无跨请求状态；成员与父级共用同一实例。
      providerFactory: () => provider,
      model: agentPlan.model ?? providerModel,
      limits: agentPlan.limits ?? limits,
      termination: memberTermination,
      ...(agentPlan.readOnlyTools !== undefined ? { readOnlyTools: agentPlan.readOnlyTools } : {}),
      ...(config.context?.maxTokens !== undefined
        ? { contextMaxTokens: config.context.maxTokens }
        : {}),
      permission,
      permissionMode: memberPermissionMode,
      // 成员 bridge 请求 / 应答与 TUI 订阅的是同一条父事件流。
      parentEvents: runtimeEvents,
      ...(config.agent?.ownerId !== undefined ? { ownerId: config.agent.ownerId } : {}),
      logger,
      // 0.18：成员 run 与父级共用同一事件日志（唯一真相源）。
      ...(eventLog
        ? {
            runtimeFactory: (runtimeOptions: Parameters<typeof AgentRuntime.create>[0]) =>
              AgentRuntime.create({ ...runtimeOptions, eventLog }),
          }
        : {}),
    });
    finalPluginHost.registerTool(wiring.tool);

    let ownerServer: AgentOwnerServer | undefined;
    try {
      ownerServer = await startAgentOwnerServer({
        service: wiring.service,
        dataDir,
        tenantId,
        logger,
      });
    } catch (error) {
      // 同一 dataDir 已有 owner 时第二个 REPL 仍可用进程内工具；
      // CLI attach 保持在原 owner 上。
      console.warn(
        `⚠ agent owner endpoint unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    agentControl = {
      service: wiring.service,
      owner: wiring.owner,
      ownerId: wiring.ownerId,
      ...(ownerServer !== undefined ? { ownerServer } : {}),
      dispose: async () => {
        // 先停注入，避免关闭过程中父 turn 再排空 owner 队列。
        wiring.injector.dispose();
        await ownerServer?.stop();
        await wiring.service.flushSnapshot();
      },
    };
  }

  // ── Durable resume（0.3）─────────────────────────
  // 路由按 checkpoint.agent_id：缺失/owner/宿主成员 → host.resume；
  // 非宿主成员 → 单 agent AgentRuntime.resume（不注入合成消息）。
  const ownerId = config.agent?.ownerId ?? 'main';
  let fallbackRuntime: AgentRuntime | undefined;

  const getSingleAgentRuntime = async (): Promise<RunnableAgent> => {
    if (!host) return activeRuntime;
    // host 模式下的非成员恢复：按需构造一个共享 port 的单 agent runtime。
    fallbackRuntime ??= await AgentRuntime.create(
      // 0.11.1：思考流开关与主 runtime 保持一致（默认 false）。
      withReasoning(config, {
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
        selfCard: ownerSelfCard(config, providerModel, {
          askUser: registerAskUser,
        }),
        ...(runStore ? { runStore } : {}),
        ...(eventLog ? { eventLog } : {}),
        logger,
      }),
    );
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
    // 0.15: one writer per run across processes (host.resume bypasses the runtime wrapper).
    const runLock = await acquireSessionLock({
      tenantDir: tenantPaths.root,
      kind: 'run',
      id: runId,
      ...(options.clock ? { now: options.clock } : {}),
    });

    if (route === 'host' && host?.resume) {
      // agent_not_found 等错误原样上报，不回退（避免与 Host 内的 run 双跑）。
      let handle: Awaited<ReturnType<typeof host.resume>>;
      try {
        handle = await host.resume(runId);
      } catch (error) {
        await runLock.release();
        throw error;
      }
      let cancelled = false;
      const done = handle.result
        .then(
          (message) => ({ status: 'completed' as const, message }),
          (error) =>
            cancelled ? { status: 'cancelled' as const } : { status: 'failed' as const, error },
        )
        .finally(() => {
          void runLock.release();
        });
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
      await runLock.release();
      throw resumeError('resume_unavailable', runId, 'runtime does not support resume');
    }

    const controller = new AbortController();
    const promise = resumeRuntime.resume(runId, { ...opts, signal: controller.signal });
    const done = promise
      .then(
        (message) => ({ status: 'completed' as const, message }),
        (error) =>
          controller.signal.aborted
            ? { status: 'cancelled' as const }
            : { status: 'failed' as const, error },
      )
      .finally(() => {
        void runLock.release();
      });

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
  // 0.18：本地模式只有一个 tenant 流；dispatcher 与 gateway 共用同一个 hub。
  const localEventHub = createGatewayEventHub({
    streams: [{ tenantId, stream: runtimeEvents }],
    // 0.18：live 与 trace 同源（bundle.redactor 已是 core+ext 组合实例）。
    redactor: bundle.redactor,
  });
  const localDispatcher: LocalRpcDispatcher = createLocalRpcDispatcher({
    hub: localEventHub,
    session,
    // 0.15: local RPC runs also take the session write lock.
    runtime: bundle.runtime,
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
      requestedTenant === tenantId ? bundle.runtime : undefined,
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
    ...(feishuChannel ? { feishu: { status: () => feishuChannel.status() } } : {}),
  });
  // A1：本地 RPC ← runtimeEvents 的只读桥接。TUI 的 `/runs resume`
  // 只靠 `rpc.subscribe` 等待终态；缺少 onEvent 时订阅是 no-op，命令会一直挂起。
  // 通知只再分发，不写回事件流。
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

  const shutdown = async (shutdownOptions: { drain?: boolean } = {}): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      unsubPermissionPersist?.();
    } catch {
      // 退订是 best-effort
    }
    unsubPermissionPersist = undefined;

    // 0.17：先停 owner 端点，CLI 不再有机会在 teardown 中途入队。
    try {
      await agentControl?.dispose();
    } catch (error) {
      reportShutdownFailure({
        events: bundle.events,
        logger,
        step: 'agent.dispose',
        error,
        tenantId,
      });
    }

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

    try {
      localEventHub.close();
    } catch (error) {
      reportShutdownFailure({
        events: bundle.events,
        logger,
        step: 'eventHub.close',
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

    // bundle 关闭顺序：feishu → metrics → MCP → host/runtime
    // → trace → runStore → session；锁由 bootstrap 在最后释放。
    await bundle.close(shutdownOptions);

    // 锁最后释放（session 写锁先于 tenant 锁）。
    if (processSessionLock) {
      try {
        await processSessionLock.release();
      } catch (error) {
        reportShutdownFailure({
          events: bundle.events,
          logger,
          step: 'sessionLock.release',
          error,
          tenantId,
        });
      }
    }
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
    runtime: bundle.runtime,
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
    // 0.18：resume 历史从会话事件日志重建；memory / 只读执行面没有日志时保持 undefined。
    ...(eventLog ? { eventLog } : {}),
    // 0.11：TUI /settings 的语言写回面（同一用户 YAML）；0.13 增加状态栏位置。
    settings: createReplSettings({
      configPath: permissionConfigPath,
      configLanguage: config.ui?.language,
      ...(config.ui?.statusBars !== undefined ? { configStatusBars: config.ui.statusBars } : {}),
      ...(config.ui?.errorLevel !== undefined ? { configErrorLevel: config.ui.errorLevel } : {}),
      ...(config.ui?.verbosity !== undefined ? { configVerbosity: config.ui.verbosity } : {}),
    }),
    // 0.3 注入面：未启用时保持 undefined，既有行为不变。
    ...(mcpControl ? { mcp: mcpControl } : {}),
    ...(runs ? { runs } : {}),
    // 0.4 注入面：未启用时保持 undefined。
    ...(metrics ? { metrics: () => metrics.snapshot() } : {}),
    ...(feishuChannel ? { feishu: { status: () => feishuChannel.status() } } : {}),
    newSessionId,
    onExit: () => {
      void shutdown().finally(() => process.exit(0));
    },
  };

  return {
    runtime: bundle.runtime,
    ctx,
    config,
    tenantId,
    tenantPaths,
    bundle,
    ...(agentControl !== undefined ? { agent: agentControl } : {}),
    ...(tenantLock ? { tenantLock } : {}),
    ...(trace ? { trace } : {}),
    sessionControl,
    host,
    nodeId,
    mcp: mcpControl,
    runStore,
    runs,
    feishu: feishuChannel,
    metrics,
    resumeRun,
    shutdown,
    cleanup: () => {
      void shutdown();
    },
  };
}
