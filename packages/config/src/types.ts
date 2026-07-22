/**
 * Vessel 配置类型定义
 * @module @vessel/config
 */

/** Provider 配置 */
export interface ProviderConfig {
  name: string;
  api_key?: string;
  base_url?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
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
  request_limit?: number;
  tool_calls_limit?: number;
  input_tokens_limit?: number;
  output_tokens_limit?: number;
  total_cost_limit?: number;
}

/** 终止策略配置 */
export interface TerminationConfig {
  max_iterations?: number;
  max_runtime_seconds?: number;
  stop_on_no_tool_calls?: boolean;
}

/** Agent 配置 */
export interface AgentConfig {
  name?: string;
  system_prompt?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

/** 会话配置 */
export interface SessionConfig {
  backend?: 'memory' | 'file';
  storage_path?: string;
  max_history?: number;
}

/** 上下文配置 */
export interface ContextConfig {
  max_tokens?: number;
  max_messages?: number;
  auto_compact?: boolean;
  compact_threshold?: number;
}

/** 插件配置 */
export interface PluginConfig {
  name: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** Vessel 配置 */
export interface VesselConfig {
  api_key?: string;
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
  configPath?: string;
  envPrefix?: string;
  defaults?: Partial<VesselConfig>;
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
