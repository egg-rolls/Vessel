/**
 * 应用引导模块
 *
 * 负责：config → provider → plugins → runtime → ReplContext
 * 从 cli.ts 中提取，解决 #16 issue
 */

import * as path from 'node:path';
import {
  type AgentService,
  type AgentTeamService,
  type MemberStatus,
  normalizeWorkspace,
  type TeamDeclaration,
  workspaceKey,
} from '@vessel-agent/agent';
import { createEngineClient, type EngineClient } from '@vessel-agent/engine-client';
import {
  buildConfigSnapshot,
  getUserConfigPath,
  loadConfig,
  resolveEffectiveApiKey,
  type VesselConfig,
} from '../packages/config/src/index';
import {
  assertToolNameLegality,
  imageBlobRoot,
  type Logger,
  MemoryPluginHost,
  MemorySessionStore,
  MemoryWorkingContext,
  type Message,
  pruneTrace,
  type RunEvent,
  type RunnableAgent,
  type RunOptions,
  type RunRecordStore,
  Runtime,
  rebuildMetrics,
  sameRestartMarker,
  type TenantPaths,
  type TraceRedactor,
  toolOutputRoot,
} from '../packages/core/src/index';
import type { AgentControlLike } from '../packages/serve/src/index';
import {
  type ConfigSnapshotLike,
  createGatewayEventHub,
  createLocalRpcDispatcher,
  type HubControlLike,
  type LocalRpcDispatcher,
} from '../packages/serve/src/index';
import type { ReplContext } from '../packages/tui/src/index';
import { createAgentControl } from './agent-control';
import { type AgentOwnerServer, startAgentOwnerServer } from './agent-owner-server';
import { createAgentServiceWiring } from './agent-service-wiring';
import { type MemberPermissionMode, resolveAgentWiring } from './agent-wiring';
import { createAskAnswerDelivery } from './ask-answer-delivery';
import { deliverAnsweredAsksToSession, orphanPendingAsksForRun } from './ask-channel';
import { createConfigAttachmentIngest } from './attachment-ingest';
import { createConfigAttachmentLister } from './attachments-list';
import { registerBashJobDelivery } from './bash-job-delivery';
import { formatConfigErrors } from './config-error-format';
import { sanitizeConfigForSnapshot } from './config-snapshot';
import {
  type ConnectResumeStart,
  type ConnectRunStart,
  waitForConnectedResumeTerminal,
  waitForConnectedRun,
} from './connect-run-wait';
import { createContextUsageSource } from './context-usage';
import type { FeishuChannelLike, MetricsControlLike } from './control-plane-types';
import { withDataLock } from './data-lock';
import { resolveDataDir, resolveEffectiveTenantId, resolveSingleTenantPaths } from './data-paths';
import {
  type DurableRunHandleLike,
  type DurableRunsControlLike,
  listRunSummaries,
  loadResumableCheckpoint,
  resumeError,
} from './durable-wiring';
import { createFederationSendPort } from './federation-send-port';
import { registerRefsNoticeHook, registerRuntimeNoticeHook } from './hot-apply-assembly';
import { createHubRuntime } from './hub-wiring';
import { t } from './i18n';
import {
  formatImageBlobGcReport,
  type ImageBlobGcRunner,
  isBlobRootInsideDataDir,
  startImageBlobGc,
} from './image-blob-gc';
import { createImageDeliverySource } from './image-delivery';
import { resolveInteractionsDir } from './interactions-dir';
import { normalizeLegacyToolName } from './legacy-tool-names';
import { createLocalRunAdapter } from './local-run-adapter';
import { configureLoggingFromConfig, createCliLogger } from './logging';
import type { McpEngineShell } from './mcp-engine-wiring';
import type { McpControl } from './mcp-wiring';
import type { MockScenarioName } from './mock/scenarios';
import { createNodeDrainer } from './node-drain';
import { resolveNodeIdentity } from './node-identity';
import { createNodeResumer } from './node-resume';
import { createEventStream, type MetricsFactory } from './observability-wiring';
import { resolveAgentCwd } from './path-resolution';
import { createPeerNoticeRouter, type PeerNoticeRouter } from './peer-notices';
import {
  addAutoApproveRule,
  listAutoApproveRules,
  removeAutoApproveRule,
} from './permission-store';
import { declarativePluginEntries } from './plugin-config';
import {
  activateStartupPlugins,
  createPluginHostManager,
  createPluginReloader,
} from './plugin-host-assembly';
import { PluginLoader } from './plugin-loader';
import { resolvePluginSelection, warnExternalPluginsOnce } from './plugin-selection';
import { startPluginWatch } from './plugin-watch';
import {
  createHttpRpcClient,
  createLocalRpcClient,
  normalizeConnectUrl,
  type RpcClient,
} from './rpc/index';
import { createRunControl } from './run-control';
import { createRuntimeNoticeBus, type RuntimeNoticeBus } from './runtime-notice';
import { resolveGatewayAuth } from './serve-auth';
import type { SessionControl } from './session-control';
import { createSessionEventsSource } from './session-events';
import { acquireSessionLock, type SessionLock, SessionLockedError } from './session-lock';
import { reportShutdownFailure } from './shutdown-report';
import { markStartup, timeStartup } from './startup-timing';
import { createSystemContextSource } from './system-context';
import {
  createTeamHumanDelivery,
  createTeamLocalMemberDelivery,
  type LocalHumanTarget,
  type LocalMemberTarget,
} from './team-human-delivery';
import { buildTenantRuntime, type TenantRuntimeBundle } from './tenant-runtime-factory';
// 0.54 B1 末块：实时尾随端口（发布点扇出 → serve 的时间线 epoch）。
// 只有双写开关开时才有 `timelineDualWrite`，此时才传；关闭路径与 0.53 逐字节相同。
// 0.54 C：`events.list` 的按 run 读端口（同一模块，共用 timeline 的读面与路径口径）。
import { createTimelineRunEventsPort, timelineTailPort } from './timeline-dual-write';
import { createEngineSupervisor, type EngineSupervisor } from './tools-engine/supervisor';
import { callbackRoute } from './tools-engine/wiring';
import { pruneTenantTrace, type TraceControl, type TraceRecorderFactory } from './trace-wiring';
import { resolveConnectToken } from './transport-factory';
import { createReplSettings, type ReplSettingsControlLike } from './ui-settings';
import { readPackageVersion } from './version';
import { createVesselMetaSurface, normalizeBridgeDeny, type VesselRpcPort } from './vessel-meta';
import { visionSurfaceOf } from './vision-settings';

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
   * 是否注册 ask 工具（默认 = interactive）。
   * 0.33：headless 也注册（请求落盘后中断 run，可 resume），不再靠「不注册」避免等待。
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
  /** 外壳消费面：per-session 门面（本地 adapter 或 tenant bundle 门面） */
  runtime: RunnableAgent;
  /**
   * Stage 4：本 node 的 Runtime（tenant profile 注册表 + per-session EU 目录）。
   * 唯一的执行面由 `bundle` 持有；connect 模式不会用到。
   */
  executionRuntime: Runtime;
  ctx: ReplContext;
  config: Awaited<ReturnType<typeof loadConfig>>['config'];
  /** 0.5：解析后的 tenant 与目录 */
  tenantId: string;
  tenantPaths: TenantPaths;
  /** 0.6：connect 模式下远端 gateway 的 tenant / node（来自 health.get） */
  remote?: { tenantId: string; nodeId?: string; endpoint: string };
  /** 0.5 A-6：本地 tenant 的执行面；connect 模式为 undefined */
  bundle?: TenantRuntimeBundle;
  /**
   * tools-engine P2：engine 接入面（本地 bootstrap 才有；connect 模式无本地执行面）。
   * client = 转发/喂账本/回调关联（tools 热应用 applier 重接线用）；
   * bridgeDeny = O2 活引用（permission 热应用 applier 更新，guardrail 逐调用读）。
   */
  toolsEngine?: {
    client: EngineClient;
    supervisor: EngineSupervisor;
    bridgeDeny: { current: string[] };
  };
  /**
   * 0.17 Phase A：AgentService / TeamService（默认开启）。
   * loopback owner 端点只在交互 REPL / serve 启动；headless 不监听端口。
   */
  agent?: {
    service: AgentService;
    /** 0.19 S3：Team 能力层（gateway `teams.*` 与 owner 端点共用） */
    team: AgentTeamService;
    owner: MemberStatus;
    ownerId: string;
    ownerServer?: AgentOwnerServer;
    /** S5：hub 目录投影（未启用 agent 时为 undefined）。 */
    hubControl?: HubControlLike;
    /** 0.25：canonical `agents.create|update|close` 注入面（gateway / 未来 owner 端点共用）。 */
    control: AgentControlLike;
    /**
     * `provider.model` 热应用（P0-1 D4）：替换成员宿主缺省 model，只影响此后 spawn
     * 的 body（live body 构造期只读，下一具才生效）。透传 wiring 的同名入口。
     */
    applyDefaultModel: (model: string) => void;
    dispose: () => Promise<void>;
  };
  /**
   * 运行期通知总线（CONTRACT-hot-apply §3）：runtime.notice → 事件流 + BeforeLlm 注入。
   *
   * agent 装配存在时才有（hook 注册在父 PluginHost 上）；serve 壳必须复用这一个实例，
   * 否则第二个 hook 会因注册名相同被跳过、通知永远进不了模型上下文。
   */
  notice?: RuntimeNoticeBus;
  /** 0.5：trace 控制面（disabled/off 或 connect 模式为 undefined） */
  trace?: TraceControl;
  /** 0.5：session rename/delete 控制面 */
  sessionControl?: SessionControl;
  /** nodeId 唯一来源：config.host.nodeId > node.json > 首次生成 */
  nodeId: string;
  /** 节点展示名：config.host.nodeName > node.json > hostname 派生 */
  nodeName: string;
  /** 0.3：MCP 控制面（未配置 mcp_servers 时为 undefined） */
  mcp?: McpControl;
  /** 0.3 durable：checkpoint store（durable 关闭时为 undefined） */
  runStore?: RunRecordStore;
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
    mode: 'single-agent';
  }>;
  /**
   * 幂等关闭：MCP close → Host/runtime dispose → RunRecordStore close。
   * 新代码应 await 本函数；`cleanup()` 仅供旧调用点兼容。
   * `drain: false`：调用方已 `await gateway.stop()`，避免重复限时等待。
   */
  shutdown: (options?: { drain?: boolean }) => Promise<void>;
  /**
   * 0.52 S1a：node 退出序列第一段（幂等）。
   *
   * fence 准入 → 只给有在跑 run 的会话写 resume 标记 → interrupt('shutdown')
   * → ≤2s settle → flush。**必须在 gateway.stop() 之前调**，否则 run 已被打断，
   * 快照为空就一条标记都写不出来。没有本地执行面（connect 模式）时不提供。
   */
  beginDrain?: () => Promise<void>;
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
 * Q5：`-r/--resume <id>` 的首轮显式走 `resumeSession(sessionId, input)`，
 * 之后恢复普通 `run`。只用于本地进程内路径；connect 模式没有新 RPC，
 * 保持 `runs.start` 到远端 AgentService 的既有语义。
 */
