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
