/**
 * bootstrap 纯类型面（P1 批 1 纯移动，自 bootstrap.ts 迁出；零行为变更）。
 * BootstrapOptions / BootstrapResult / ReplContextWithPermissions 等；
 * bootstrap.ts 保留 re-export，外部消费点（cli.ts / feishu-command.ts）不变。
 */

import type { AgentService, AgentTeamService, MemberStatus } from '@vessel-agent/agent';
import type { EngineClient } from '@vessel-agent/engine-client';
import type { loadConfig, VesselConfig } from '../../packages/config/src/index';
import type {
  Logger,
  RunnableAgent,
  RunOptions,
  RunRecordStore,
  Runtime,
  TenantPaths,
  TraceRedactor,
} from '../../packages/core/src/index';
import type {
  AgentControlLike,
  GatewayRestartInput,
  GatewayRestartResult,
  HubControlLike,
  SelfRestartInput,
  SelfRestartResult,
} from '../../packages/serve/src/index';
import type { ReplContext } from '../../packages/tui/src/index';
import type { AgentOwnerServer } from '../agent/agent-owner-server';
import type { CollectedFeatures } from '../assembly/collect';
import type { FeishuChannelLike, MetricsControlLike } from '../cli/control-plane-types';
import type { ReplSettingsControlLike } from '../config/ui-settings';
import type { FederationRuntimeOptions } from '../federation/federation-config';
import type { MockScenarioName } from '../mock/scenarios';
import type { MetricsFactory } from '../observability/observability-wiring';
import type { TraceControl, TraceRecorderFactory } from '../observability/trace-wiring';
import type { McpControl } from '../plugin/mcp-wiring';
import type { RpcClient } from '../rpc/index';
import type { DurableRunsControlLike } from '../run/durable-wiring';
import type { SessionControl } from '../session/session-control';
import type { EngineSupervisor } from '../tools-engine/supervisor';
import type { RuntimeNoticeBus } from './runtime-notice';
import type { TenantRuntimeBundle } from './tenant-runtime-factory';

/**
 * tui 0.6.1 冻结的权限控制面（本 worktree 的 tui 尚未导出该类型）。
 * 合并 tui 后可改为 `import type { PermissionsControl } from '@vessel-agent/tui'`。
 */
export interface PermissionsControlLike {
  list(): Promise<string[]>;
  add(toolName: string): Promise<void>;
  remove(toolName: string): Promise<void>;
  path?(): string;
}

export type ReplContextWithPermissions = ReplContext & {
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
  /**
   * P2 活配置引用：热应用 / 写回成功后调用方把新配置写进 `.current`，总线 hook /
   * EU envCadence / 成员 spawn 的 env_injection 闭包下一请求即读到新值（修启动快照冻结）。
   * 形状照 toolsEngine.bridgeDeny { current } 先例。
   */
  liveConfigRef: { current: Awaited<ReturnType<typeof loadConfig>>['config'] };
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
    /** 池 S20：pool 模式无 child supervisor（缺省 undefined）；全仓零消费点（N grep 核）。 */
    supervisor?: EngineSupervisor;
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
     * 第 6 修：`model` = 缺省 ref，`wireModel` = 配套展示 wire。
     */
    applyDefaultModel: (model: string, wireModel?: string) => void;
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
  /**
   * S7 热应用：原地更新出站 federation 端口的已解析选项（config scope 的
   * applyFederation 用）。启动时 `federation.enabled: false` ⇒ 端口未构造 ⇒ 缺省。
   */
  federationApply?: (next: FederationRuntimeOptions) => void;
  /**
   * auto-gc P1 热应用：把重载配置喂进调度器持有的活配置引用（live resolver 闭包
   * 每趟求值，下一趟即按新 enabled / interval / olderThan / dryRun 执行）。
   * connectMode / 无本地调度器时缺省（cli 的 applyAutoPrune 据此如实报 requires restart）。
   */
  applyAutoPruneConfig?: (next: VesselConfig) => string[];
  /**
   * R-6：localDispatcher（vessel op=rpc 路）注入的 kanban deps（可变对象）。
   * cli 的 applyKanban 热应用原地更新 boardPath，与网络面 kanbanDeps 同一语义；
   * 缺省 = 无本地 dispatcher 装配（connect 模式等）。
   */
  kanbanDeps?: { boardPath: string };
  /**
   * P2 声明式收集器（ADR-107）：dispatcher phase 收集结果（一份 deps + hotApply +
   * result 透传）。cli 网络面展开同一份——两表面同源，「忘接一路」结构上不可能。
   * 缺省 = 无本地 dispatcher 装配（connect 模式等）。
   */
  assembly?: CollectedFeatures;
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
   * node 退出序列（幂等）：fence 准入 → 不限时等活跃 run 自然跑完
   * （drain-to-quiesce，不 interrupt、不写标记）→ flush。
   * **必须在 gateway.stop() 之前调**（先关闸再等，退出期间不再起新 run）。
   * 没有本地执行面（connect 模式）时不提供。
   */
  beginDrain?: () => Promise<void>;
  /**
   * 自重启 Option A：`node.restart.self` 的预约受理（写 continuation 标记后立即返回）。
   * 没有本地执行面（connect 模式 / agent 关闭）时不提供。
   */
  selfRestart?: (input: SelfRestartInput) => Promise<SelfRestartResult>;
  /**
   * q-restart-tool：`gateway.restart` 的完整预约（标记 + handoff + detached 编排者）。
   * vessel 工具面经 op=rpc 触达；prompt 可选（缺省 = 请求级续作）。
   */
  gatewayRestart?: (input: GatewayRestartInput) => Promise<GatewayRestartResult>;
  cleanup: () => void;
}
