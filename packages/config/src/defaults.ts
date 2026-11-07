/**
 * Vessel 默认配置
 * @module @vessel-agent/config
 */

import { DEFAULT_COMPACT_THRESHOLD } from '@vessel-agent/core';
import type {
  DurableConfig,
  EvalsConfig,
  FeishuConfig,
  GatewayConfig,
  LeaseConfig,
  McpServerConfig,
  ObservabilityConfig,
  PluginHttpLimitsConfig,
  SchedulerConfig,
  ServeConfig,
  TraceConfig,
  TransportConfig,
  VesselConfig,
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
 * Scheduler 默认值（0.2 起；0.27 起所有 agent/body 都经同一 scheduler）。
 * 不写入 DEFAULT_CONFIG：缺省即按 body 串行。
 */
export const DEFAULT_SCHEDULER_OPTIONS: Required<SchedulerConfig> = {
  maxConcurrency: 1,
  maxQueueSize: 100,
  perBodySerial: true,
};

/**
 * 0.2 Transport 默认值。
 * 同样不写入 DEFAULT_CONFIG；host 关闭时不创建 transport。
 */
export const DEFAULT_TRANSPORT_OPTIONS: Required<Pick<TransportConfig, 'kind'>> = {
  kind: 'in-process',
};

/**
 * 0.34 两级租约默认值（body / session）。
 * 不写入 DEFAULT_CONFIG：未配置 `lease` 时 EU 按这些值续租与过期。
 *
 * 约束：`ttlMs > renewMs`，`renewMs >= 1000`，`ttlMs >= renewMs + 1000`。
 */
export const DEFAULT_LEASE_OPTIONS: Required<LeaseConfig> = {
  ttlMs: 30_000,
  renewMs: 10_000,
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
 * 不写入 DEFAULT_CONFIG：默认开启；显式 `durable.enabled: false` 时不创建 RunStore。
 */
export const DEFAULT_DURABLE_OPTIONS: Required<
  Pick<DurableConfig, 'enabled' | 'backend' | 'path' | 'checkpointEvery'>
> = {
  enabled: true,
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
 * 0.49：平台 gateway 默认值。
 * 不写入 DEFAULT_CONFIG：未配置 `gateway` 时由组合根使用这些值。
 * `DEFAULT_SERVE_OPTIONS.port` 仍是 8642（legacy `--serve`）；拆分模式的 node 8644
 * 由 `resolveGatewayNodePorts` 按 mode 计算。
 */
export const DEFAULT_GATEWAY_OPTIONS: Required<Pick<GatewayConfig, 'hostname' | 'port'>> = {
  hostname: '127.0.0.1',
  port: 8642,
};

/**
 * 0.48 M1：插件 HTTP 反代默认限额（CONTRACT-0.48 §3.4）。
 * 不写入 DEFAULT_CONFIG：未配置时由 serve 归一化时使用这些值。
 */
export const DEFAULT_PLUGIN_HTTP_LIMITS: Required<PluginHttpLimitsConfig> = {
  maxBodyBytes: 1024 * 1024,
  maxResponseBytes: 1024 * 1024,
  timeoutMs: 10_000,
  idleTimeoutMs: 30_000,
  maxConnections: 64,
  maxFrameBytes: 1024 * 1024,
};

/**
 * 0.4 evals 默认值。
 * 不写入 DEFAULT_CONFIG：默认开启，但仍完全离线（allowNetwork 默认 false）。
 */
export const DEFAULT_EVALS_OPTIONS: Required<EvalsConfig> = {
  enabled: true,
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
  showProcessErrors: false,
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
  includeStreamChunks: false,
};

/** 安全默认值 */
export const DEFAULT_CONFIG: VesselConfig = {
  provider: {
    name: 'openai',
    temperature: 0.7,
    maxTokens: 4096,
  },
  session: {
    backend: 'file',
  },
  context: {
    maxTokens: 1_000_000,
    // 不提供默认 maxMessages：缺省时由 core 按 maxTokens 推导安全上限
    // （0.10：条数不再硬截断，超限先摘要）。显式配置仍原样透传。
    // 0.6.1 P1：默认开启压缩；有 provider summarizer 时生成真实摘要。
    autoCompact: true,
    // 0.34 S2 / R3：应用层唯一阈值来源；与 core 库兜底常量同值。
    compactThreshold: DEFAULT_COMPACT_THRESHOLD,
  },
};
