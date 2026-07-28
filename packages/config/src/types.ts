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

/** 工具配置 */
export interface ToolConfig {
  name: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
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
  backend?: 'memory' | 'file';
  storagePath?: string;
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

/** Vessel 配置 */
export interface VesselConfig {
  apiKey?: string;
  provider?: ProviderConfig;
  agent?: AgentConfig;
  tools?: ToolConfig[];
  guardrails?: GuardrailConfig[];
  hooks?: HookConfig[];
  limits?: UsageLimitsConfig;
  termination?: TerminationConfig;
  session?: SessionConfig;
  context?: ContextConfig;
  plugins?: PluginConfig[];
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