function withFirstRunResume(runtime: RunnableAgent, sessionId: string): RunnableAgent {
  let pending = true;
  return {
    events: runtime.events,
    pluginHost: runtime.pluginHost,
    async run(input, sid, opts) {
      if (pending) {
        pending = false;
        const resume = runtime.resumeSession;
        if (typeof resume === 'function') {
          const target = sid !== undefined && sid !== '' ? sid : sessionId;
          return resume.call(runtime, target, input, opts);
        }
      }
      return runtime.run(input, sid, opts);
    },
    dispose: () => runtime.dispose(),
    ...(runtime.resumeRun !== undefined ? { resumeRun: runtime.resumeRun.bind(runtime) } : {}),
    ...(runtime.resumeSession !== undefined
      ? { resumeSession: runtime.resumeSession.bind(runtime) }
      : {}),
  };
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
  nodeName: string;
  tenantId: string;
  tenantPaths: TenantPaths;
  url: string;
  /** headless 不显示 provider banner，无需额外查询 gateway。 */
  headless: boolean;
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

  const rpc: RpcClient & { close(): Promise<void> } = {
    request: <T = unknown>(method: string, params?: unknown) => client.request<T>(method, params),
    subscribe: (handler) => client.subscribe(handler),
    close: () => client.close(),
  };

  // A4：远端 node 以 health.get 为准；单 id 使用本地解析结果（token principal）。
  let remote: BootstrapResult['remote'];
  const effectiveTenantId = input.tenantId;
  try {
    const health = await rpc.request<unknown>('health.get');
    if (isRecordValue(health)) {
      const node = isRecordValue(health.node) ? health.node : undefined;
      const remoteNodeId =
        node && typeof node.node_id === 'string' && node.node_id !== '' ? node.node_id : undefined;
      remote = {
        tenantId: effectiveTenantId,
        ...(remoteNodeId !== undefined ? { nodeId: remoteNodeId } : {}),
        endpoint: connectUrl,
      };
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

  // Stage 4：connect 模式不执行本地 tenant run（远端才是执行面），但 BootstrapResult
  // 需要同一形状；这里给一个未注册 profile 的空 Runtime（`--connect` 与 `--serve` 互斥）。
  const executionRuntime = new Runtime({
    ...(input.logger !== undefined ? { logger: input.logger } : {}),
  });
  const events = createEventStream(input.config);
  const pluginHost = new MemoryPluginHost();
  const session = new MemorySessionStore();
  const context = new MemoryWorkingContext({
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
  // CONTRACT-0.34-context C6/C7：connect 模式的手动压缩经 canonical RPC。
  // 不改核心 `RunnableAgent`；只在本字面量上做结构化扩展。
  const runtime: RunnableAgent & {
    compactContext?(sessionId?: string): Promise<{ removed: number; remaining: number }>;
  } = {
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
    async compactContext(sessionId?: string) {
      const target = sessionId ?? currentSessionId;
      return await rpc.request<{ removed: number; remaining: number }>('sessions.compact', {
        session_id: target,
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
    tenant: { data_dir: input.tenantPaths.root },
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
    executionRuntime,
    ctx,
    config: input.config,
    tenantId: effectiveTenantId,
    ...(remote !== undefined ? { remote } : {}),
    tenantPaths: input.tenantPaths,
    nodeId: input.nodeId,
    nodeName: input.nodeName,
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
 * 0.19 S3：配置声明 → `new` 的默认 Team workspace。
 *
 * 只做**归一化后的精确相等**匹配（不是前缀 / 祖先）；没有 `agent.cwd` 时用进程 cwd
 * 作声明匹配键（只是匹配键，不是建 Team 的锚点；锚点见 `resolveDefaultTeamAnchor`）。
 * 0 个命中 → undefined；多个命中 → warning + undefined；恰好 1 个 → 归一化 workspace。
 */
export function resolveDefaultTeamWorkspace(
  config: VesselConfig,
  declarations: readonly TeamDeclaration[],
  logger?: Logger,
): string | undefined {
  let cwdKey: string;
  try {
    cwdKey = workspaceKey(normalizeWorkspace(resolveAgentCwd(config) ?? process.cwd()));
  } catch (error) {
    logger?.warn('team.declaration.invalid', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  const matches = declarations.filter((declaration) => {
    try {
      return workspaceKey(normalizeWorkspace(declaration.workspace)) === cwdKey;
    } catch {
      return false;
    }
  });
  if (matches.length > 1) {
    logger?.warn('team.declaration.ambiguous_default', { count: matches.length });
    return undefined;
  }
  const match = matches[0];
  return match === undefined ? undefined : normalizeWorkspace(match.workspace);
}

/**
 * 0.50：交互 / serve 入口在没有显式 `agent.cwd`、也没有声明命中时的默认 Team 锚点。
 *
 * 不能用 `process.cwd()`：TUI 与 gateway 的 node 子进程从不同目录启动（daemon / node
 * spawn 都不设 cwd，子进程继承父进程 cwd），同一 data root 会因此留下多个默认 Team。
 * 从 dataDir 派生后，两个入口归一化到同一个 workspace，`ensureForWorkspace` 幂等收敛到
 * 一个 Team。锚点不需要目录存在（`ensureForWorkspace` 只按路径算身份，不建目录）。
 */
export function resolveDefaultTeamAnchor(dataDir: string): string {
  return path.resolve(dataDir, 'default');
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
    ...(cliOverrides !== undefined ? { cliOverrides } : {}),
  });
  const { config, validation, tenantId: configTenantId, paths: configPaths } = loaded;
  markStartup('config');

  if (!useMock && validation.errors.length > 0) {
    console.error(formatConfigErrors(validation.errors, { paths: configPaths }));
    process.exit(configErrorExitCode);
  }

  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) console.warn(`⚠ ${w.message}`);
  }

  // 日志中枢：配置加载后立即应用 observability.log（环境变量覆盖在中枢内仍优先）。
  // 此前（import / 配置加载阶段）的日志按环境变量与默认值输出，量很少，可接受。
  configureLoggingFromConfig(config);

  // ── data_dir / connect（0.5；0.49 T4 删除 tenant 块）───────────
  const resolvedDataDir = options.dataDir ?? resolveDataDir(config);
  const dataDir = options.dataDirSubdir
    ? path.join(resolvedDataDir, options.dataDirSubdir)
    : resolvedDataDir;
  // 0.49 R1：单 id 以持久化 `<dataDir>/tenant.json` 为准（T4 删除 config tenant 块后
  // `loadConfig()` 恒为 `default`）；fresh 数据根没有该文件时仍回 `default`。
  const tenantId = resolveEffectiveTenantId(configTenantId, dataDir);
  const connectUrl = options.connect ?? process.env.VESSEL_CONNECT;
  const connectMode = typeof connectUrl === 'string' && connectUrl.trim() !== '';
  // connect 是唯一只读入口；其余入口（run / REPL / serve / feishu）都写本地
  // store / trace。tenant writer lock 已随单执行面收敛删除（T3 C2）。
  const localWrites = !connectMode;

  // 0.49 T5（C6）：只支持根布局；`<dataDir>/tenants/**` 非空 → fail-fast，
  // 不读、不迁、不移、不删、不写 marker/journal。写模式与 connect 同口径。
  let tenantPaths: TenantPaths;
  try {
    tenantPaths = resolveSingleTenantPaths(dataDir, tenantId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // 节点身份（0.25）：node_id 唯一来源（U3）：host.node_id > <dataDir>/node.json > 首次生成；
  // 展示名：host.node_name > 文件 name > hostname 派生。transport / PeerInfo 共用 nodeId。
  const nodeIdentity = await resolveNodeIdentity({
    ...(config.host?.nodeId !== undefined ? { configNodeId: config.host.nodeId } : {}),
    ...(config.host?.nodeName !== undefined ? { configNodeName: config.host.nodeName } : {}),
    dataDir,
    logger,
  });
  const nodeId = nodeIdentity.nodeId;
  const nodeName = nodeIdentity.name;
  markStartup('identity');

  // connect 模式：不获取写锁、不写本地 store/trace；配置仍加载用于 token 选择。
  if (connectMode) {
    return bootstrapConnect({
      config,
      nodeId,
      nodeName,
      tenantId,
      tenantPaths,
      url: connectUrl,
      headless,
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

  // T3 C2：runtime/boot 不再获取 tenant writer lock。session/run 锁与
  // SessionLease 仍在执行面内部保证单写者；CLI 写意图锁保留到 T4/T5。
  const sessionBackend = config.session?.backend ?? 'file';

  // 启动 prune：best-effort，失败只 warn（无写意图时不触碰磁盘）。
  //
  // 0.57（**真实事故**：node 启动 16.3s，其中 10~27s 全在这一段）：
  // `trace.retention` 的缺省是 `max_runs: 1000`，而 `pruneTrace` 在「文件数 > max_runs」
  // 时走**全量解析**（每个 trace 文件都要 readFile + 逐帧 JSON.parse 才能知道 lastTs）。
  // 3000+ 个 run 的租户于是每次启动都要把整份 trace 目录重新读一遍 —— 这不是「启动需要
  // 的活」，是**留存清理**，跟能不能接请求毫无关系。
  //
  // 所以判据改成「谁需要它先做完」：
  // - headless（一次性进程）：`await`，否则进程退出时它可能还没跑（语义不变）；
  // - REPL / serve / node：**不阻塞启动**，交给 timer（REPL 早就是这么做的，
  //   S4 §2.2「首帧不能被 prune 阻塞」；这里只是把同一条政策推广到 serve/node）。
  //   它的产物是「删掉过期的 trace」，晚几秒与早几秒对任何人都没有区别。
  const pruneAfterFirstFrame = localWrites && options.headless !== true;
  const pruneTraceBestEffort = async (): Promise<void> => {
    const startedAt = performance.now();
    try {
      const result = await pruneTenantTrace({ config, tenantPaths });
      // 一行结果（第十四条）：干完活必须留账，否则「prune 到底跑了没」只能靠猜。
      if (result.deleted_runs > 0 || result.deleted_bytes > 0) {
        logger.info('trace.prune.done', {
          deleted_runs: result.deleted_runs,
          kept_runs: result.kept_runs,
          deleted_bytes: result.deleted_bytes,
          duration_ms: Math.round(performance.now() - startedAt),
        });
      }
    } catch (error) {
      console.warn(
        `⚠ Failed to prune trace: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  if (localWrites && !pruneAfterFirstFrame) {
    await timeStartup('prune', pruneTraceBestEffort());
  }
  markStartup('prune');

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
  /**
   * 父宿主是否注册 ask 工具（0.27 / 0.33）。
   *
   * 0.33：headless 也注册（请求落盘后挂起，人类稍后回答并 resume），
   * 所以「注册」不再等于「进程内有应答者」。
   *
   * 0.51：成员拿不拿 `ask` 已不由这里决定（不再传 `extraTools`）：判据是「父宿主注册了
   * + 这具身体能 bridge」，由执行内核在 `selectTools` 一处判定（不再对外解释原因）。
   * 这个标志只剩一个用途 —— `humanApproval`：没有进程内应答者时，模型发起的 rotate
   * 直接走 `rotate_not_needed`，不去等一个不会到来的确认。
   */
  const askUserAvailable = registerAskUser && config.ui?.askUser !== false;
  const interactiveHumanAvailable = askUserAvailable && !headless;

  // 0.28 F2：飞书渠道成员被 TTL 回收后，复活所需的 Team id 要等
  // `createAgentServiceWiring` 之后才存在；bundle（含渠道）先构造，所以用晚绑定
  // getter 回填（与 localHuman / localMember 同口径）。headless / 无默认 workspace
  // 时保持 undefined，渠道退回「回收后 member_closed」的旧行为。
  let feishuTeamId: string | undefined;
  // 0.28：渠道执行面所需的 AgentService 同样晚绑定 —— 渠道随 bundle 构造，
  // `createAgentServiceWiring` 之后才存在；插件在 `start()` 时求值。
  let feishuAgentService: AgentService | undefined;
  // ── tools-engine P2：engine child（装配层基础设施，与 gateway 同级；seams 契约 §3）──
  // 每 host 一个 engine child（B 形态）；合成 descriptor 不进 PluginLoader / catalog。
  // getTransport 晚绑定：supervisor 未 start / disabled ⇒ 转发 fail-closed（不静默回退）。
  const engineSupervisorRef: { current?: EngineSupervisor } = {};
  // 批次 2：MCP host shell 晚绑定（factory 装配后才存在；engine 重启 onReady 对账用）。
  const mcpShellRef: { current?: McpEngineShell } = {};
  const engineClient = createEngineClient({
    getTransport: () => engineSupervisorRef.current?.transport,
    logger,
  });
  const engineSupervisor = createEngineSupervisor({
    entryPath: path.join(import.meta.dir, 'tools-engine', 'entry.ts'),
    rootDir: path.join(import.meta.dir, '..'),
    dataDir: path.join(dataDir, 'tools-engine'),
    // 落盘 env 与 host 同源：dataDir = 本入口解析后的数据目录；toolOutputDir = host 生效根。
    settings: { dataDir, toolOutputDir: toolOutputRoot() },
    logger,
    onToolCallback: (params) => engineClient.handleToolCallback(params),
    onEngineNotification: (method, params) => engineClient.handleEngineNotification(method, params),
    // 每次 start / 重启成功后对账（重启不改注册表身份；失败只记日志）。
    // 批次 2：MCP 重喂 configure 重建连接 + 注册对账（换连接不换定义，透明）。
    onReady: () => {
      void (async () => {
        try {
          await mcpShellRef.current?.reconcile();
          await engineClient.pushRegistry();
        } catch (error) {
          logger.warn('tools-engine registry push failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    },
  });
  engineSupervisorRef.current = engineSupervisor;
  // 预算内失败自动重试；预算尽 disabled（start 抛最后一次错误）→ 工具 fail-closed，
  // 启动不崩：用户可见稳定 engine_unavailable 错误（行为验证点：启动诊断）。
  await engineSupervisor.start().catch((error: unknown) => {
    logger.error('tools-engine start failed; whitelisted tools are fail-closed', {
      message: error instanceof Error ? error.message : String(error),
    });
  });

  // Stage 4：每 node 每进程一个 Runtime；tenant bundle 与成员 host 共用。
  const executionRuntime = new Runtime({ logger });
  const bundle = await buildTenantRuntime({
    tenantId,
    runtime: executionRuntime,
    config,
    tenantPaths,
    configSources: loaded.sources,
    configPaths: loaded.paths,
    useMock,
    ...(options.mockScenario !== undefined ? { mockScenario: options.mockScenario } : {}),
    headless,
    // 0.15：显式 ui.askUser=false 关闭；无客户端的入口不会传 true。
    registerAskUser: askUserAvailable,
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
    resolveFeishuTeamId: () => feishuTeamId,
    resolveFeishuService: () => feishuAgentService,
    engineClient,
  }).catch((error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : error}`);
    process.exit(configErrorExitCode);
  });
  markStartup('runtime');
  // 批次 2：MCP host shell 回填（engine 重启 onReady 对账；初始 configure 已在 factory 完成）。
  mcpShellRef.current = bundle.mcpShell;

  const {
    providerName,
    providerModel,
    providerBaseUrl,
    session,
    sessionControl,
    plugins,
    pluginHost: finalPluginHost,
    runtimeEvents,
    trace,
    metrics,
    runStore,
    eventLog,
    timelineLog,
    journalFactory,
    feishu: feishuChannel,
  } = bundle;

  // MCP 控制面（bundle 内已安装；保留局部名以兼容后续注入）。
  const mcpControl = bundle.mcp;

  // Stage 4：WorkingContext 归 Run，tenant bundle 不再持有长期存活实例。
  // 外壳的 `ctx.context` 仍需要一个可读窗口：agent 启用时用 local-run-adapter 的
  // 会话镜像；否则（agent 关闭 / headless）用这个独立镜像，避免和执行内核共享实例。
  const context = new MemoryWorkingContext({
    maxTokens: config.context?.maxTokens,
    maxMessages: config.context?.maxMessages,
    autoCompact: config.context?.autoCompact,
    compactThreshold: config.context?.compactThreshold,
  });

  // 成员 wiring 的构造参数（与 bundle 内保持一致）。
  const limits = config.limits ?? {};
  const termination = {
    maxIterations: config.termination?.maxIterations,
    maxRuntimeSeconds: config.termination?.maxRuntimeSeconds,
  };
  const permission = {
    default: headless ? ('allow' as const) : ('ask' as const),
    // E7：配置持久化的 always 规则 + 运行时始终免确认的 ask。
    // 老配置里可能仍写着旧工具名（表见 `src/legacy-tool-names.ts`，换算见
    // `normalizeLegacyToolName`），不换算就等于让用户当年选的「always」静默失效。
    autoApprove: [
      ...new Set([...(config.permission?.autoApprove ?? []).map(normalizeLegacyToolName), 'ask']),
    ],
    // 0.27：配置级保险；用户显式配置时以其值为准（与 autoApprove 语义一致，不合并默认）。
    neverAutoApprove: (
      config.permission?.neverAutoApprove ?? [
        'agent.close',
        // 0.52：PII 真值解锁**永远**要人批。默认放行会让 reveal 因为拿不到审批 id 而永久拒绝，
        // 反而把「用户明确同意」这条路堵死；显式列入强制审批名单后语义才正确。
        // 名字必须与注册表一致（0.55 起统一 snake_case `pii_reveal`，见
        // `packages/core/src/pii/reveal.ts` 的 `PII_REVEAL_TOOL_NAME`）。
        'pii_reveal',
      ]
    ).map(normalizeLegacyToolName),
  };

  // ── vessel 元工具（P1，单工具面）：结构化控制面桥 ─────────────────────
  // call_tool 经 vessel-bridge guardrail 改写成目标工具，鉴权落最终目标 + args（ADR-058 决策 2）；
  // rpc/set_config 由 vessel 自执行，方法级鉴权在 vessel.checkPermission（用户裁定 2026-11-18：
  // 不设第二执行器工具）。注册必须先于 wiring.startOwner()——main EU spawn 时快照父宿主
  // 工具列表（spawn 顺序不变式）。dispatcher 建在 agent 装配之后，晚绑定回填（与 feishuTeamId
  // 同口径）；local / serve 共用这一个 localDispatcher。
  let vesselRpcPort: VesselRpcPort | undefined;
  // O2：bridge_deny 活引用（缺省 [] = P1 行为零变化）；permission 热应用 applier 更新。
  const bridgeDenyRef = { current: normalizeBridgeDeny(config.permission?.bridgeDeny) };
  const vesselMeta = createVesselMetaSurface({
    getLocalRpc: () => vesselRpcPort,
    getBridgeDeny: () => bridgeDenyRef.current,
  });
  finalPluginHost.registerTool(vesselMeta.vessel);
  finalPluginHost.registerGuardrail(vesselMeta.bridgeGuardrail);

  // ── AgentService + REPL owner 端点（0.17 Phase A）──
  let agentControl: BootstrapResult['agent'];
  /**
   * 运行期通知总线（热应用 / 版本检查 / 成员停下共用）。
   *
   * 只有在 agent 装配（`finalPluginHost` 存在）时才建；CLI 的 serve 壳复用这个实例
   * （见 `BootstrapResult.notice`），不再自己建第二个总线。
   */
  let noticeBus: RuntimeNoticeBus | undefined;
  /** 成员停下通知的投递面（窗口合并 / 每轮一条 / 定向父 session）。 */
  let peerNotices: PeerNoticeRouter | undefined;
  /**
   * 图片 blob 池的 GC 定时器（0.56 P1）。缺省开：孤儿 blob 不清会一直占着 2 GiB 池，
   * 触顶之后新图不再内联（静默降级）。第一趟固定 dry-run（只报「将删 N / 共 M」）。
   */
  let imageBlobGc: ImageBlobGcRunner | undefined;
  /**
   * 0.53 notice-rotate：成员停下通知要按**投递那一刻**父成员当前的 session 定向，而
   * router 建在 `createAgentServiceWiring` 之前 —— 同样晚绑定（与 `feishuAgentService`
   * 同口径），闭包在 flush 时求值；装配前为 undefined 时通知退回报告时刻的 session。
   */
  let noticeAgentService: AgentService | undefined;
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
    // 0.19 S3：配置声明（camelCase → TeamDeclaration 的 snake_case）+ 默认 workspace。
    const teamDeclarations: TeamDeclaration[] = (config.teams ?? []).map((team) => ({
      ...(team.name !== undefined ? { name: team.name } : {}),
      workspace: team.workspace,
      ...(team.policy !== undefined ? { policy: team.policy } : {}),
    }));
    // 0.28 C3：打开目录即建 Team。声明命中优先；否则交互 / serve 入口用 agent.cwd，
    // 未配置时用 dataDir 派生的稳定锚点（不是各进程 cwd，TUI 与 gateway 的 node 子进程
    // 因此共用同一个默认 Team）。headless（`--run` / 管道）保持 undefined：
    // 一次性进程不该在数据目录里留空 Team。
    const defaultWorkspace =
      resolveDefaultTeamWorkspace(config, teamDeclarations, logger) ??
      (headless ? undefined : (resolveAgentCwd(config) ?? resolveDefaultTeamAnchor(dataDir)));
    // 0.27：发给人类的 send 直接写本机 Team 日志（异步委派，不阻塞 agent）。
    // Team 服务在 createAgentServiceWiring 之后才存在，这里用晚绑定 getter 回填。
    let localHuman: LocalHumanTarget | undefined;
    let localMember: LocalMemberTarget | undefined;
    // 0.21 S8.2：federation 缺省启用；显式 `federation.enabled: false` 才不注入。
    // 语义不只是「跨节点所以关掉就没」：本机人类投递也挂在这个端口上，关掉 federation
    // 等于连「agent 找本机人类」一起关掉。见下方 localHuman 的构造。
    const federation =
      config.federation?.enabled !== false
        ? createFederationSendPort({
            federation: config.federation ?? {},
            nodeId,
            // 展示名只用于把指向本机的 `to` 归一化，不参与向外的 from。
            nodeName,
            localHuman: () => localHuman,
            localMember: () => localMember,
          })
        : undefined;
    // 运行期通知总线（CONTRACT-hot-apply §3）：热应用 / 版本检查 / 成员停下共用同一条
    // 总线与同一个 BeforeLlm hook —— 两个总线会让两个 hook 争同一个注册名（后者被跳过）。
    // 建在这里而不是 serve 壳里：TUI 入口同样要看到成员停下通知，serve 复用这一个实例。
    noticeBus = createRuntimeNoticeBus({
      events: runtimeEvents,
      tenantId,
    });
    registerRuntimeNoticeHook(finalPluginHost, noticeBus, eventLog, config.envInjection);
    // 0.52：附件引用的环境信息行（模型据此知道有附件、该用 media 工具读）。
    // 0.56 P1：带上视觉面探针——有 `provider.vision` 且没被 kill switch 关时，尾注改说
    // 「图已随本条消息附上，不要再读」（避免模型把图再 media: read 一遍 = 双倍花费）。
    registerRefsNoticeHook(finalPluginHost, {
      vision: () => visionSurfaceOf({ config, backend: bundle.provider.vision }),
    });
    peerNotices = createPeerNoticeRouter({
      bus: noticeBus,
      events: runtimeEvents,
      logger,
      // 0.53 notice-rotate：变更上的 `parent_session_id` 是报告时刻父 body 的 session；
      // 合并窗口内父若 rotate，新 body 换了 session，这条 notice 就只落到旧 body 上。
      // 真正投递那一刻用这条链接重解析父成员**当前** primary body 的 session
      // （`AgentService.peerParentSessionOf` 内部即 `currentBindingSession`）。
      // 注意入参是**上报变更的成员（子）id**（`PeerStopChange.agent_id`），不是父 id。
      // 晚绑定：router 建在 wiring 之前，闭包在 flush 时才读。
      resolveParentSession: (memberId) => noticeAgentService?.peerParentSessionOf(memberId),
    });
    const wiring = await createAgentServiceWiring({
      // 来源行的 node 段与 federation 端口共用 nodeIdentity：federation 关掉时
      // 来源行仍要本机 node 段，不能只挂在 send port 上。
      nodeId,
      tenantId,
      dataDir,
      sessionId: currentSessionId,
      pluginHost: finalPluginHost,
      // Stage 4：成员 EU 经同一 Runtime 的 getOrCreateExecutionUnit 取得；
      // agentId 绑定保证同 session 不会被 tenant / 成员两条路径静默复用。
      runtime: executionRuntime,
      // 成员 run durable：RunRecord 与 tenant run 同一条 journal 写路径。
      ...(runStore !== undefined ? { runStore } : {}),
      model: agentPlan.model ?? providerModel,
      limits: agentPlan.limits ?? limits,
      termination: memberTermination,
      ...(agentPlan.readOnlyTools !== undefined ? { readOnlyTools: agentPlan.readOnlyTools } : {}),
      // 0.51：成员工具面 = 节点全量（只剩 deny 只读档与 bridge 两条闸），`ask` 不再由
      // 装配层点名放行。它的可用性现在完全由两条真实事实决定：父宿主真的注册了 `ask`
      // （按入口 + `ui.askUser` 决定），且这具身体能 bridge（`permissionMode: 'bridge'`
      // + 父事件流）；缺任何一条就不进工具面，而不是靠这里传一个名字。详见
      // `packages/agent/src/runtime.ts` 的 `toolBlocked`。
      ...(config.context?.maxTokens !== undefined
        ? { contextMaxTokens: config.context.maxTokens }
        : {}),
      ...(config.context?.compactThreshold !== undefined
        ? { contextCompactThreshold: config.context.compactThreshold }
        : {}),
      // 注入粒度框架：self-card hook 的检测节奏（缺省不传 ⇒ 内置默认表，零回归）。
      ...(config.envInjection !== undefined ? { envInjection: config.envInjection } : {}),
      permission,
      permissionMode: memberPermissionMode,
      // 0.31：按**入口是否真有进程内应答者**判定，而不是 `!headless`：feishu 非 TTY
      // （headless=false）既没有 TUI 也没有 gateway 权限卡片，用 !headless 会让
      // rotate 请求永远等不到人。0.33 起 headless 注册 ask 但不等于有应答者，
      // 所以这里用 interactiveHumanAvailable（排除 headless）。
      humanApproval: interactiveHumanAvailable,
      // 成员 bridge 请求 / 应答与 TUI 订阅的是同一条父事件流。
      parentEvents: runtimeEvents,
      // 0.27（spec §5.1）：每 tenant 唯一 scheduler，由 tenant bundle 构造。
      scheduler: bundle.scheduler,
      ...(config.agent?.ownerId !== undefined ? { ownerId: config.agent.ownerId } : {}),
      // 成员停下 / 被关闭 → 定向到父 session 的一条 runtime.notice（scope peer）。
      ...(peerNotices !== undefined ? { peerStops: peerNotices.report } : {}),
      // tools-engine P2 批次 3：inbox 逐 body 接线（原闭包含 agentId，callback 经 pending
      // 关联执行，成员身份不由 engine 提供）。spawn / 热刷新都经 inboxTool() 触发；喂账本
      // 幂等全量（指纹不变 engine 侧 no-op），失败只记日志。
      wireInboxTool: (tool) => {
        engineClient.wireTool(tool, callbackRoute('inbox'));
        void engineClient.pushRegistry().catch((error: unknown) => {
          logger.warn('tools-engine registry push failed (inbox)', {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      },
      logger,
      // 成员 ExecutionUnit 与父级共用 tenant 存储：同 session_id 可在新进程恢复历史。
      session,
      ...(eventLog !== undefined ? { eventLog } : {}),
      ...(bundle.leaseService !== undefined ? { leaseService: bundle.leaseService } : {}),
      // 0.56（决策 2：上传即落）：引用到达节点的第一刻就算 sha256 + 落 blob。
      // 边界从活的 basic-tools 配置来（与 `attachments.list` 同一份判定）。
      attachIngest: createConfigAttachmentIngest({ getConfig: () => config }),
      ...(bundle.summarizer !== undefined ? { summarizer: bundle.summarizer } : {}),
      ...(bundle.summarizerForSession !== undefined
        ? { summarizerForSession: bundle.summarizerForSession }
        : {}),
      teamDeclarations,
      ...(defaultWorkspace !== undefined ? { defaultWorkspace } : {}),
      ...(federation !== undefined ? { federation } : {}),
      ...(config.agent?.temporaryTtlHours !== undefined
        ? { temporaryTtlHours: config.agent.temporaryTtlHours }
        : {}),
      ...(config.agent?.inboxMaxMessages !== undefined
        ? { inboxMaxMessages: config.agent.inboxMaxMessages }
        : {}),
      // CREATE-0.39 §2.5：seeded create 的失败清理走 core 的 session-data 删除路径
      // （先 detach 再删 event log / SessionState / RunRecord）。
      deleteSessionData: async (sessionId: string) => {
        await sessionControl.delete(sessionId);
      },
    });
    // 0.27：回填本机投递端口（federation 端口的 getter 在此之后才读得到）。
    // 0.57：`agent` 段（1s 级）拆开记账：装配（TeamStore / AgentService）与派生 `main`
    // 是两件不同的事，谁的代价大要能直接读出来。
    markStartup('agent.wiring');
    localHuman = createTeamHumanDelivery(wiring.team);
    localMember = createTeamLocalMemberDelivery(wiring.team);
    // 0.28 F2：回填飞书成员复活用的 Team（默认 workspace 的 Team；缺省不复活）。
    feishuTeamId = wiring.defaultTeam?.team_id;
    // 0.28：回填渠道执行面（渠道 `start()` 时才读取；此处不提前构造 / 不改变次序）。
    feishuAgentService = wiring.service;
    // 0.53 notice-rotate：回填通知的重解析口（router 早在上面就建好了，flush 时才读）。
    noticeAgentService = wiring.service;
    registerBashJobDelivery({ service: wiring.service, logger });
    logger.debug('agent.bash_job.delivery_ready', {});
    finalPluginHost.registerTool(wiring.tool);
    // tools-engine P2 批次 3：agent 恒 callback（Team 注册表 / body spawn / SessionStore
    // 状态留 host；内部端点 = 原 handler 闭包）。注册后立即接线，先于 startOwner（spawn
    // 顺序不变式）；喂账本失败只记日志（engine disabled → fail-closed）。
    engineClient.wireTool(wiring.tool, callbackRoute('agent'));
    try {
      await engineClient.pushRegistry();
    } catch (error) {
      logger.warn('tools-engine registry push failed (agent)', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    // 0.55：装配收尾的工具名闸（`agent` 工具是插件装完之后才注册的，所以要在这一句之后）。
    // 内置 / 插件工具名不合规 ⇒ 启动失败并列出全部违规项；外部（MCP）工具名只记 warning。
    for (const warning of assertToolNameLegality(finalPluginHost, 'bootstrap.final').warnings) {
      logger.warn('external tool name is not snake_case; passed through as-is', {
        tool_name: warning.name,
        suggestion: warning.suggestion,
      });
    }
    // 顺序契约：`main` 的 ExecutionUnit 在 spawn 时快照父宿主工具列表，
    // 必须等 `agent` 工具注册完再派生 owner，否则 main 永久缺 `agent`。
    const owner = await wiring.startOwner();
    markStartup('agent.owner');

    // 0.53：**启动即扫**。gateway / 本地 dispatcher 开始收 RPC 之前，把「进程死亡时还没
    // 变成 run input 的 human 输入」重新投递一次（判据、幂等、上限 8 会话见
    // `AgentService.recoverPendingInputs`：unread + 未 held + 有 session_id + human 源）。
    // 放在 `startOwner()` 之后：成员 EU spawn 时快照父宿主工具列表，恢复出来的 run 要用同一批。
    // headless（`--run` / 管道）是一次性进程：不替别的会话恢复队列，退出时会留半截 run。
    //
    // 0.52 S1c：顺序改成「先发卡、再重放、准入后清标记」——
    // 1) 读 `resume_after_restart` 标记（落盘 SessionState 是唯一权威）；
    // 2) 每个带标记的会话发一张「重启恢复」环境信息卡：一次 `runtime.notice`，
    //    由环境信息通道在下一次请求的用户输入之前注入 ⇒ 同一份文本既进模型上下文，
    //    也在聊天流里渲染成 EnvCard（用户裁定：不是隐藏输入，两边可见一致）；
    // 3) 卡之后才调既有的 `recoverPendingInputs()` 重放**已接受**的输入（最早 ts FIFO）；
    // 4) 卡片落成消息且随请求进了模型上下文之后才清标记（清标记走 RunJournal 单写口）。
    // 任何一步失败都不阻断启动：标记与 unread 条目都还在，下次启动再判（幂等）。
    if (!headless) {
      try {
        if (eventLog === undefined) {
          // memory 后端 / 只读执行面没有事件日志：拿不到「卡发过没、准入没」的证据，
          // 不另造一套状态 —— 退回 0.53 的队列重放（不发卡）。
          const recovered = await wiring.service.recoverPendingInputs();
          if (recovered.recovered > 0 || recovered.deferred > 0 || recovered.failed > 0) {
            logger.info('agent.inbox.recover_done', { ...recovered });
          }
        } else {
          const restarted = createNodeResumer({
            session,
            eventLog,
            announce: (sessionId, text) => wiring.service.announceEnvironmentCard(sessionId, text),
            // 清标记：只清「还是同一份标记」的那一个；拷贝里去掉该字段，
            // 落盘仍走 RunJournal（`saveSessionState` 是 SessionState 的唯一写口）。
            clearMarker: async (sessionId, marker) => {
              const state = await session.load(sessionId);
              if (state === null) return false;
              if (!sameRestartMarker(state.resume_after_restart, marker)) return false;
              const { resume_after_restart: _cleared, ...rest } = state;
              const journal = journalFactory.transient({
                runId: 'manual',
                events: runtimeEvents,
                sessionId,
              });
              await journal.saveSessionState(rest);
              return true;
            },
            replay: async () => {
              const recovered = await wiring.service.recoverPendingInputs();
              return { recovered: recovered.recovered, sessions: recovered.sessions };
            },
            // P0-run-stops P3 僵尸标记判据的另一半：会话已完成。与 announce 的
            // `no_member` 原因联合成立时，node-resume 经 clearMarker（单写口）清掉
            // 永远不可能准入的标记（headless CLI 会话遗留），不再只增不减。
            unrecoverable: async (sessionId) => {
              const state = await session.load(sessionId);
              return state !== null && state.status === 'completed';
            },
            warn: (event, meta) => logger.warn(event, meta),
          });
          const report = await restarted.beginResume();
          markStartup('agent.resume');
          if (report.marked > 0 || report.replayed_inputs > 0) {
            logger.info('agent.resume.recover_done', {
              marked: report.marked,
              announced: report.announced,
              deduped: report.deduped,
              skipped: report.skipped,
              replayed_inputs: report.replayed_inputs,
              replayed_sessions: report.replayed_sessions,
              // P0-run-stops P4：per-session skip 原因聚合（只扩日志内容）——
              // skipped=9 这种读数必须能直接看出「为什么」，不用回去翻代码。
              ...(report.skipped > 0
                ? {
                    skipped_sessions: report.marks
                      .filter((mark) => mark.card === 'skipped')
                      .map((mark) => ({
                        session_id: mark.session_id,
                        reason: mark.skip_reason ?? 'unknown',
                      })),
                  }
                : {}),
            });
          }
          // 准入是异步的（要等下一轮请求真的发出）：不阻塞启动，只在后台收尾清标记。
          void restarted.whenSettled().then((final) => {
            if (final.cleared.length > 0 || final.settle === 'timeout') {
              logger.info('agent.resume.settle_done', {
                cleared: final.cleared,
                settle: final.settle,
                marked: final.marked,
              });
            }
          });
        }
      } catch (error) {
        // 恢复失败不阻断启动：条目仍是 unread，标记仍落盘，下次启动再试。
        logger.warn('agent.inbox.recover_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // S5：hub 目录投影（node → hub 出站快照）。
    const hubRuntime = await createHubRuntime({
      service: wiring.service,
      // S6：真实 TeamService 作为 hub 指针源（只带 team_id / kind / message_id）。
      teamSource: wiring.team,
      nodeName,
      logger,
    });

    // owner 端点与 gateway 共用同一 canonical 控制面适配器。
    // CREATE-0.39 §2.1：mode=both 的 git restore 需要 agent 所属 Team 的 workspace。
    const agentControlLike = createAgentControl(wiring.service, tenantId, {
      resolveWorkspace: async (agentId: string) => {
        const status = await wiring.service.identify(agentId);
        const teamId = status?.team_id;
        return teamId === undefined ? undefined : wiring.teamStore.get(teamId)?.workspace;
      },
    });
    // 0.34 Stage 3：CLI / TUI / gateway 的所有 delete 入口共用同一个前置钩子。
    sessionControl.setDetachSession((sessionId) => wiring.service.detachSession(sessionId));
    let ownerServer: AgentOwnerServer | undefined;
    // owner 端点只服务交互 REPL / serve 的 CLI attach；headless（`--run` / 管道）
    // 是一次性进程，不监听端口。AgentService / Team 仍在进程内可用。
    if (!headless) {
      try {
        ownerServer = await startAgentOwnerServer({
          control: agentControlLike,
          sessionFor: () => session,
          teams: wiring.team,
          ownerId: wiring.ownerId,
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
    }

    agentControl = {
      service: wiring.service,
      team: wiring.team,
      owner,
      ownerId: wiring.ownerId,
      ...(ownerServer !== undefined ? { ownerServer } : {}),
      hubControl: hubRuntime.hubControl,
      control: agentControlLike,
      applyDefaultModel: wiring.applyDefaultModel,
      dispose: async () => {
        await ownerServer?.stop();
        // 回收定时器必须先停：否则 drain 期间 sweep 仍可能回收正要收口的 agent。
        wiring.stopSweep();
        // 成员轮必须在 tenant eventLog 关闭前收口：否则尾部事件 append 会被
        // `session_event_log_closed` 拒绝，子会话审计缺尾。
        await wiring.service.drain({ timeoutMs: 5000 });
        // Team 退订后再 flush 日志写链，避免关闭期间又追加系统消息。
        wiring.team.dispose();
        await wiring.teamStore.flush();
        await wiring.conversationStore?.flush();
        await wiring.service.flushSnapshot();
      },
    };
  }

  // ── Durable resume（0.3）─────────────────────────
  // 恢复只走 tenant runtime 的 `ExecutionUnit.resumeRun`（不注入合成消息）。
  const startResume = async (
    runId: string,
    opts?: RunOptions,
  ): Promise<DurableRunHandleLike & { mode: 'single-agent' }> => {
    if (!runStore) {
      throw resumeError('durable_disabled', runId, 'durable.enabled is false');
    }

    const checkpoint = await loadResumableCheckpoint(runStore, runId);
    // 0.15: one writer per run across processes.
    const runLock = await acquireSessionLock({
      tenantDir: tenantPaths.root,
      kind: 'run',
      id: runId,
      ...(options.clock ? { now: options.clock } : {}),
    });

    // 0.33 A：headless ask 的回答在 resume 前以 `user.message` 事件注入历史。
    // 走既有 projection 路径（见 ask-channel），不改 core resume 契约；重复 resume
    // 由 `source + request_id` 去重。
    const interactionsDir = resolveInteractionsDir(dataDir);
    try {
      const delivered = await deliverAnsweredAsksToSession({
        ...(eventLog !== undefined ? { eventLog } : {}),
        dir: interactionsDir,
        tenantId,
        runId,
        sessionId: checkpoint.session_id,
      });
      if (delivered > 0) {
        logger.info('ask.resume.answers_delivered', { run_id: runId, count: delivered });
      }
    } catch (error) {
      logger.warn('ask.resume.deliver_failed', {
        run_id: runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const controller = new AbortController();
    // 调用方的 signal（headless ask 挂起用 abort('timeout')）桥接到内部 controller；
    // 原先直接覆盖会丢掉外部中断，导致 resume 无法从 headless 收口。
    const externalSignal = opts?.signal;
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
      else {
        externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), {
          once: true,
        });
      }
    }
    const resumeOptions = { ...opts, signal: controller.signal };
    // Stage 4：成员 run 有 agent_id，回到 AgentService（scheduler 串行 / active run
    // 记账 / lease 续租都复用）；tenant run 直接按 session 取 EU 恢复。不新增 RPC。
    const memberService = agentControl?.service;
    const promise =
      checkpoint.agent_id !== undefined && memberService !== undefined
        ? memberService.resumeRun(runId, resumeOptions)
        : // tenant run：走 bundle 的 per-session 门面，复用 owner Self Card / context
          // 覆盖与 run 级文件锁（startResume 已持有一次，session-lock 引用计数消化）。
          typeof bundle.runtime.resumeRun === 'function'
          ? bundle.runtime.resumeRun(runId, resumeOptions)
          : Promise.reject(
              resumeError('resume_unavailable', runId, 'runtime does not support resumeRun'),
            );
    const done = promise
      .then(
        (message) => ({ status: 'completed' as const, message }),
        (error) =>
          controller.signal.aborted
            ? { status: 'cancelled' as const }
            : { status: 'failed' as const, error },
      )
      .then(async (outcome) => {
        // run 真正收口后，遗留的 pending ask 不再可回答。
        // `timeout` 是 headless ask 挂起（checkpoint interrupted），必须保留。
        const suspended = controller.signal.aborted && controller.signal.reason === 'timeout';
        if (!suspended && (outcome.status === 'completed' || outcome.status === 'cancelled')) {
          try {
            const orphaned = await orphanPendingAsksForRun({
              dir: interactionsDir,
              tenantId,
              runId,
            });
            if (orphaned > 0) {
              logger.info('ask.resume.orphaned', { run_id: runId, count: orphaned });
            }
          } catch (error) {
            logger.warn('ask.resume.orphan_failed', {
              run_id: runId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return outcome;
      })
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
    stream: runtimeEvents,
    // 0.18：live 与 trace 同源（bundle.redactor 已是 core+ext 组合实例）。
    redactor: bundle.redactor,
  });
  // 0.28 C3：本地 `runs.*` 控制面（与 dispatcher / TUI 适配器共用同一实例）。
  // agent 未启用时缺省 undefined，`runs.start` 保持既有 forbidden 语义。
  const localRunControl =
    agentControl !== undefined
      ? createRunControl(agentControl.service, bundle.scheduler, tenantId)
      : undefined;

  // 0.43：本地 REPL / local run 与 gateway 共用同一体验型 plugin 宿主
  //（懒激活 + onStartup 预激活；关闭时显式 stopAll）。
  const localPluginHostManager = createPluginHostManager({
    loader: bundle.pluginLoader,
    config,
    dataDir,
    logger,
  });
  await activateStartupPlugins(localPluginHostManager, {
    loader: bundle.pluginLoader,
    config,
    tenantId,
    logger,
  });
  // P1-w2d（D3）：install 后登记 in-process 能力插件的 RPC / 贡献面（w1a 接缝）；
  // 返回的基础行并入下方 plugins 数据源（provider 类不在 bundle.plugins 里）。
  const inProcessPluginRows = bundle.registerInProcessPlugins(localPluginHostManager, config);
  const reloadLocalPlugins = createPluginReloader({
    loader: bundle.pluginLoader,
    manager: localPluginHostManager,
    getConfig: () => config,
  });
  // 0.43 E3：本地模式同样监听项目/用户插件目录与 config，变更即 rescan + reload。
  const localPluginWatch = startPluginWatch({
    onChange: ({ paths }) => {
      void reloadLocalPlugins().catch((error) => {
        logger.warn('plugin.reload.failed', {
          error: error instanceof Error ? error.message : String(error),
          paths,
        });
      });
    },
  });

  const localDispatcher: LocalRpcDispatcher = createLocalRpcDispatcher({
    hub: localEventHub,
    session,
    // 会话级上下文用量（additive `sessions.get.context_usage`）：从**时间线**尾窗派生
    // （历史会话 / rotate 后 / 重启后都可用）。`contextWindowTokens` 与 runtime 算百分比的
    // 分母同源（`config.context.maxTokens`，缺省走 DEFAULT_CONFIG）。
    //
    // 0.54 stop-write：读源是 `bundle.timelineLog`（只读口，没有 append）——
    // `events.ndjson` 已停写，装配层也不再拼那条路径去 `stat`。
    ...(timelineLog !== undefined
      ? {
          contextUsage: createContextUsageSource({
            tail: timelineLog,
            watermark: (sessionId: string) => timelineLog.watermark(sessionId),
            ...(config.context?.maxTokens !== undefined
              ? { contextWindowTokens: config.context.maxTokens }
              : {}),
          }),
          // 「模型这一轮看到了什么系统消息」（additive `sessions.get.system_context`）：
          // 同一个读口，取的是另一类事件（`prompt.system_context`）。
          // 事件不是 message ⇒ 回放窗口淘汰 / 进程重启后只有重新派生才能把卡找回来。
          systemContext: createSystemContextSource({
            tail: timelineLog,
            watermark: (sessionId: string) => timelineLog.watermark(sessionId),
          }),
          // 每张图的投递状态（additive `sessions.get.session.messages[].image_delivery`，0.56）：
          // 同一个读口，取的是另一类事件（`image.sent` / `context.image_dropped`）。
          // 从事件派生而不是写进 refs —— 后者会改写历史前缀且被 messageSignature 无视。
          imageDelivery: createImageDeliverySource({
            log: timelineLog,
            watermark: (sessionId: string) => timelineLog.watermark(sessionId),
          }),
          // `sessions.events` 回填 + `sessions.get.event_cursor`：与上面两个同一个读口，
          // serve 只做游标/分页。
          sessionEvents: createSessionEventsSource({
            log: timelineLog,
            watermark: (sessionId: string) => timelineLog.watermark(sessionId),
          }),
        }
      : {}),
    // 0.54 A：timeline 四字段（additive `sessions.get.event_cursor` 的 `timeline_head` /
    // `wal_head` / `published_head` / `holes` / `tainted`）。双写开关关 / 该会话没有
    // timeline ⇒ 一起缺省。
    ...(bundle.timelineDualWrite !== undefined
      ? {
          timelineHeads: {
            lookup: (sessionId: string) =>
              bundle.timelineDualWrite?.heads(sessionId) ?? Promise.resolve(undefined),
          },
          // 0.54 B1：时间线 epoch 的两个端口。`readPage` 是历史页，`timelineTail` 是
          // 发布点实时尾随（`pub-i2` 的 `onPublish` 扇出；serve 按连接的 session_id 过滤）。
          timelineRead: {
            readPage: (
              sessionId: string,
              options: { afterSeq: number; untilSeq?: number; limit?: number },
            ) => bundle.timelineDualWrite?.readPage(sessionId, options) ?? Promise.resolve([]),
          },
          timelineTail: timelineTailPort(bundle.timelineDualWrite),
        }
      : {}),
    pluginHostManager: localPluginHostManager,
    pluginsReload: reloadLocalPlugins,
    // 0.15: local RPC runs also take the session write lock.
    runtime: bundle.runtime,
    context,
    pluginHost: finalPluginHost,
    ...(localAuth.ok ? { auth: localAuth.auth } : {}),
    version: readPackageVersion(),
    nodeId,
    nodeName,
    defaultTenantId: tenantId,
    config: {
      snapshot: async (): Promise<ConfigSnapshotLike> =>
        buildConfigSnapshot({
          config: sanitizeConfigForSnapshot(config),
          sources: loaded.sources,
          paths: loaded.paths,
          tenantId,
        }) as unknown as ConfigSnapshotLike,
    },
    plugins: () => {
      const listed = plugins.map((plugin) => ({ name: plugin.name, enabled: true }));
      // P1-w2d：已登记 in-process 能力插件补基础行（契约 §1），按 name 去重。
      const seen = new Set(listed.map((plugin) => plugin.name));
      for (const row of inProcessPluginRows) {
        if (!seen.has(row.name)) {
          listed.push(row);
          seen.add(row.name);
        }
      }
      return listed;
    },
    ...(metrics ? { metrics: () => metrics.snapshot() } : {}),
    metricsControl: {
      ...(typeof (metrics as unknown as { reset?: unknown })?.reset === 'function'
        ? { reset: () => (metrics as unknown as { reset: () => void }).reset() }
        : {}),
      rebuild: () => rebuildMetrics(tenantPaths.events_dir),
    },
    // 0.54 C：`events.list` 换源到时间线（`seq` = `timeline_seq`）。旧的
    // `readEvents: (filter) => readTraceEvents(events_dir, filter)` 已删除：那条路读
    // `data/events/<run_id>.jsonl` 的 per-run 序号，与登记在 CHANGELOG 的新语义同名不同义。
    // timeline 的 run 索引是**会话内**的，所以 run → session 的解析也在端口实现里。
    timelineRunEvents: createTimelineRunEventsPort({
      sessionsDir: tenantPaths.sessions_dir,
      // 快路径：durable 打开的安装能从 RunRecord 一次读到 `session_id`。
      ...(bundle.runStore !== undefined
        ? {
            resolveSession: async (runId: string) => {
              const record = await bundle.runStore?.load(runId);
              return record?.session_id;
            },
          }
        : {}),
    }),
    trace: {
      prune: (params: Record<string, unknown>) => {
        const pruneOptions = {
          ...(typeof params.older_than_days === 'number'
            ? { retentionDays: params.older_than_days }
            : {}),
          ...(typeof params.max_runs === 'number' ? { maxRuns: params.max_runs } : {}),
          ...(typeof params.max_bytes === 'number' ? { maxBytes: params.max_bytes } : {}),
        };
        // 0.49 T5：data-dir 写意图锁（中性命名）；同进程重复加锁由 withDataLock 识别。
        return withDataLock({ dataDir: tenantPaths.root }, () =>
          pruneTrace(tenantPaths.events_dir, pruneOptions),
        );
      },
    },
    sessionData: {
      deleteSessionData: (sessionId: string) =>
        withDataLock({ dataDir: tenantPaths.root }, async () => {
          // 0.34 Stage 3：sessionControl.delete 内部先 detach；冲突（active run /
          // 活 SessionLease）直接抛 `conflict`，不做任何删除。
          return sessionControl.delete(sessionId);
        }),
    },
    redactor: bundle.redactor,
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
    // 0.28 C3：本地裸跑与 `--serve` 共用同一套方法表——`agents.*` / `teams.*` /
    // `runs.*` 必须注入同一批控制面，否则 TUI 里 `agents.create` 返回 not_found、
    // `runs.start` 返回 forbidden。三者在 agent 未启用时保持缺省（方法进 manifest，
    // handler 按既有语义报错），不新增实体。
    ...(agentControl !== undefined
      ? { agent: agentControl.control, teams: agentControl.team, runControl: localRunControl }
      : {}),
    // 0.52：async ask 的答案投放（本地 REPL / 本地 dispatcher 也要能起那一次新 run）。
    // 与 `--serve` 同一份实现：答案作为 user 消息进成员 inbox 并起新 run。
    ...(agentControl !== undefined
      ? { askAnswerDelivery: createAskAnswerDelivery(agentControl.service) }
      : {}),
    // 0.52：attachments.list 的列举器（节点侧只读目录浏览）。与读文件工具同一份
    // basic-tools 配置（allowed_roots / deny_paths）—— 面板列出来的路径必须与读侧判定同源。
    listAttachments: createConfigAttachmentLister({ getConfig: () => config }),
  });
  // vessel 元工具的 RPC 端口回填：与 gateway 同一方法表 / 同一权限语义（本地 principal）。
  vesselRpcPort = localDispatcher;
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

  // ── 0.52 S1a：node 退出序列第一段 ───────────────────────────────
  //   1) fence 准入（runs.start 立刻 gateway_restarting / agents.* 只进 inbox 并返 queued）
  //   2) 只给「有在跑 run 的会话」写 resume 标记（走 RunJournal 单写口）
  //   3) interrupt('shutdown')
  //   4) ≤2s settle
  //   5) flush 会话状态（半截回复也要落地）
  // 幂等：SIGTERM 连发 / vessel node stop 与 shutdown() 同时触发都只做一次。
  // 必须在 gateway.stop() 之前跑（否则 run 已被打断，快照为空 ⇒ 一条标记都写不出来），
  // 所以它挂在 BootstrapResult.beginDrain 上，由 CLI 的退出路径先调。
  const nodeDrainer = createNodeDrainer({
    units: () => executionRuntime.listExecutionUnits(),
    // P0-run-stops P3：headless 一次性进程不打 resume 标记——它的会话没有 agent
    // 绑定，标记永远收不了卡、清不掉，只会累积成僵尸（与启动侧「headless 不替
    // 别的会话恢复」对称）。interrupt / settle / flush 照旧。
    armMarkers: !headless,
    // 没有 AgentService（agent 关闭 / 极简入口）就没有 agent→agent 投递要排队：
    // 空 Map + beginFence 返回 false（fence 由 runs.start 闸门之后的调用方兜底判断）。
    pendingInboxIdsBySession: () => agentControl?.service.pendingInboxIdsBySession() ?? new Map(),
    // 竞态保护：settle 期间被打断 run 的终态保存会重建会话状态，注册表让它别把标记冲掉。
    armResumeMarker: (sessionId, marker) => {
      bundle.resumeMarkers.arm(sessionId, marker);
    },
    beginFence: () => agentControl?.service.beginDrain() ?? false,
    warn: (message, fields) => {
      logger.warn(message, fields);
    },
  });

  /** 0.52 S1a：执行 node 退出序列（幂等，可在任何退出路径上重复调用）。 */
  const beginDrain = async (): Promise<void> => {
    try {
      const report = await nodeDrainer.beginDrain('shutdown');
      logger.info('node.drain.done', {
        marks: report.marks.length,
        persisted: report.marks.filter((mark) => mark.persisted).length,
        interrupted: report.interrupted,
        settle: report.settle,
        duration_ms: report.duration_ms,
        already_draining: report.already_draining,
      });
    } catch (error) {
      // 退出序列失败不阻断退出：run 本来就要没了，只是少了标记。
      logger.warn('node.drain.failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // ── 关闭 ────────────────────────────────────────
  let shuttingDown = false;

  const shutdown = async (shutdownOptions: { drain?: boolean } = {}): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // 0.52 S1a：退出序列第一段（幂等）。serve 壳在 gateway.stop() 之前已经调过一次；
    // 这里兜住「直接 shutdown() 的路径」——REPL 的 onExit、cleanup、uncaught 收尾。
    await beginDrain();

    try {
      unsubPermissionPersist?.();
    } catch {
      // 退订是 best-effort
    }
    unsubPermissionPersist = undefined;

    // 成员停下通知：先停路由器（清窗口定时器 + 退订 run.* 事件），再拆执行面。
    try {
      peerNotices?.stop();
    } catch {
      // 退订 / 清定时器是 best-effort
    }
    peerNotices = undefined;
    // 0.56 P1：blob GC 定时器（在飞的那一趟照旧跑完，不阻塞退出）。
    imageBlobGc?.stop();
    imageBlobGc = undefined;
    // 0.53 notice-rotate：重解析口的宿主一并摘掉（router 已停，flush 不会再发生）。
    noticeAgentService = undefined;

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
      localPluginWatch.close();
    } catch {
      // watcher 关闭失败不阻断关停。
    }

    try {
      await localPluginHostManager.stopAll();
    } catch (error) {
      reportShutdownFailure({
        events: bundle.events,
        logger,
        step: 'plugin.stopAll',
        error,
        tenantId,
      });
    }

    // tools-engine P2：expectedExit 停 engine child（不触发重启）+ 清 pending 关联。
    // run 已在 beginDrain 打断，在途转发经 abort → tool.cancel 收口。
    try {
      await engineSupervisor.stop();
      engineClient.dispose();
    } catch (error) {
      reportShutdownFailure({
        events: bundle.events,
        logger,
        step: 'tools-engine.stop',
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

    // bundle 关闭顺序：feishu → metrics → MCP → runtime
    // → trace → runStore → session；session 写锁由 bootstrap 在最后释放。
    await bundle.close(shutdownOptions);

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
  };

  // ── 本地 TUI 的执行适配器（0.28 C3 / D10 / D12）─────────
  // 本地裸跑不能直连 `bundle.runtime`：那条路径绕过 `admit`，每个会话都用到
  // tenant 共享的运行时，C4 的 role 感知策略对它无效（PLAN §12.3）。
  // 适配器把执行转成 `runs.start → admit`，并把 `ctx.context` 换成当前 body 的镜像。
  const localRun =
    agentControl !== undefined && localRunControl !== undefined
      ? createLocalRunAdapter({
          events: runtimeEvents,
          pluginHost: finalPluginHost,
          runControl: localRunControl,
          agentControl: agentControl.control,
          session,
          // 0.34 S2 / C5：TUI mirror 与 tenant 上下文同源（阈值 / 预算 / 自动压缩）。
          contextConfig: config.context,
          // C6：`/compact` 走 tenant 执行门面 → 已存在的 EU；RunnableAgent 类型
          // 不暴露该可选方法，按结构读取（门面 / 写锁包装都以结构透传）。
          compactContext: (sessionId) => {
            const runtime = bundle.runtime as RunnableAgent & {
              compactContext?(
                id: string,
              ): Promise<{ removed: number; remaining: number; messages?: Message[] }>;
            };
            if (typeof runtime.compactContext !== 'function') {
              return Promise.reject(new Error('compact_unavailable'));
            }
            return runtime.compactContext(sessionId);
          },
        })
      : undefined;

  // ── ReplContext ─────────────────────────────────
  // 工具/插件的唯一来源是同一个 PluginHost（插件在 install() 里注册）。
  const baseRuntime: RunnableAgent = localRun?.runtime ?? bundle.runtime;
  // Q5：显式 `-r/--resume <id>` 的首轮走 resumeSession；connect 模式不走这里。
  const resumableRuntime =
    options.resumeSessionId !== undefined
      ? withFirstRunResume(baseRuntime, options.resumeSessionId)
      : baseRuntime;
  const ctx: ReplContextWithPermissions = {
    runtime: resumableRuntime,
    pluginHost: finalPluginHost,
    session,
    events: runtimeEvents,
    context: localRun?.context ?? context,
    currentSessionId,
    onSessionChange: (id) => {
      currentSessionId = id;
      // D12：切会话（/new、/resume、/runs resume）后把镜像指向该会话。
      void localRun?.runtime.focusSession(id);
    },
    provider: { name: providerName, model: providerModel, baseUrl: providerBaseUrl },
    plugins: plugins.map((p) => p.name),
    rpc: localRpcClient,
    tenant: { data_dir: tenantPaths.root },
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

  // REPL / serve / node：prune 在 bootstrap 返回后由 timer 执行，启动不等它（S4 D2）。
  // `unref()`：清理任务不该把进程挂住（headless 仍然走上面的 await，语义不变）。
  if (pruneAfterFirstFrame) {
    const timer = setTimeout(() => {
      void pruneTraceBestEffort();
    }, 0);
    (timer as { unref?: () => void }).unref?.();
  }

  // ── 0.56 P1：图片 blob 池 GC（第一趟 dry-run，之后定时真删）────────────────────
  // 三条纪律：① 引用集合扫「会话壳 + 事件日志」两处（漏一处 = 删在用图）；
  // ② 证明不了引用集合就整趟放弃（`aborted`，一个字节都不删）；
  // ③ 超上限**不静默**（warn + 事件 + 一张通知卡）。
  const blobGcEnabled = config.vision?.blobGcEnabled !== false;
  // 安全闸：blob 池必须落在**这个数据目录**里。`VESSEL_BLOB_DIR` 可以把池指到别处
  // （多节点 / 多租户共享一份池），而引用集合只能扫到本目录的会话 —— 那时删任何东西
  // 都是「删别人还在用的图」。宁可不做（漏水），也不猜。
  const blobPoolRoot = imageBlobRoot();
  const blobPoolInside = isBlobRootInsideDataDir(tenantPaths.root, blobPoolRoot);
  if (blobGcEnabled && localWrites && timelineLog !== undefined && !blobPoolInside) {
    logger.warn('image blob gc skipped: blob root outside data dir', {
      data_dir: tenantPaths.root,
      blob_root: blobPoolRoot,
    });
  }
  if (blobGcEnabled && localWrites && timelineLog !== undefined && blobPoolInside) {
    const gcLog = timelineLog;
    imageBlobGc = startImageBlobGc({
      sessionsDir: tenantPaths.sessions_dir,
      log: { read: (sessionId: string) => gcLog.read(sessionId) },
      root: blobPoolRoot,
      ...(config.vision?.orphanGraceHours !== undefined
        ? { orphanGraceHours: config.vision.orphanGraceHours }
        : {}),
      ...(config.vision?.imageBlobTtlDays !== undefined
        ? { ttlDays: config.vision.imageBlobTtlDays }
        : {}),
      ...(config.vision?.blobGcIntervalHours !== undefined
        ? { intervalHours: config.vision.blobGcIntervalHours }
        : {}),
      ...(config.vision?.blobGcDryRun === true ? { dryRun: true } : {}),
      onUnreadable: (sessionId: string, error: unknown) => {
        // 旧格式会话（0.54 之前）没有 blob 池，读不出来是可声明的；**不是静默**。
        logger.warn('image blob gc: session events unreadable', {
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      onReport: (report) => {
        const line = formatImageBlobGcReport(report);
        if (report.aborted !== undefined) {
          logger.warn('image blob gc aborted', {
            reason: report.aborted.reason,
            scanned: report.scanned,
          });
          return;
        }
        logger.info('image blob gc pass', { line, scanned: report.scanned });
        // 报告进事件流：人（Web/TUI）能看到「将删 / 已删」，不必翻日志。
        runtimeEvents.publish({
          type: 'gc.image_blobs',
          run_id: 'gc',
          data: { line, dry_run: report.dryRun, scanned: report.scanned, result: report.result },
          ts: Date.now(),
        });
        if (report.result?.overLimit === true) {
          const summary = `Image pool over limit (${report.result.totalBytes} bytes): new images will not be inlined`;
          console.warn(`⚠ ${summary}`);
          noticeBus?.publish({
            scope: 'config',
            summary,
            details: [line],
            ok: false,
          });
        }
      },
    });
  }

  return {
    runtime: resumableRuntime,
    executionRuntime,
    ctx,
    config,
    tenantId,
    tenantPaths,
    bundle,
    toolsEngine: { client: engineClient, supervisor: engineSupervisor, bridgeDeny: bridgeDenyRef },
    ...(agentControl !== undefined ? { agent: agentControl } : {}),
    // 运行期通知总线：serve 壳复用它（配置热应用 / 版本检查 / 成员停下同一条通路）。
    ...(noticeBus !== undefined ? { notice: noticeBus } : {}),
    ...(trace ? { trace } : {}),
    sessionControl,
    nodeId,
    nodeName,
    mcp: mcpControl,
    runStore,
    runs,
    feishu: feishuChannel,
    metrics,
    resumeRun,
    shutdown,
    beginDrain,
    cleanup: () => {
      void shutdown();
    },
  };
}
