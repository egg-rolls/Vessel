/**
 * Vessel 配置类型定义
 * @module @vessel/config
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

/** Agent 配置 */
export interface AgentConfig {
  name?: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
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

/** 子 agent 分派配置（delegate_task） */
export interface DelegateConfig {
  /** false = 不注册 delegate_task（运行期工具变为 3 个） */
  enabled?: boolean;
  /** 最大 delegate 深度 */
  maxDepth?: number;
  /** 子 agent 禁用的工具名 */
  disallowed?: string[];
  /** 子 agent 模型；缺省沿用主 model */
  model?: string;
  termination?: TerminationConfig;
  limits?: UsageLimitsConfig;
  /** 子 agent 权限模式；缺省交互 bridge、headless allow */
  permissionMode?: 'bridge' | 'allow' | 'deny';
  /** deny 模式下保留的只读工具（默认 ['read']） */
  readOnlyTools?: string[];
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

/** Workflow 配置（0.4；默认关闭） */
export interface WorkflowConfig {
  /** true 才构造 workflow 引擎（默认 false） */
  enabled?: boolean;
  /** 定义文件目录（默认 ./workflows） */
  dir?: string;
  /** run 状态存储目录（默认 ~/.vessel/workflows） */
  path?: string;
  /** 最大并行步骤数（默认 2；1..8） */
  maxParallel?: number;
  /** 单 step 超时毫秒（默认 300000；1..86400000） */
  stepTimeoutMs?: number;
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
}

/** serve TLS 配置；cert/key 必须成对 */
export interface ServeTlsConfig {
  certFile?: string;
  keyFile?: string;
}

/** gateway principal 角色 */
export type PrincipalRole = 'read' | 'write' | 'admin';

/** 由 token 解析出的 principal（A-3 §10.4 冻结：snake_case tenant_id） */
export interface Principal {
  tenant_id: string;
  role: PrincipalRole;
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

/** Transport 配置（0.2；默认 in-process） */
export interface TransportConfig {
  kind?: 'in-process' | 'loopback';
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
}

/** agent team 原型配置（0.1.0 显式 opt-in；默认关闭） */
export interface TeamConfig {
  /** true 才构造 createTeamPlugin（默认 false；进程内原型） */
  enabled?: boolean;
  /** owner（主 agent）成员 ID（默认 'owner'） */
  ownerId?: string;
  /** 成员默认模型；缺省沿用主 model */
  model?: string;
  memberLimits?: UsageLimitsConfig;
  memberTermination?: TerminationConfig;
}

/** 配置来源（叶子级追踪） */
export type ConfigSource = 'cli' | 'env' | 'project' | 'user' | 'default';

/** 叶子键（camelCase 点路径）→ 来源 */
export type ConfigSources = Record<string, ConfigSource>;

/** 配置快照（A-3 §10.6；web 使用结构镜像或注入，不 import 本包） */
export interface ConfigSnapshot {
  schema_version: 1;
  /** 已脱敏 */
  config: VesselConfig;
  /** 基础层来源 */
  sources: ConfigSources;
  paths: { user: string; project: string };
  tenant_id?: string;
  /** tenant overlay 命中的叶子键；不伪造第 6 种 source */
  tenant_overlay_keys?: string[];
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
  plugins?: PluginConfig[];
  update?: UpdateConfig;
  delegate?: DelegateConfig;
  team?: TeamConfig;
  host?: HostConfig;
  scheduler?: SchedulerConfig;
  transport?: TransportConfig;
  /** 0.3：MCP servers，键为 server 名 */
  mcpServers?: Record<string, McpServerConfig>;
  /** 0.3：durable run（checkpoint / resume） */
  durable?: DurableConfig;
  /** 0.3：gateway 监听与 TLS */
  serve?: ServeConfig;
  /** 0.4：声明式 workflow 编排 */
  workflow?: WorkflowConfig;
  /** 0.4：eval harness */
  evals?: EvalsConfig;
  /** 0.4：飞书渠道 */
  feishu?: FeishuConfig;
  /** 0.4：可观测性 */
  observability?: ObservabilityConfig;
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
  /** CLI 覆盖 */
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
