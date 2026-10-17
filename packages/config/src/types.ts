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
  /** 存储后端：sqlite（默认）/ file / memory */
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

/** serve TLS 配置；cert/key 必须成对 */
export interface ServeTlsConfig {
  certFile?: string;
  keyFile?: string;
}

/** serve 配置（0.3；默认回环 + 明文） */
export interface ServeConfig {
  /** 监听地址（默认 127.0.0.1） */
  hostname?: string;
  /** 监听端口（默认 8642；0 = 系统分配） */
  port?: number;
  /** 显式允许非回环监听（默认 false） */
  allowRemote?: boolean;
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

/** Vessel 配置 */
export interface VesselConfig {
  apiKey?: string;
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
}

/** 配置加载选项 */
export interface ConfigLoadOptions {
  /** 项目配置文件路径（默认 ./vessel.yaml） */
  configPath?: string;
  /** 用户配置文件路径（默认 ~/.vessel/config.yaml） */
  userConfigPath?: string;
  /** 环境变量前缀（默认 VESSEL_） */
  envPrefix?: string;
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
