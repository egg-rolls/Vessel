/**
 * Vessel 配置类型定义
 * @module @vessel-agent/config
 *
 * 所有字段使用 camelCase（ADR-019）。config loader 自动将 YAML 的 snake_case 映射过来。
 */

/** Provider 配置 */
export interface ProviderConfig {
  name: string;
  apiKey?: string;
  /** 从该环境变量读取 apiKey（同层显式 apiKey 优先） */
  apiKeyEnv?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 请求超时毫秒；<=0 关闭。缺省由 provider 插件决定（当前 120s） */
  timeoutMs?: number;
}

/** Guardrail 配置 */
export interface GuardrailConfig {
  name: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** Hook 配置 */
export interface HookConfig {
  name: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** 使用量限制配置 */
export interface UsageLimitsConfig {
  requestLimit?: number;
  toolCallsLimit?: number;
  inputTokensLimit?: number;
  outputTokensLimit?: number;
  totalCostLimit?: number;
}

/** 终止策略配置 */
export interface TerminationConfig {
  maxIterations?: number;
  maxRuntimeSeconds?: number;
}

/** 成员可见性（0.16；默认 private） */
export type AgentVisibility = 'private' | 'team' | 'tenant';

/** Agent 配置 */
export interface AgentConfig {
  name?: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 是否注册 canonical `agent` 工具并启动 AgentService（默认 false） */
  enabled?: boolean;
  /** spawn 成员的默认可见性（默认 private） */
  defaultVisibility?: AgentVisibility;
  /** 成员回复是否允许触发父级新一轮（默认 false） */
  followReplies?: boolean;
  /** 成员限额；缺省继承顶层 limits */
  limits?: UsageLimitsConfig;
  /** 成员终止策略；缺省继承顶层 termination */
  termination?: TerminationConfig;
  /** 成员权限模式；缺省交互 bridge、headless allow */
  permissionMode?: 'bridge' | 'allow' | 'deny';
  /** deny 模式保留的只读工具（默认 ['read']） */
  readOnlyTools?: string[];
  /** 主 agent（owner）成员 ID（默认 main） */
  ownerId?: string;
  /**
   * 默认工作目录（0.11.1，DECISION-022 §2.4）。
   * 支持 `~`；相对路径按进程 cwd 解析为绝对路径（由装配层解析，validator 只校验类型）。
   * 优先级：工具参数 `cwd` > `agent.cwd` > `process.cwd()`。
   */
  cwd?: string;
}

/** 会话配置 */
export interface SessionConfig {
  /** 存储后端：file（0.5 默认）/ sqlite / memory */
  backend?: 'sqlite' | 'file' | 'memory';
  /** sqlite = 数据库文件路径；file = 目录；memory 忽略 */
  storagePath?: string;
  /** @deprecated 0.1.0 未消费；保留仅为兼容旧配置 */
  maxHistory?: number;
}

/** 上下文配置 */
export interface ContextConfig {
  maxTokens?: number;
  maxMessages?: number;
  autoCompact?: boolean;
  compactThreshold?: number;
}

/** 插件配置 */
export interface PluginConfig {
  name: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** 自动更新配置 */
export interface UpdateConfig {
  /** REPL 启动后台检查（默认 true） */
  autoCheck?: boolean;
  /** 更新通道（默认 latest） */
  channel?: 'latest' | 'beta';
  /** 自定义清单源；缺省用 GitHub Release */
  source?: string;
}

/** Host 配置（0.2；默认关闭，关闭时走 0.1 单 agent 路径） */
export interface HostConfig {
  enabled?: boolean;
  /** nodeId 唯一来源；缺省进程内生成 */
  nodeId?: string;
  /** Host 全局预算；缺省关闭 */
  limits?: UsageLimitsConfig;
}

/** Scheduler 配置（仅 host.enabled=true 时生效） */
export interface SchedulerConfig {
  /** 全局 FIFO 并发上限（默认 1） */
  maxConcurrency?: number;
  /** 队列上限（默认 100） */
  maxQueueSize?: number;
  /** 同一成员串行（默认 true） */
  perAgentSerial?: boolean;
}

/** MCP server 配置（0.3；`mcp_servers` map 的值，键为 server 名） */
export interface McpServerConfig {
  /** 传输方式；stdio 必填 command，http 必填 url */
  transport: 'stdio' | 'http';
  /** stdio：启动命令 */
  command?: string;
  /** stdio：命令参数 */
  args?: string[];
  /** stdio：子进程环境变量 */
  env?: Record<string, string>;
  /** http：MCP Streamable HTTP 端点 */
  url?: string;
  /** http：请求头 */
  headers?: Record<string, string>;
  /** 是否启用（默认 true）；false 时仍出现在 MCP 状态快照中 */
  enabled?: boolean;
  /** 建连超时毫秒（默认 10000） */
  connectTimeoutMs?: number;
  /** 单次工具调用超时毫秒（默认 60000） */
  toolTimeoutMs?: number;
  /** 工具名加 `mcp__<server>__` 前缀（默认 true） */
  toolPrefix?: boolean;
  /** 自动允许的工具原始名（前缀前、大小写敏感） */
  autoApproveTools?: string[];
}

/** Durable run 配置（0.3；默认关闭） */
export interface DurableConfig {
  /** true 才创建 RunStore 并写 checkpoint（默认 false） */
  enabled?: boolean;
  /** 后端（默认 file） */
  backend?: 'file' | 'memory';
  /** file 后端目录（默认 ~/.vessel/runs） */
  path?: string;
  /** checkpoint 时机；0.3 仅支持 iteration（每轮 tool-call 后） */
  checkpointEvery?: 'iteration';
}

/** Eval harness 配置（0.4；默认关闭、默认离线） */
export interface EvalsConfig {
  /** true 才允许 CLI eval（默认 false） */
  enabled?: boolean;
  /** suite 目录（默认 ./evals） */
  dir?: string;
  /** 报告输出目录（默认 ~/.vessel/evals） */
  outDir?: string;
  /** 配置层网络允许；仍需 CLI --allow-network（默认 false） */
  allowNetwork?: boolean;
}

/** 飞书渠道配置（0.4；默认关闭；凭据 env 优先） */
export interface FeishuConfig {
  enabled?: boolean;
  /** 环境变量 VESSEL_FEISHU_APP_ID 优先 */
  appId?: string;
  /** 环境变量 VESSEL_FEISHU_APP_SECRET 优先；永不打印 */
  appSecret?: string;
  /** 从该环境变量读取 appSecret（同层显式 appSecret 优先） */
  appSecretEnv?: string;
  /** 仅切换域名，不改变语义（默认 feishu） */
  domain?: 'feishu' | 'lark';
  /** 空 = 机器人所在全部会话 */
  allowedChatIds?: string[];
  /** session = <prefix>:<chat_id>（默认 feishu） */
  sessionPrefix?: string;
  /** 单次回复超时毫秒（默认 300000；1..86400000） */
  replyTimeoutMs?: number;
  /** 单条回复最大字符数（默认 4000；1..100000） */
  maxReplyChars?: number;
  /** 专用 Host 成员上限（默认 8；1..64） */
  maxMembers?: number;
}

/** 可观测性配置（0.4；块存在时才启用 metrics） */
export interface ObservabilityConfig {
  /** 事件历史容量：默认 1000；显式 0 = 不限制；>0 = 环形缓冲 */
  eventHistory?: number;
  /** 创建 MetricsCollector 并注入 gateway / TUI（默认 true） */
  metrics?: boolean;
  /**
   * 是否把 `process.error` / `shutdown.failed` 等进程级错误暴露给诊断面
   * （0.14；默认 false，仅 logger + trace）。
   */
  showProcessErrors?: boolean;
}

/** serve TLS 配置；cert/key 必须成对 */
export interface ServeTlsConfig {
  certFile?: string;
  keyFile?: string;
}

/** gateway principal 角色 */
export type PrincipalRole = 'read' | 'write' | 'admin';

/** S5：节点动态 token 的 scope（additive；静态 token 缺省） */
export type PrincipalScope = 'view' | 'exchange' | 'control' | 'admin';

/** 由 token 解析出的 principal（A-3 §10.4 冻结：snake_case tenant_id） */
export interface Principal {
  tenant_id: string;
  role: PrincipalRole;
  /** S5：动态 token 的 scope；静态 token 缺省 */
  scope?: PrincipalScope;
  /** S5：control token 的 team 限制 */
  team_id?: string;
  /** S5：吊销 / 关闭 WS 用 */
  token_id?: string;
  /** S5：token 绑定的 hub */
  hub_id?: string;
}

/** serve token 条目（A-3 §10.4；键为原始 token，永不打印） */
export interface ServeTokenEntry {
  tenantId?: string;
  role?: PrincipalRole;
}

/** 可观测性 trace 配置（0.5；缺省不写入 config，消费 DEFAULT_TRACE_OPTIONS） */
export interface TraceConfig {
  enabled?: boolean;
  level?: 'full' | 'metadata' | 'off';
  retentionDays?: number;
  maxRuns?: number;
  /** 0 = 不限 */
  maxBytes?: number;
  /**
   * 是否把 `llm.stream.chunk` 落盘（0.10 R2-14）。
   * 默认 false：实时事件仍发布，只是不写 trace（避免 trace 体积随流式输出暴涨）。
   */
  includeStreamChunks?: boolean;
}

/** tenant 级设置 */
export interface TenantSettings {
  name?: string;
  status?: 'active' | 'disabled';
  quota?: {
    maxSessions?: number;
    maxRunsPerDay?: number;
    maxConcurrentRuns?: number;
    maxStorageBytes?: number;
  };
  tools?: { allow?: string[]; deny?: string[] };
  /** tenant 覆盖层；白名单见 DECISION-010 §11.4 */
  config?: Partial<VesselConfig>;
}

/** tenant 配置块 */
export interface TenantConfig {
  default?: string;
  /** 键必须匹配 ^[a-z0-9][a-z0-9_-]{0,63}$ */
  tenants?: Record<string, TenantSettings>;
}

/** serve 配置（0.3；默认回环 + 明文） */
export interface ServeConfig {
  /** 监听地址（默认 127.0.0.1） */
  hostname?: string;
  /**
   * 0.6：独立前端允许的浏览器 Origin。
   * 绝对 http(s) origin；禁止 `*` / path / query / hash；非回环必须 https。
   */
  allowedOrigins?: string[];
  /** 监听端口（默认 8642；0 = 系统分配） */
  port?: number;
  /** 显式允许非回环监听（默认 false） */
  allowRemote?: boolean;
  /** 旧单 token（0.4）：principal = default/admin */
  token?: string;
  /** 从该环境变量读取 token */
  tokenEnv?: string;
  /** A-3：token → { tenantId, role }；键为原始 token，必须原样保留 */
  tokens?: Record<string, ServeTokenEntry>;
  /** A-3：跨 tenant admin；tenantId = '*' */
  adminToken?: string;
  /** 从该环境变量读取 adminToken */
  adminTokenEnv?: string;
  /** TLS 证书对 */
  tls?: ServeTlsConfig;
}

/** 远程节点（0.6；静态注册，无自动发现） */
export interface TransportNodeConfig {
  /** 节点 id；唯一，匹配 ^[A-Za-z0-9_-]{1,64}$ */
  id: string;
  /** 节点 gateway URL；非回环必须 https */
  url: string;
  /** 节点 token；建议改用 tokenEnv */
  token?: string;
  /** 从该环境变量读取 token */
  tokenEnv?: string;
  /** 节点自签/私有 CA 文件（PEM） */
  caFile?: string;
}

/** Transport 配置（0.2；0.6 增加 remote） */
export interface TransportConfig {
  kind?: 'in-process' | 'loopback' | 'remote';
  /** 仅 loopback；只允许回环地址 */
  hostname?: string;
  /** 缺省复用 VESSEL_GATEWAY_TOKEN / gateway token */
  token?: string;
  /** loopback 注册表目录（默认 ~/.vessel/peers） */
  peersDir?: string;
  /** 注册表心跳毫秒（默认 5000） */
  heartbeatMs?: number;
  /** peer 失效毫秒（默认 15000；必须 > heartbeatMs） */
  peerTtlMs?: number;
  /** 0.6 remote：静态节点列表 */
  nodes?: TransportNodeConfig[];
}

/** 0.6：`--connect` 客户端配置（token/CA；URL 仍走 CLI/env） */
export interface ConnectConfig {
  /** gateway token；建议改用 tokenEnv */
  token?: string;
  /** 从该环境变量读取 token */
  tokenEnv?: string;
  /** 自签/私有 CA 文件（PEM） */
  caFile?: string;
}

/**
 * Team 声明（0.19 S3）。
 *
 * 全局配置；tenant overlay 不允许声明 `teams`。
 */
export interface TeamConfigInput {
  /** Team 名；可选，缺省由装配层决定 */
  name?: string;
  /**
   * Team 工作区路径（必填）。
   * validator 只做 trim + `path.resolve` 归一化去重；存值保持 trim 后的原文，
   * `~` 展开由装配层负责。
   */
  workspace: string;
  /** 启动嘱托 / handoff 文件路径（可选） */
  handoffPath?: string;
  /** Team 策略；顶层键开放，`permission` / `budget` 由 `parseTeamPolicy` 校验 */
  policy?: Record<string, unknown>;
}

/**
 * S7：跨节点 team ↔ team 的 peer 声明（全局配置）。
 *
 * - `nodeId` / `teamId` 是对端身份；`localTeamId` 只用于入站映射。
 * - `tokenEnv` 必填；明文 token 不接受。
 * - `url` 在 `direction` 含 `out` 时必填；非回环必须 https。
 * - YAML 写 `node_id` / `team_id` / `local_team_id`，loader 递归转 camelCase。
 */
export interface FederationPeerConfig {
  nodeId: string;
  teamId: string;
  url?: string;
  tokenEnv: string;
  caFile?: string;
  direction?: 'in' | 'out' | 'both';
  localTeamId?: string;
}

/** S7：跨节点 federation（缺省关闭；不做自动发现）。 */
export interface FederationConfig {
  enabled?: boolean;
  /** 节点间跨越次数上界；缺省 4，1..16 */
  maxHops?: number;
  peers?: FederationPeerConfig[];
}

/** 无人值守权限策略；缺省 hold。没有 allow-after。 */
export interface TeamPermissionPolicy {
  unattended?: 'hold' | 'deny-after';
  /** deny-after 必填；1..86400 秒 */
  denyAfterSeconds?: number;
}

/** 环检测参数；不可关闭，只能调阈值。 */
export interface TeamBudgetCyclePolicy {
  /** 同一有向边允许的次数；缺省 2，>= 1 */
  maxRepeats?: number;
  /** 触发后的冷却秒数；缺省 60，>= 0 */
  cooldownSeconds?: number;
}

/** 预算限额；缺省 = 不限。 */
export interface TeamBudgetPolicy {
  maxHops?: number;
  maxTurns?: number;
  maxTokens?: number;
  maxWallClockSeconds?: number;
  /** 0 < x < 1；缺省 0.8 */
  warningThreshold?: number;
  cycle?: TeamBudgetCyclePolicy;
}

/** S7.2：接收侧对跨节点入站报文的同意策略。 */
export interface TeamFederationPolicy {
  /**
   * `log` = 只写 Team 日志（缺省）；`members` = 向 present 且非 private 成员
   * fan-out 一次 mention 投递。缺省不写字段，消费方按 `log` 处理。
   */
  accept?: 'log' | 'members';
}

/** 解析后的 Team policy 视图；`policy` 顶层仍允许其它键。 */
export interface TeamPolicy {
  permission?: TeamPermissionPolicy;
  budget?: TeamBudgetPolicy;
  /** S7.2：跨节点接收策略；缺省 log。 */
  federation?: TeamFederationPolicy;
  [key: string]: unknown;
}

/** S5：hub TLS 配置；cert/key 必须成对 */
export interface HubTlsConfig {
  certFile?: string;
  keyFile?: string;
}

/** S5：hub 监听地址 */
export interface HubListenConfig {
  hostname?: string;
  port?: number;
}

/**
 * S5 / S5.1：hub 控制面配置。
 *
 * - `dataDir` 必须与 gateway 的 `dataDir` 不同；
 * - `direction: 'hub'` = hub 进程（拨号 node）；`'node'` = gateway 出站加入 hub；
 * - `url` / `caFile` / `joinCodeEnv` 只在 node 角色使用；
 * - `token` 明文不接受，只允许 `tokenEnv` / SecretStore。
 */
export interface HubConfig {
  dataDir?: string;
  direction?: 'hub' | 'node';
  /** node → hub 出站：hub 基址（join 的缺省 URL）。 */
  url?: string;
  /** node → hub 出站：hub TLS CA 路径。 */
  caFile?: string;
  /** `vessel hub join` 缺 `--code` 时读取的 env 名。 */
  joinCodeEnv?: string;
  listen?: HubListenConfig;
  allowRemote?: boolean;
  tls?: HubTlsConfig;
  allowedOrigins?: string[];
  tokenEnv?: string;
  allowFileSecrets?: boolean;
  pairingTtlSeconds?: number;
}

/** 配置来源（叶子级追踪） */
export type ConfigSource = 'cli' | 'env' | 'project' | 'user' | 'default';

/** 叶子键（camelCase 点路径）→ 来源 */
export type ConfigSources = Record<string, ConfigSource>;

/**
 * 脱敏后的来源映射：敏感路径（`serve.tokens.*` / `*.apiKey` / `*.token`）
 * 的值是 `<set>` 而不是来源标签。
 */
export type RedactedConfigSources = Record<string, ConfigSource | '<set>'>;

/** 配置快照（A-3 §10.6；web 使用结构镜像或注入，不 import 本包） */
export interface ConfigSnapshot {
  schema_version: 1;
  /** 已脱敏 */
  config: VesselConfig;
  /** 基础层来源（敏感路径已脱敏） */
  sources: RedactedConfigSources;
  paths: { user: string; project: string };
  tenant_id?: string;
  /** tenant overlay 命中的叶子键；不伪造第 6 种 source */
  tenant_overlay_keys?: string[];
}

/** 权限配置（0.6.1；交互确认与免确认规则） */
export interface PermissionConfig {
  /**
   * 免确认工具名列表（精确匹配）。交互 REPL 的 "always" 也会写回这里，
   * 重启后继续生效。`ask_user` 由运行时始终免确认。
   */
  autoApprove?: string[];
}

/** 状态栏位置（0.13）：top / bottom / both / none */
export type UiStatusBars = 'top' | 'bottom' | 'both' | 'none';

/** UI 输出详略（0.14；默认 normal） */
export type UiVerbosity = 'minimal' | 'normal' | 'debug';

/** 错误展示层级（0.14；默认 user） */
export type UiErrorLevel = 'user' | 'all';

/** UI 配置（0.8.5；0.11 clearOnStart；0.11.1 showReasoning；0.13 statusBars；0.14 可见性；0.15 askUser） */
export interface UiConfig {
  /** UI 语言；'zh-CN' | 'en'，非法值由消费方归一化回退 */
  language?: string;
  /**
   * 输出详略（0.14；默认 normal）。
   * minimal = 只保留结果，normal = 现有行为，debug = 额外诊断。
   */
  verbosity?: UiVerbosity;
  /**
   * 是否在事件流中展示 `llm.request` / `hook.*` / `agent.*` 等内部事件
   * （0.14；默认 false，保持 0.13 行为）。
   */
  showInternalEvents?: boolean;
  /**
   * 错误展示层级（0.14；默认 user：只展示 run/tool/permission 级错误）。
   * all = 同时展示 internal / process 级错误。
   */
  errorLevel?: UiErrorLevel;
  /**
   * 进入交互 REPL 时是否发送 ANSI 清屏（默认 true）。
   * 不写入默认配置；消费方按 `!== false` 处理。
   */
  clearOnStart?: boolean;
  /**
   * 是否把模型思考流（`reasoning_delta`）发布给 UI（默认 false）。
   * 不写入默认配置；消费方按 `=== true` 处理，避免思维链默认外泄。
   */
  showReasoning?: boolean;
  /**
   * 状态栏位置（默认由消费方决定）。
   * YAML 键为 `status_bars`；非法值由 validator 拒绝，不做静默回退。
   */
  statusBars?: UiStatusBars;
  /**
   * 是否注册 `ask_user` 工具（0.15；YAML 键 `ask_user`）。
   *
   * 默认由入口决定：交互 REPL（TTY）与 `gateway start` / `--serve` 为 true，
   * `--run` / headless / 管道为 false。显式 `false` 关闭；显式 `true` 也不会在
   * 无客户端的 headless 入口注册（否则只能等 120s 超时）。
   */
  askUser?: boolean;
}

/** Vessel 配置 */
export interface VesselConfig {
  apiKey?: string;
  /** 从该环境变量读取 apiKey（同层显式 apiKey 优先） */
  apiKeyEnv?: string;
  /** 全局数据根；tenant overlay 不得覆盖 */
  dataDir?: string;
  /** 多租户配置 */
  tenant?: TenantConfig;
  /** trace 配置；缺省消费 DEFAULT_TRACE_OPTIONS */
  trace?: TraceConfig;
  provider?: ProviderConfig;
  agent?: AgentConfig;
  guardrails?: GuardrailConfig[];
  hooks?: HookConfig[];
  limits?: UsageLimitsConfig;
  termination?: TerminationConfig;
  session?: SessionConfig;
  context?: ContextConfig;
  /** 0.6.1：工具权限免确认规则 */
  permission?: PermissionConfig;
  plugins?: PluginConfig[];
  update?: UpdateConfig;
  host?: HostConfig;
  scheduler?: SchedulerConfig;
  transport?: TransportConfig;
  /** 0.6：`--connect` 客户端 token/CA */
  connect?: ConnectConfig;
  /** 0.3：MCP servers，键为 server 名 */
  mcpServers?: Record<string, McpServerConfig>;
  /** 0.3：durable run（checkpoint / resume） */
  durable?: DurableConfig;
  /** 0.3：gateway 监听与 TLS */
  serve?: ServeConfig;
  /** S5：hub 控制面 */
  hub?: HubConfig;
  /** 0.4：eval harness */
  evals?: EvalsConfig;
  /** 0.4：飞书渠道 */
  feishu?: FeishuConfig;
  /** 0.4：可观测性 */
  observability?: ObservabilityConfig;
  /** 0.8.5：UI 语言 */
  ui?: UiConfig;
  /** 0.19 S3：全局 Team 声明；tenant overlay 不允许覆盖 */
  teams?: TeamConfigInput[];
  /** S7：跨节点 team ↔ team；全局配置，tenant overlay 不允许 */
  federation?: FederationConfig;
}

/** 配置加载选项 */
export interface ConfigLoadOptions {
  /** 项目配置文件路径（默认 ./vessel.yaml） */
  configPath?: string;
  /** 用户配置文件路径（默认 ~/.vessel/config.yaml） */
  userConfigPath?: string;
  /** 环境变量前缀（默认 VESSEL_） */
  envPrefix?: string;
  /** CLI/调用方显式 tenant id（高于 VESSEL_TENANT 与 config.tenant.default） */
  tenantId?: string;
  /** 环境变量来源；缺省 process.env（便于测试注入） */
  env?: Record<string, string | undefined>;
  /**
   * CLI 覆盖层（最高优先级）。生产路径由 CLI/外壳把显式 flag 组装成
   * `Partial<VesselConfig>` 后传入，loader 统一合并并标注 source=cli。
   */
  cliOverrides?: Partial<VesselConfig>;
  /**
   * @deprecated 与 `cliOverrides` 同义；保留仅为兼容旧调用方。
   * 同时提供时 `cliOverrides` 后应用（优先）。
   */
  defaults?: Partial<VesselConfig>;
}

/** 用户级配置（~/.vessel/config.yaml） */
export interface UserConfig {
  /** API Key（唯一必填项） */
  apiKey?: string;
  /** 默认 provider */
  defaultProvider?: string;
  /** 默认模型 */
  defaultModel?: string;
  /** 多 provider Key */
  providers?: Record<string, { apiKey: string; baseUrl?: string; model?: string }>;
}

/** 配置校验结果 */
export interface ConfigValidationResult {
  valid: boolean;
  errors: ConfigValidationError[];
  warnings: ConfigValidationWarning[];
}

/** 配置校验错误 */
export interface ConfigValidationError {
  path: string;
  message: string;
  value?: unknown;
}

/** 配置校验警告 */
export interface ConfigValidationWarning {
  path: string;
  message: string;
  value?: unknown;
}
