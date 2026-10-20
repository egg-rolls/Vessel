/**
 * Vessel 默认配置
 * @module @vessel/config
 */

import type {
  DurableConfig,
  EvalsConfig,
  FeishuConfig,
  McpServerConfig,
  ObservabilityConfig,
  SchedulerConfig,
  ServeConfig,
  TraceConfig,
  TransportConfig,
  VesselConfig,
  WorkflowConfig,
} from './types.js';

/**
 * provider-aware 默认 model：只给已知 provider 设默认。
 * 未知 provider 必须显式配置 model（validator 会 fail-fast），不再全局回退 gpt-4。
 */
export const PROVIDER_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  openai: 'gpt-4',
};

/** 取 provider 的默认 model；未知 provider 返回 undefined */
export function defaultModelForProvider(name: string | undefined): string | undefined {
  return name ? PROVIDER_DEFAULT_MODELS[name] : undefined;
}

/**
 * 0.2 Scheduler 默认值。
 * 不写入 DEFAULT_CONFIG：只有 host.enabled=true 时才被消费，
 * 未配置时保持 0.1 行为（不创建 Scheduler）。
 */
export const DEFAULT_SCHEDULER_OPTIONS: Required<SchedulerConfig> = {
  maxConcurrency: 1,
  maxQueueSize: 100,
  perAgentSerial: true,
};

/**
 * 0.2 Transport 默认值。
 * 同样不写入 DEFAULT_CONFIG；host 关闭时不创建 transport。
 */
export const DEFAULT_TRANSPORT_OPTIONS: Required<
  Pick<TransportConfig, 'kind' | 'hostname' | 'peersDir' | 'heartbeatMs' | 'peerTtlMs'>
> = {
  kind: 'in-process',
  hostname: '127.0.0.1',
  peersDir: '~/.vessel/peers',
  heartbeatMs: 5000,
  peerTtlMs: 15000,
};

/**
 * 0.3 MCP server 默认值。
 * 不写入 DEFAULT_CONFIG：未配置 `mcp_servers` 时不加载 MCP 插件。
 */
export const DEFAULT_MCP_SERVER_OPTIONS: Required<
  Pick<McpServerConfig, 'enabled' | 'connectTimeoutMs' | 'toolTimeoutMs' | 'toolPrefix'>
> = {
  enabled: true,
  connectTimeoutMs: 10000,
  toolTimeoutMs: 60000,
  toolPrefix: true,
};

/**
 * 0.3 durable 默认值。
 * 不写入 DEFAULT_CONFIG：默认关闭，关闭时不创建 RunStore、0.2 行为不变。
 */
export const DEFAULT_DURABLE_OPTIONS: Required<
  Pick<DurableConfig, 'enabled' | 'backend' | 'path' | 'checkpointEvery'>
> = {
  enabled: false,
  backend: 'file',
  path: '~/.vessel/runs',
  checkpointEvery: 'iteration',
};

/**
 * 0.3 serve 默认值（仅监听回环、明文）。
 * 不写入 DEFAULT_CONFIG：未配置时 gateway 仍走原有默认常量。
 */
export const DEFAULT_SERVE_OPTIONS: Required<
  Pick<ServeConfig, 'hostname' | 'port' | 'allowRemote'>
> = {
  hostname: '127.0.0.1',
  port: 8642,
  allowRemote: false,
};

/**
 * 0.4 workflow 默认值。
 * 不写入 DEFAULT_CONFIG：默认关闭，关闭时不加载引擎、0.3 行为不变。
 */
export const DEFAULT_WORKFLOW_OPTIONS: Required<WorkflowConfig> = {
  enabled: false,
  dir: './workflows',
  path: '~/.vessel/workflows',
  maxParallel: 2,
  stepTimeoutMs: 300000,
};

/**
 * 0.4 evals 默认值。
 * 不写入 DEFAULT_CONFIG：默认关闭且完全离线。
 */
export const DEFAULT_EVALS_OPTIONS: Required<EvalsConfig> = {
  enabled: false,
  dir: './evals',
  outDir: '~/.vessel/evals',
  allowNetwork: false,
};

/**
 * 0.4 feishu 默认值。
 * 不写入 DEFAULT_CONFIG：默认关闭，关闭时不加载渠道插件。
 * app_id / app_secret 由环境变量优先；这里只保留空串默认。
 */
export const DEFAULT_FEISHU_OPTIONS: Required<FeishuConfig> = {
  enabled: false,
  appId: '',
  appSecret: '',
  appSecretEnv: '',
  domain: 'feishu',
  allowedChatIds: [],
  sessionPrefix: 'feishu',
  replyTimeoutMs: 300000,
  maxReplyChars: 4000,
  maxMembers: 8,
};

/**
 * 0.4 observability 默认值。
 * 不写入 DEFAULT_CONFIG：块缺省时不创建 collector、不暴露 /v1/metrics。
 * event_history 缺省 1000 与 core MemoryEventStream 默认一致；显式 0 = 不限制。
 */
export const DEFAULT_OBSERVABILITY_OPTIONS: Required<ObservabilityConfig> = {
  eventHistory: 1000,
  metrics: true,
};

/** 全局数据根（0.5；不写入 DEFAULT_CONFIG，保持 0.4 配置形状） */
export const DEFAULT_DATA_DIR = '~/.vessel/data';

/** tenant id 缺省值 */
export const DEFAULT_TENANT_ID = 'default';

/**
 * 0.5 trace 默认值。
 * 不写入 DEFAULT_CONFIG：未配置 trace 时仍按这些值消费。
 */
export const DEFAULT_TRACE_OPTIONS: Required<TraceConfig> = {
  enabled: true,
  level: 'full',
  retentionDays: 30,
  maxRuns: 1000,
  maxBytes: 1073741824,
};

/** 安全默认值 */
export const DEFAULT_CONFIG: VesselConfig = {
  provider: {
    name: 'openai',
    temperature: 0.7,
    maxTokens: 4096,
  },
  limits: {
    requestLimit: 100,
    toolCallsLimit: 50,
    inputTokensLimit: 100000,
    outputTokensLimit: 50000,
  },
  termination: {
    maxIterations: 20,
    maxRuntimeSeconds: 300,
  },
  session: {
    backend: 'file',
  },
  context: {
    maxTokens: 1_000_000,
    maxMessages: 100,
    // 0.6.1 P1：默认开启压缩；有 provider summarizer 时生成真实摘要。
    autoCompact: true,
    compactThreshold: 0.8,
  },
};
