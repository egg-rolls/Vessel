/**
 * Gateway — HTTP/WS 服务网关（协议 vessel.gateway/1）
 * @module @vessel-agent/serve
 *
 * 把 runtime 的 EventStream 暴露为 WS / SSE 广播，并提供 /v1 控制端点：
 * 会话、工具、运行提交/查询/取消、权限应答、静态 web 托管。
 *
 * 设计约束：
 * - 默认只监听回环地址 127.0.0.1；远程监听必须显式 allowRemote + TLS + 显式 token；
 * - 浏览器 WS 必须在首帧 `{kind:'auth',token,since}` 鉴权，token 不接受 URL/query；
 * - 事件在传输层分配单调 seq，支持 since 回放与 gap 信号，不改 core 类型；
 * - 单 runtime / 单 WorkingContext：运行串行执行；会话切换时 clear 上下文（G2）；
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type {
  PluginHost,
  RunEvent,
  RunnableAgent,
  SessionStore,
  TraceRedactor,
  WorkingContext,
} from '@vessel-agent/core';
import { createDefaultTraceRedactor } from '@vessel-agent/core';
import { createAgentRegistry } from './agents-registry.js';
import { ClientBackpressure } from './backpressure.js';
import {
  type DurableCheckpointLike,
  type DurableGatewayOptions,
  dedupeCheckpoints,
  isResumableStatus,
  MAX_DURABLE_LIMIT,
  parseLimit,
  parseStatusFilter,
  sortCheckpoints,
  toRunSummary,
} from './durable.js';
import type { EvalsGatewayOptions } from './evals.js';
import type { EventGap, SeqEvent } from './event-buffer.js';
import { createFederationRoute, type FederationGatewayOptions } from './federation.js';
import type { FeishuGatewayOptions } from './feishu.js';
import {
  buildContentSecurityPolicy,
  corsHeaders,
  hostAllowed,
  isLoopbackAddress,
  isLoopbackHostname,
  loadTlsMaterial,
  normalizeAllowedOrigins,
  originAllowed,
} from './gateway/auth.js';
import { MethodError } from './gateway/errors.js';
import {
  eventFrame as buildEventFrame,
  gapFrame as buildGapFrame,
  helloFrame as buildHelloFrame,
  errorFrame,
  resultFrame,
} from './gateway/frames.js';
import { createAdminMethods, type GatewayReloadResult } from './gateway/methods/admin.js';
import { createAgentMethods } from './gateway/methods/agents.js';

export type { GatewayReloadResult } from './gateway/methods/admin.js';

import type { AgentControlLike } from './agent-control.js';
import {
  createConfigMethods,
  createPluginsMethods,
  createToolMethods,
  mergePluginList,
} from './gateway/methods/config.js';
import { createEvalMethods } from './gateway/methods/evals.js';
import { createFeishuMethods } from './gateway/methods/feishu.js';
import { createInteractionMethods } from './gateway/methods/interactions.js';
import { createMcpMethods } from './gateway/methods/mcp.js';
import {
  createEventsMethods,
  createMetricsMethods,
  createTraceMethods,
} from './gateway/methods/observability.js';
import {
  createPermissionsMethods,
  type PermissionsControl,
} from './gateway/methods/permissions.js';
import { createRunMethods } from './gateway/methods/runs.js';
import { createSessionMethods } from './gateway/methods/sessions.js';
import { createTeamMethods } from './gateway/methods/teams.js';
import {
  flushSseGap,
  pumpSseReplay,
  SSE_HIGH_WATER_FRAMES,
  SSE_LOW_WATER_FRAMES,
  SSE_REPLAY_BATCH,
  type SseClientState,
  type SseController,
  sendGatedSse,
  writeSse,
} from './gateway/sse.js';
import { serveStatic } from './gateway/static.js';
import { createInteractionsRegistry } from './interactions-registry.js';
import type { StoredInteraction } from './interactions-store.js';
import type { McpGatewayOptions } from './mcp.js';
import type { MetricsProvider, MetricsSnapshot } from './metrics.js';
import {
  createHubPluginEventSource,
  type PluginCatalogItem,
  type PluginHostManagerLike,
  type PluginHttpHostLike,
  type PluginHttpMatch,
  type PluginHttpRoute,
  type PluginReloadResult,
  PluginWsConnection,
  pluginErrorCodeOf,
  pluginListMetadata,
  proxyPluginHttpRequest,
} from './plugin-host/index.js';
import { pluginStaticId, servePluginAsset } from './plugin-host/static.js';
import {
  type ClientFrame,
  type NodeInfo,
  PROTOCOL_VERSION,
  type ProtocolError,
  type ProtocolInfo,
  protocolError,
  type ServerFrame,
} from './protocol.js';
import {
  type CapabilityManifest,
  createRpcDispatcher,
  defineMethods,
  hasPermission,
  type RpcDispatcher,
  RpcError,
  type RpcErrorBody,
  type RpcErrorCode,
  type RpcMethodContext,
  type RpcMethodDefinition,
  type RpcMethodTable,
  type RpcRequest,
  type RpcResponse,
} from './rpc.js';
import type { LiveRunSnapshotLike, RunControlLike, RunControlSnapshotLike } from './run-control.js';
import type { TeamControlLike } from './team-control.js';
import {
  type ConfigGatewayOptionsLike,
  DEFAULT_TENANT_ID,
  extractToken,
  type GatewayAuthLike,
  resolveLocalPrincipal,
  resolvePrincipal,
  type TenantPrincipal,
} from './tenant.js';
import type { TenantEventHub } from './tenant-event-hub.js';

// 公开导出保持不变：这些辅助函数仍可从 `@vessel-agent/serve/gateway` 导入。
export {
  buildContentSecurityPolicy,
  corsHeaders,
  isLoopbackHostname,
  normalizeAllowedOrigins,
  originAllowed,
} from './gateway/auth.js';

/** 网关启动选项 */
export interface GatewayOptions {
  /**
   * tenant 事件扇入面（必填，0.18）：tenant 流是唯一事实源。
   * 序号 / 缓冲 / 广播 / registry 都从 hub 读取；`maxHistory` 在 hub 上配置。
   */
  hub: TenantEventHub;
  /** 会话后端（可选）——/v1/sessions 数据源 */
  session?: SessionStore;
  /** 运行时（可选）——运行控制端点；结构类型 RunnableAgent（A10），不要断言成 ExecutionUnit */
  runtime?: RunnableAgent;
  /**
   * 0.27：run 控制面（app 侧适配 AgentService / scheduler）。
   * live 只读 `snapshot()`；`runs.start` / `runs.cancel` 只调 `start` / `cancel`。
   * 缺省 = `runs.*` 无 live 面（只剩 durable）。
   */
  runControl?: RunControlLike;
  /** 上下文管理器（可选）——会话切换时 clear，修跨会话串历史 */
  context?: WorkingContext;
  /** 工具宿主（可选）——缺省读 runtime.pluginHost */
  pluginHost?: PluginHost;
  /** 监听端口（默认 8642；0 = 系统分配） */
  port?: number;
  /** 监听地址（默认 127.0.0.1） */
  hostname?: string;
  /** 访问令牌（默认随机生成） */
  token?: string;
  /** 节点名（可选，展示用） */
  nodeName?: string;
  /** 节点 id；缺省随机。federation / hub 必须使用同一个值（U3） */
  nodeId?: string;
  /** 静态 web 目录（可选，托管 apps/web/dist） */
  staticDir?: string;
  /**
   * 0.43：体验型 plugin 宿主（子进程 / 动态 RPC / 静态 UI / 事件转发）。
   * 缺省 = 不挂载 `/plugins/*`，`plugins.list` 不带 contributions。
   * 与 core 的能力插件 `pluginHost` 无关。
   */
  pluginHostManager?: PluginHostManagerLike;
  /**
   * 0.48 M1：插件 HTTP 反代 provider（CONTRACT-0.48 §3）。
   * assembly 注入 `PluginHostManager`；缺省 = 插件 HTTP 面关闭。
   */
  pluginHttp?: PluginHttpHostLike;
  /**
   * 0.43 E3：`plugins.reload` 的 rescan / manager.reload 实现（asm 注入）。
   * 缺省 = `plugins.reload` 返回 not_supported；handler 成功后由 gateway 广播
   * `plugin.changed`。若同时发现 in-process 能力插件，回调须返回
   * `restart_required: true`（不得谎报已重载）。
   */
  pluginsReload?: () => Promise<PluginReloadResult>;
  /** 请求体上限（字节，默认 1 MiB） */
  maxBodyBytes?: number;
  /**
   * @deprecated 0.27：gateway 不再持有运行队列（调度归 app / AgentService，
   * 上限由 scheduler `maxQueueSize` 决定）。保留字段只为不破坏既有调用方，
   * 传入也不生效。
   */
  maxQueue?: number;
  /** 额外允许的浏览器 Origin（默认只允许同源） */
  allowedOrigins?: string[];
  /** 心跳间隔（毫秒，默认 15000） */
  heartbeatMs?: number;
  /**
   * 0.13 Addendum A：权限交互持久化目录（`<dataDir>`）。
   * 缺省 = 不落盘；asm 启动 gateway 时传入。
   */
  interactionsDir?: string;
  /** WS 首帧鉴权超时（毫秒，默认 5000） */
  authTimeoutMs?: number;
  /**
   * Bun.serve 的空闲超时（秒）。默认 0 = 不超时。
   * 事件流是长连接，不能用 Bun 的 10s 默认值；SSE 心跳 `: ping` 仍用于穿透代理。
   */
  idleTimeout?: number;
  /**
   * 显式允许非回环监听（默认 false）。
   * 非回环 hostname 必须同时给出 allowRemote=true、TLS 证书对与显式非空 token。
   */
  allowRemote?: boolean;
  /** TLS 证书对；必须成对提供，缺一即启动失败；非回环监听必填 */
  tls?: { certFile: string; keyFile: string };
  /** durable run 查询/恢复注入；缺省 = durable 端点关闭 */
  durable?: DurableGatewayOptions;
  /** MCP server 状态注入；缺省 = MCP 端点关闭 */
  mcp?: McpGatewayOptions;
  /** metrics 快照注入；缺省 = `/v1/metrics` 返回 metrics_disabled */
  metrics?: MetricsProvider;
  /** 飞书渠道状态注入；缺省 = `/v1/channels/feishu` 返回 channel_disabled */
  feishu?: FeishuGatewayOptions;
  /** evals 最近报告注入；缺省 = `/v1/evals/latest` 返回 eval_not_found */
  evals?: EvalsGatewayOptions;
  // ── 0.5 RPC / 多租户（全部可选；0.4 调用方不传即旧行为） ──
  /** token → principal（asm `GatewayAuth`）；缺省 = 旧单 token */
  auth?: GatewayAuthLike;
  /** Vessel 版本（capabilities.list） */
  version?: string;
  /** 已脱敏配置快照（asm ConfigSnapshot） */
  config?: ConfigGatewayOptionsLike;
  /**
   * 0.19 S3：本地 Team 控制面（app 注入 AgentTeamService）。
   * 缺省 = `teams.*` 仍进 manifest，但 handler 返回 `not_found`。
   */
  teams?: TeamControlLike;
  /**
   * 0.25：canonical agent 生命周期控制面（app 注入 AgentService 适配器）。
   * 缺省 = `agents.create|update|close` 仍进 manifest，但 handler 返回 `not_found`。
   */
  agent?: AgentControlLike;
  /**
   * S7：跨节点 federation 入站面（asm 归一化后注入，含已解析 peer token）。
   * 缺省 / `enabled: false` = `/v1/federation/messages` 返回 404。
   */
  federation?: FederationGatewayOptions;
  /** plugins.list / capabilities.list 数据源（单视图） */
  plugins?: () => Array<{ name: string; enabled: boolean }>;
  /**
   * 0.47：只读插件 catalog（CONTRACT-0.47 §1/§3；0.49 T3 单视图）。
   * 缺省 = `plugins.catalog` 返回空列表。
   */
  pluginCatalog?: () => PluginCatalogItem[];
  /** metrics.reset / trace 重建 */
  metricsControl?: {
    reset?(): void;
    rebuild?(): Promise<MetricsSnapshot>;
  };
  /** trace 读取 / prune（core readTraceEvents / pruneTrace，由 asm 注入） */
  trace?: {
    prune?(options: Record<string, unknown>): Promise<unknown>;
    readEvents?(filter: Record<string, unknown>): Promise<RunEvent[]>;
  };
  /**
   * 0.12 `gateway.reload`：配置 / 插件 / 权限 / 工具 / MCP 热应用实现（asm 注入）。
   * 缺省 = 未支持，调用返回 `not_supported`；不得假装需要重启的项已生效。
   */
  reload?: (scopes: string[]) => Promise<GatewayReloadResult>;
  /**
   * CONTRACT-hot-apply §7：`permissions.setToolPolicy` 的写盘面（asm 注入）。
   * 缺省 = 方法仍进 manifest，但 handler 返回 `not_supported`。
   */
  permissions?: PermissionsControl;
  /** core deleteSessionData，由 asm 注入 */
  sessionData?: {
    deleteSessionData(sessionId: string): Promise<{
      sessions_deleted: number;
      runs_deleted: number;
      events_deleted: number;
    }>;
  };
  /**
   * 方法层（`events.list` 等）脱敏；缺省 core 默认 redactor。
   * 实时广播的脱敏由 hub 的 `map` 决定——自定义时应把同一实例传给
   * `createGatewayEventHub({ redactor })`。
   */
  redactor?: TraceRedactor;
  /** 内部单 id（路径 / 配置视图用；不是 wire 字段） */
  defaultTenantId?: string;
  /**
   * 0.52：async ask 的答案投放（注入；缺省 = 只记录答案，不投放）。
   *
   * 由 app 侧实现成「把答案作为一条 user 消息投进该成员 inbox 并起一次新 run」
   * （`AgentService.admit`，与人在会话里发一句话同一条路径）。gateway 只负责去重与
   * 幂等标记，不认识 agent / inbox。
   */
  askAnswerDelivery?: (record: StoredInteraction) => Promise<boolean>;
  /**
   * 内部：只构建方法表/引擎，不调用 `Bun.serve`。
   * 由 `createLocalRpcDispatcher` 使用；外部不要设置。
   * @internal
   */
  localOnly?: boolean;
}

/**
 * 0.12 热重载可变的 gateway 配置（DECISION-023 §2.3）。
 * 目前只有 `allowed_origins` 能在不重建 runtime / 连接的情况下替换。
 */
export interface GatewayReconfigureOptions {
  /** 归一化后的 Origin 允许列表；缺省 = 保持不变。 */
  allowedOrigins?: string[];
}

/** 网关实例 */
export interface Gateway {
  port: number;
  /** 实际可访问的基址（TLS 时为 https://） */
  url: string;
  token: string;
  nodeId: string;
  protocol: ProtocolInfo;
  /** 是否启用了 TLS */
  tls: boolean;
  /**
   * 0.12 热重载 `allowed_origins`：下一次请求起生效（CORS / Origin 校验 / CSP）。
   * 不重建 SSE / WS 连接，也不改变已有连接的鉴权状态；非法列表抛错且保留旧值。
   */
  reconfigure(options: GatewayReconfigureOptions): void;
  /**
   * 进程内 dispatcher（与 asm `RpcDispatcher` 结构一致）。
   * asm 用它构造 `LocalRpcClient`；principal 缺省为本地 default/admin。
   */
  rpc: RpcDispatcher;
  /** 当前 capability manifest（capabilities.list 同源） */
  manifest(): CapabilityManifest;
  /**
   * 停止网关（0.10 R2-18）：以 `shutdown` 中断 active run 并限时等待终态，
   * 然后关闭连接。幂等；重复调用返回同一个 promise。
   */
  stop(): Promise<void>;
}

/** WS 连接自定义数据 */
interface WsData {
  authed: boolean;
  since: number;
  alive: boolean;
  authTimer?: ReturnType<typeof setTimeout>;
  backpressure: ClientBackpressure;
  /** 0.5：token 解析出的 principal；未鉴权时为 undefined */
  principal?: TenantPrincipal;
  /** events.subscribe 过滤 */
  runId?: string;
  sessionId?: string;
  types?: string[];
  /**
   * 回填页上界（additive `until_seq`）：只对**下一次** subscribe epoch 生效。
   *
   * 有界回放从最新往回取，单次最多 1 MiB / 2000 条；客户端拿到
   * `hello.from_seq` / `gap` 后可以带 `until_seq = from_seq - 1` 再订阅一次，
   * 把更早的那一段单独拉回来，逐页回退直到覆盖它需要的区间。
   * 一次性：`applyWsSubscribe` 用完即清，实时广播也不受它约束。
   */
  until?: number;
  /** 0.48 M3：插件 WS 连接；存在时该 WS 不进入 `wsClients`。 */
  pluginWs?: PluginWsConnection;
}

type Ws = import('bun').ServerWebSocket<WsData>;

/** WS 慢客户端硬关闭阈值（最终安全网） */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** WS 事件背压：高水位开始丢事件，低水位补 gap（DECISION-009 §10.3.5） */
const WS_BACKPRESSURE_HIGH = 2 * 1024 * 1024;
const WS_BACKPRESSURE_LOW = 512 * 1024;
/**
 * 单次回放的字节预算：只回放最近这段历史，更早的区间用 gap 跳过。
 *
 * 环形缓冲最多 10000 条，单条 `tool.call.completed` 可达 MB 级；长驻 gateway
 * 一次 `since=0` 全量回放可能是数百 MB。慢客户端必然触发背压丢帧 → gap →
 * 重连 → 再全量回放，形成永远追不上最新事件的循环。从最新往回取到预算为止，
 * 既保证「最新消息先到」，也把单次回放压到高水位以下。
 *
 * 预算之外更早的区间不再「不可恢复」：客户端带 `until_seq` 逐页回退（能力位
 * `events.replay-range`），每页同样受这里的预算约束 —— 分段，而不是把预算调大。
 */
const REPLAY_BUDGET_BYTES = 1024 * 1024;
/** 回放条数兜底：小事件很多时按条数收口。 */
const REPLAY_MAX_EVENTS = 2_000;
/** `run_id → session_id` 归属映射上限（LRU）。 */
const RUN_SESSION_MAP_LIMIT = 5_000;

/** 事件自带的 `session_id`；没有时返回 undefined。 */
function eventSessionId(event: RunEvent): string | undefined {
  const data = event.data;
  if (data === null || typeof data !== 'object') return undefined;
  const value = (data as Record<string, unknown>).session_id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `types` 过滤：条目以 `*` 结尾时按前缀匹配，否则精确匹配；空数组 = 不过滤。 */
function matchesTypeFilter(types: readonly string[] | undefined, type: string): boolean {
  if (types === undefined || types.length === 0) return true;
  for (const pattern of types) {
    if (pattern.endsWith('*')) {
      if (type.startsWith(pattern.slice(0, -1))) return true;
    } else if (type === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * 事件可见性：`run_id` / `session_id` / `types` 全部 AND。
 *
 * `session_id` 归属 fail-closed：既没有 `data.session_id`、映射也命不中时不发送。
 * `runSessions` 在回放期传入本次扫描的局部映射，避免依赖被裁剪后的全局 LRU。
 */
function acceptsEvent(
  event: RunEvent,
  filter: { runId?: string; sessionId?: string; types?: readonly string[] },
  runSessions: ReadonlyMap<string, string>,
  fallbackSessions?: ReadonlyMap<string, string>,
): boolean {
  if (filter.runId !== undefined && event.run_id !== filter.runId) return false;
  if (!matchesTypeFilter(filter.types, event.type)) return false;
  if (filter.sessionId !== undefined) {
    const direct = eventSessionId(event);
    if (direct !== undefined) return direct === filter.sessionId;
    const mapped = runSessions.get(event.run_id) ?? fallbackSessions?.get(event.run_id);
    return mapped === filter.sessionId;
  }
  return true;
}

/** 按 seq 顺序扫描一段回放源，重建 run → session 局部归属。 */
function buildRunSessions(items: readonly SeqEvent[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    const sessionId = eventSessionId(item.event);
    if (sessionId !== undefined) map.set(item.event.run_id, sessionId);
  }
  return map;
}

const DEFAULT_PORT = 8642;
const DEFAULT_HOSTNAME = '127.0.0.1';
const DEFAULT_MAX_BODY = 1024 * 1024;

const BASE_FEATURES = [
  'events.replay',
  // 分段回放（additive `until_seq`）：客户端可逐页拉回有界窗口之外更早的区间。
  'events.replay-range',
  'events.session-filter',
  'permissions',
  'tools',
  'static',
  'runs.async',
];

/** 生成 32 字节随机令牌（base64url） */
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 解析 since 查询参数 */
function parseSince(value: string | null): number {
  if (value === null) return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 构造 JSON 响应 */
function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

/** 构造协议错误响应 */
function errorJson(
  code: ProtocolError['code'],
  message: string,
  status: number,
  extra: Record<string, string> = {},
): Response {
  return json({ error: protocolError(code, message) }, status, extra);
}

/**
 * 浏览器请求是否同源：无 `Origin`（同源 GET / 非浏览器客户端）或与请求 URL 同源。
 * 跨源请求即使命中 `allowed_origins` 也不放行本机便利端点。
 */
function sameOriginRequest(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (origin === null || origin.trim() === '') return true;
  try {
    return new URL(origin).origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

/** 从请求体读取 JSON 对象（带大小上限） */
async function readJsonBody(
  req: Request,
  maxBytes: number,
  extra: Record<string, string> = {},
): Promise<Record<string, unknown> | Response> {
  const contentType = req.headers.get('content-type');
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
    return errorJson('invalid_request', 'Content-Type must be application/json', 415, extra);
  }
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return errorJson('payload_too_large', `Request body exceeds ${maxBytes} bytes`, 413, extra);
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return errorJson('invalid_request', 'Cannot read request body', 400, extra);
  }
  if (Buffer.byteLength(text) > maxBytes) {
    return errorJson('payload_too_large', `Request body exceeds ${maxBytes} bytes`, 413, extra);
  }
  if (text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return errorJson('invalid_request', 'Request body must be a JSON object', 400, extra);
    }
    return parsed as Record<string, unknown>;
  } catch {
    return errorJson('invalid_request', 'Invalid JSON', 400, extra);
  }
}

/** 启动本地服务网关 */
export function startGateway(opts: GatewayOptions): Gateway {
  const hub = opts.hub;
  if (
    hub === undefined ||
    typeof hub.subscribe !== 'function' ||
    typeof hub.subscribeSequenced !== 'function' ||
    typeof hub.stream !== 'function'
  ) {
    throw new Error('hub must be a TenantEventHub.');
  }
  const { session, runtime } = opts;
  const hostname = opts.hostname ?? DEFAULT_HOSTNAME;
  if (hostname.includes('/')) {
    throw new Error(`Invalid gateway hostname "${hostname}": must be a bare host or IP address.`);
  }

  const allowRemote = opts.allowRemote === true;
  const loopback = isLoopbackHostname(hostname);
  if (!loopback && !allowRemote) {
    throw new Error(
      `Refusing to listen on non-loopback hostname "${hostname}": ` +
        'set serve.allow_remote=true (and a gateway token + TLS) to expose the gateway.',
    );
  }
  // DECISION-014 §2.1：非回环必须 TLS，不提供明文逃生口。
  if (!loopback && (!opts.tls?.certFile || !opts.tls?.keyFile)) {
    throw new Error(
      `Remote mode requires TLS: configure serve.tls.cert_file and serve.tls.key_file ` +
        `when listening on non-loopback hostname "${hostname}". ` +
        'Plaintext remote listeners are not supported.',
    );
  }
  // 非回环必须提供显式 token；不允许依赖启动时自动生成的临时 token。
  const configuredToken =
    opts.token !== undefined && opts.token.trim().length > 0 ? opts.token : undefined;
  if (!loopback && configuredToken === undefined) {
    throw new Error(
      'Remote mode requires an explicit non-empty gateway token ' +
        '(serve.token, serve.tokens/admin_token, or VESSEL_GATEWAY_TOKEN).',
    );
  }
  const token = configuredToken ?? generateToken();

  const tlsMaterial = opts.tls ? loadTlsMaterial(opts.tls) : undefined;

  const defaultTenantId = opts.defaultTenantId ?? DEFAULT_TENANT_ID;
  const redactor: TraceRedactor = opts.redactor ?? createDefaultTraceRedactor();
  // 0.43：plugin 事件转发走 hub 的 raw fan-in；先过 gateway 的 redactor。
  if (opts.pluginHostManager !== undefined) {
    opts.pluginHostManager.attachEventSource(
      createHubPluginEventSource(hub, { redact: (event) => redactor.redact(event as RunEvent) }),
    );
  }
  const localPrincipal: TenantPrincipal = resolveLocalPrincipal(opts.auth, token);
  if (opts.version !== undefined && typeof opts.version !== 'string') {
    throw new Error('version must be a string.');
  }
  if (opts.auth !== undefined && typeof opts.auth.authenticate !== 'function') {
    throw new Error('auth.authenticate must be a function.');
  }
  if (opts.config !== undefined && typeof opts.config.snapshot !== 'function') {
    throw new Error('config.snapshot must be a function.');
  }
  if (opts.metricsControl?.reset !== undefined && typeof opts.metricsControl.reset !== 'function') {
    throw new Error('metricsControl.reset must be a function.');
  }
  if (
    opts.metricsControl?.rebuild !== undefined &&
    typeof opts.metricsControl.rebuild !== 'function'
  ) {
    throw new Error('metricsControl.rebuild must be a function.');
  }
  if (opts.trace?.readEvents !== undefined && typeof opts.trace.readEvents !== 'function') {
    throw new Error('trace.readEvents must be a function.');
  }
  if (opts.trace?.prune !== undefined && typeof opts.trace.prune !== 'function') {
    throw new Error('trace.prune must be a function.');
  }

  if (opts.durable !== undefined) {
    const store = opts.durable.store as { load?: unknown; list?: unknown } | undefined;
    if (!store || typeof store.load !== 'function' || typeof store.list !== 'function') {
      throw new Error('durable.store must provide load() and list().');
    }
    if (opts.durable.resume !== undefined && typeof opts.durable.resume !== 'function') {
      throw new Error('durable.resume must be a function.');
    }
  }
  if (opts.mcp !== undefined && typeof opts.mcp.listServers !== 'function') {
    throw new Error('mcp.listServers must be a function.');
  }
  if (opts.metrics !== undefined && typeof opts.metrics !== 'function') {
    throw new Error('metrics must be a function.');
  }
  if (opts.feishu !== undefined && typeof opts.feishu.status !== 'function') {
    throw new Error('feishu.status must be a function.');
  }
  if (opts.evals !== undefined && typeof opts.evals.latest !== 'function') {
    throw new Error('evals.latest must be a function.');
  }
  if (opts.federation !== undefined) {
    const federation = opts.federation;
    if (
      typeof federation.enabled !== 'boolean' ||
      typeof federation.nodeId !== 'string' ||
      !Number.isFinite(federation.maxHops) ||
      !Array.isArray(federation.peers)
    ) {
      throw new Error('federation must provide enabled, nodeId, maxHops, and peers.');
    }
    if (
      federation.rateLimitPerMinute !== undefined &&
      (!Number.isInteger(federation.rateLimitPerMinute) ||
        federation.rateLimitPerMinute < 1 ||
        federation.rateLimitPerMinute > 600)
    ) {
      throw new Error('federation.rateLimitPerMinute must be an integer between 1 and 600.');
    }
    for (const peer of federation.peers) {
      if (
        typeof peer.nodeId !== 'string' ||
        typeof peer.teamId !== 'string' ||
        typeof peer.token !== 'string'
      ) {
        throw new Error('federation peers must provide nodeId, teamId, and token.');
      }
      if (peer.allowDirectory !== undefined && typeof peer.allowDirectory !== 'boolean') {
        throw new Error('federation peers allowDirectory must be a boolean.');
      }
    }
  }

  const features = [...BASE_FEATURES];
  if (opts.durable?.store && opts.durable.resume) features.push('durable-resume');
  if (opts.mcp) features.push('mcp-status');
  if (tlsMaterial) features.push('tls');
  if (opts.evals) features.push('evals');
  // 能力位表达单执行面的真实可用性，而不是「resolver 存在」。
  const feishuChannel = opts.feishu;
  if (feishuChannel) features.push('feishu');
  if (opts.metrics) features.push('metrics');
  if (opts.config) features.push('config');
  const protocolInfo: ProtocolInfo = {
    name: 'vessel.gateway',
    version: PROTOCOL_VERSION,
    min: PROTOCOL_VERSION,
    features,
  };
  const scheme = tlsMaterial ? 'https' : 'http';

  const nodeId = opts.nodeId ?? randomUUID();
  /** 0.9 事务代际：进程启动时生成一次，随 hello / peer 记录传播（重启即变化）。 */
  const incarnation = randomUUID().replace(/-/g, '').slice(0, 12);
  const startedAt = Date.now();
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  // 0.12：可被 `reconfigure()` 热替换；后续请求在读取点看到新值。
  let allowedOrigins = normalizeAllowedOrigins(opts.allowedOrigins);
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const authTimeoutMs = opts.authTimeoutMs ?? 5_000;

  const sseClients = new Map<SseController, SseClientState>();
  const wsClients = new Set<Ws>();
  /** 0.48 M3：插件 WS（独立于事件连接；shutdown 时一并关闭）。 */
  const pluginWsClients = new Set<Ws>();

  /**
   * `run_id → session_id` 归属映射（LRU 5000）。
   *
   * 事件缺 `session_id` 时靠它把 run 生命周期事件归到会话订阅者；
   * 映射不到就不发（fail-closed），正文仍由 `sessions.get` 兜底。
   * 命中时还会把归属**补进出站副本**（见 `withSessionAttribution`），
   * 让订阅者不用自己再猜。
   */
  const runSessions = new Map<string, string>();
  /** 归属查询连续 miss 的 run id（有界负缓存，避免每条增量重扫执行面快照）。 */
  const unknownRunSessions = new Set<string>();

  function rememberRunSession(runId: unknown, sessionId: unknown): void {
    if (typeof runId !== 'string' || runId.length === 0) return;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    // 归属已确定：清掉负缓存，后续 miss 回填才有机会再试一次。
    unknownRunSessions.delete(runId);
    // Map 的插入顺序即 LRU：命中先删再插，溢出删最旧。
    if (runSessions.has(runId)) runSessions.delete(runId);
    runSessions.set(runId, sessionId);
    while (runSessions.size > RUN_SESSION_MAP_LIMIT) {
      const oldest = runSessions.keys().next().value;
      if (oldest === undefined) break;
      runSessions.delete(oldest);
    }
  }

  function rememberEventSession(event: RunEvent): void {
    const sessionId = eventSessionId(event);
    if (sessionId !== undefined) rememberRunSession(event.run_id, sessionId);
  }

  /**
   * 归属未命中时的**一次**只读回填（不阻塞发送路径）。
   *
   * LRU 只有 5000 条且**进程重启即清空**：gateway 重启时若有 run 正在跑，它的增量
   * （流式 delta / 工具事件）会因为映射未知被 fail-closed 丢掉，直到下一个带
   * `session_id` 的 `run.*` 事件把它补回来。这里在 miss 时读一次执行面的内存快照
   * （`runControl.snapshot()`，同步且有界）拿 `session_id` 并回填 LRU。
   *
   * 约束：只读、同步、best-effort —— 拿不到就返回 undefined（调用方继续 fail-closed），
   * 绝不把事件发送路径改成异步等待。命不中的 run id 记进有界负缓存，避免每条流式
   * 增量都重扫一遍快照。
   */
  function refillRunSession(runId: string): string | undefined {
    if (unknownRunSessions.has(runId)) return undefined;
    const control = opts.runControl;
    if (control === undefined) return undefined;
    let snapshot: RunControlSnapshotLike;
    try {
      snapshot = control.snapshot();
    } catch {
      return undefined;
    }
    const candidates = [...(snapshot.running ?? []), ...(snapshot.queued ?? [])];
    const hit = candidates.find((run) => run.run_id === runId);
    const sessionId = typeof hit?.session_id === 'string' ? hit.session_id : undefined;
    if (sessionId !== undefined) {
      rememberRunSession(runId, sessionId);
      return sessionId;
    }
    // 负缓存有界：溢出就清空，宁可多扫一次快照，也不让集合无限增长。
    if (unknownRunSessions.size >= RUN_SESSION_MAP_LIMIT) unknownRunSessions.clear();
    unknownRunSessions.add(runId);
    return undefined;
  }

  /**
   * 出站副本补齐会话归属（**只补不改**，缓冲里的原始事件不被修改）。
   *
   * 订阅按 `session_id` 过滤，但 `llm.stream.chunk` / `tool.call.*` 本体不带该字段：
   * 客户端拿不到归属就无法把事件挂回会话（分组被会话窗口过滤掉，表现为「run 在跑
   * 却看不到工具卡 / 思考 / 流式正文」）。事件自报的值永远优先（`??` 语义）；
   * 映射未知时原样返回，`acceptsEvent` 继续 fail-closed —— 宁可不发，也不发错归属。
   */
  function withSessionAttribution(event: RunEvent, map: ReadonlyMap<string, string>): RunEvent {
    if (eventSessionId(event) !== undefined) return event;
    const mapped = map.get(event.run_id) ?? refillRunSession(event.run_id);
    if (mapped === undefined) return event;
    const data = event.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return event;
    return { ...event, data: { ...(data as Record<string, unknown>), session_id: mapped } };
  }

  /** `runs.start` 的返回值同样能建立归属（不等 `run.started` 事件到达）。 */
  function rememberRunsStartResult(method: string, result: unknown): void {
    if (method !== 'runs.start') return;
    if (result === null || typeof result !== 'object') return;
    const record = result as Record<string, unknown>;
    rememberRunSession(record.run_id, record.session_id);
  }

  /**
   * 0.52：在途的 async 答案投放（同一次答案只投一次）。
   *
   * 同一次答案可能同时被两条路径要求投放（`ask.respond` RPC 与流上的
   * `ask.user.answered`）；它们拿到的都是同一个 promise，因此**不会投两次**。
   * 进程重启后的重放由记录里的 `answer.delivered_at` 兜底（已投放直接返回 true）。
   */
  const asyncAnswerDeliveries = new Map<string, Promise<boolean>>();

  /**
   * 0.27：交互注册表（权限 / ask）。执行、调度、run 队列都不在 gateway：
   * 它只消费 `run.*` 事件并维护 pending / answered / orphaned。
   */
  const interactions = createInteractionsRegistry({
    eventsFor: () => hub.stream(),
    singleTenantId: defaultTenantId,
    ...(opts.interactionsDir !== undefined ? { interactionsDir: opts.interactionsDir } : {}),
    // 0.52：async ask 的第一次答案 → 投放（作为 user 消息进成员 inbox + 起新 run）。
    // 与 `ask.respond` 的投放走同一个去重实现，同一次答案只投一次。
    ...(opts.askAnswerDelivery !== undefined
      ? { onAsyncAskAnswered: (record) => void deliverAsyncAskAnswer(record) }
      : {}),
  });
  /** 注册表的请求观察面：原始事件（hub 隔离订阅者异常）。 */
  const unsubscribeInteractions = hub.subscribe((event) => {
    interactions.handleEvent(event);
  });
  /**
   * 0.14 P0：agents 注册表。只吃实时事件；live run 由方法层从控制面快照合并。
   * 在事件订阅处 ingest 脱敏/裁剪后的副本，与广播保持一致。
   */
  const agentRegistry = createAgentRegistry();
  /**
   * 本进程已受理的 durable resume（快速 409，不替代 core 校验）。
   * Addendum A §2：首个调用成功，后续（含重复）一律 run_already_running。
   */
  const resumedRuns = new Set<string>();

  const pluginHost = (): PluginHost | undefined => opts.pluginHost ?? runtime?.pluginHost;

  /**
   * 节点公开信息（单执行面）：运行态与工具面都来自本进程唯一 runtime /
   * plugin host。`node_id` / `pid` / `started_at` / `endpoint` / `role` 是进程级字段。
   */
  const nodeInfo = (): NodeInfo => {
    const snapshot = runtimeSnapshot();
    const scheduler =
      typeof snapshot?.scheduler === 'object' && snapshot.scheduler !== null
        ? (snapshot.scheduler as Record<string, unknown>)
        : undefined;
    const running = Array.isArray(scheduler?.running)
      ? (scheduler.running as Array<Record<string, unknown>>)
      : [];
    const activeRunId =
      typeof snapshot?.active_run_id === 'string' ? snapshot.active_run_id : undefined;
    // active_run_id 只带 run；session 从同一 run 的 running 记录补齐。
    const activeEntry =
      activeRunId === undefined ? undefined : running.find((entry) => entry.run_id === activeRunId);
    const current = activeEntry ?? running[0];
    const currentRunId =
      activeRunId ?? (typeof current?.run_id === 'string' ? current.run_id : undefined);
    const currentSessionId =
      typeof current?.session_id === 'string' ? current.session_id : undefined;

    let tools: string[] = [];
    try {
      tools = (pluginHost()?.listTools() ?? []).map((tool) => tool.name);
    } catch {
      tools = [];
    }

    return {
      node_id: nodeId,
      // 展示名总是字符串；未注入时回退 node_id（不改变寻址键）。
      name: opts.nodeName !== undefined && opts.nodeName !== '' ? opts.nodeName : nodeId,
      pid: process.pid,
      started_at: startedAt,
      endpoint: `${scheme}://${hostname}:${actualPort}`,
      role: 'standalone',
      status: currentRunId === undefined ? 'idle' : 'busy',
      ...(currentRunId !== undefined ? { current_run_id: currentRunId } : {}),
      ...(currentSessionId !== undefined ? { current_session_id: currentSessionId } : {}),
      capabilities: {
        tools,
        max_concurrency: 1,
        protocol: PROTOCOL_VERSION,
      },
    };
  };

  // ── 事件广播：分配 seq → 扇出 ──────────────────

  function eventFrame(item: SeqEvent): ServerFrame {
    return buildEventFrame({
      nodeId,
      seq: item.seq,
      event: item.event,
      // 0.27：统一 run id —— job_id 与 core run id 同值，不再查映射。
      ...(item.event.run_id ? { jobId: item.event.run_id } : {}),
    });
  }

  function helloFrame(fromSeq: number): ServerFrame {
    // fromSeq 由回放窗口解析后传入；这里只取同一时刻的 latest / node 快照。
    const latestSeq = hub.latestSeq;
    const ts = Date.now();
    const node = nodeInfo();
    return buildHelloFrame({
      nodeId,
      protocol: protocolInfo,
      node,
      incarnation,
      fromSeq,
      latestSeq,
      ts,
    });
  }

  function gapFrame(gap: EventGap): ServerFrame {
    return buildGapFrame({ nodeId, gap });
  }

  function sendFrameText(ws: Ws, text: string): boolean {
    if (ws.readyState !== 1) {
      wsClients.delete(ws);
      return false;
    }
    if (ws.getBufferedAmount() > MAX_BUFFERED_BYTES) {
      ws.close(1013, 'slow_consumer');
      wsClients.delete(ws);
      return false;
    }
    try {
      ws.send(text);
      return true;
    } catch {
      wsClients.delete(ws);
      return false;
    }
  }

  function sendFrame(ws: Ws, frame: ServerFrame): boolean {
    return sendFrameText(ws, JSON.stringify(frame));
  }

  /** 回放窗口预算与发送复用同一字符串，避免为算大小再序列化一次。 */
  function serializeEventFrame(item: SeqEvent): string {
    return JSON.stringify(eventFrame(item));
  }

  function sendResult(ws: Ws, id: string, ok: boolean, result?: unknown, error?: ProtocolError) {
    sendFrame(ws, ok ? resultFrame({ nodeId, id, result }) : errorFrame({ nodeId, id, error }));
  }

  /**
   * 0.49 C5：读取端不按 tenant_id 过滤（单公司）。legacy id 的旧事件原样可见；
   * `all_tenants` 仍被接受，但不再参与可见性判断。
   *
   * `replaySessions` 是回放期按 seq 顺序扫描出的局部归属；缺省用全局 LRU。
   */
  function wsAccepts(
    ws: Ws,
    event: RunEvent,
    replaySessions?: ReadonlyMap<string, string>,
  ): boolean {
    return acceptsEvent(
      event,
      { runId: ws.data.runId, sessionId: ws.data.sessionId, types: ws.data.types },
      replaySessions ?? runSessions,
      replaySessions !== undefined ? runSessions : undefined,
    );
  }

  /**
   * 发送一条事件；`encoded` 来自回放窗口时直接复用（不再序列化）。
   * 背压拒收与 gap 行为与实时广播一致。
   */
  function sendEventToWs(
    ws: Ws,
    item: SeqEvent,
    replaySessions?: ReadonlyMap<string, string>,
    encoded?: string,
  ): void {
    if (!wsAccepts(ws, item.event, replaySessions)) return;
    const inflight = ws.getBufferedAmount();
    if (!ws.data.backpressure.admit(item.seq, inflight)) return;
    const gap = ws.data.backpressure.takeGap(inflight);
    if (gap) sendFrame(ws, gapFrame(gap));
    sendFrameText(ws, encoded ?? serializeEventFrame(item));
  }

  function flushWsGap(ws: Ws): void {
    const gap = ws.data.backpressure.takeGap(ws.getBufferedAmount());
    if (gap) sendFrame(ws, gapFrame(gap));
  }

  function broadcastEvent(item: SeqEvent): void {
    // 出站副本补会话归属（缓冲里的原始事件不变）：订阅侧按 session_id 过滤时，
    // 流式增量 / 工具事件本来没有该字段，补齐后订阅者才能把它们挂回会话。
    const outbound: SeqEvent = {
      ...item,
      event: withSessionAttribution(item.event, runSessions),
    };
    const encoded = serializeEventFrame(outbound);
    for (const ws of [...wsClients]) sendEventToWs(ws, outbound, undefined, encoded);
    const sseFrame = `data: ${encoded}\n\n`;
    for (const [ctrl, state] of [...sseClients]) {
      // 回放期间由 pull 驱动，避免新事件插到历史事件前面。
      if (state.replay) continue;
      // 0.49 C5：SSE 读取端不做 tenant 过滤；`accepts` 只保留 run_id / types。
      if (state.accepts && !state.accepts(item.event)) continue;
      sendGatedSse(ctrl, state, item.seq, sseFrame);
    }
  }

  interface ReplayFrame {
    item: SeqEvent;
    encoded: string;
  }

  /**
   * 有界回放窗口：从最新事件往回取，直到字节预算或条数预算用完。
   *
   * 输入必须是**过滤后**的事件（session_id / run_id / types 先过滤），这样
   * 窄订阅不会因为无关事件占满预算而拿不到自己的尾部。`encode` 的结果既用于
   * 计算字节数也用于发送。返回被跳过的最后一条 seq（`skippedTo`），调用方把它
   * 和环形缓冲自身的缺口合并成一个 gap。
   */
  function tailReplayWindow(
    items: readonly SeqEvent[],
    encode: (item: SeqEvent) => string,
  ): { frames: ReplayFrame[]; skippedTo?: number } {
    const kept: ReplayFrame[] = [];
    let bytes = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item === undefined) continue;
      const encoded = encode(item);
      const size = Buffer.byteLength(encoded, 'utf8');
      if (
        kept.length > 0 &&
        (bytes + size > REPLAY_BUDGET_BYTES || kept.length >= REPLAY_MAX_EVENTS)
      ) {
        break;
      }
      bytes += size;
      kept.push({ item, encoded });
    }
    kept.reverse();
    const first = kept[0];
    if (first === undefined) return { frames: [] };
    const oldest = items[0]?.seq;
    if (oldest === undefined || first.item.seq <= oldest) return { frames: kept };
    return { frames: kept, skippedTo: first.item.seq - 1 };
  }

  interface ReplayPlan {
    frames: ReplayFrame[];
    skippedTo?: number;
    /** 环形缓冲自身的缺口（保留区之前） */
    ringGap?: EventGap;
    /** 本次 epoch 实际会发送的第一条 seq */
    fromSeq: number;
    replaySessions: Map<string, string>;
  }

  /**
   * 把环形缺口裁进 `until` 以内：回填页只说明「本次请求区间里没发出去的那段」，
   * 不重复上报更早（不在本次请求范围）的缺口。区间整个落在缺口里时返回 undefined
   * （本页无内容），由 `fromSeq = until + 1` 告诉调用方「这里没有可拉取的事件」。
   */
  function boundGap(gap: EventGap | null, until: number | undefined): EventGap | undefined {
    if (gap === null) return undefined;
    if (until === undefined || gap.to_seq <= until) return gap;
    if (gap.from_seq > until) return undefined;
    return { from_seq: gap.from_seq, to_seq: until };
  }

  /**
   * 空窗口时的 `from_seq`：有 `until` = 「本页已覆盖到上界」（本段没有可发的事件），
   * 否则按旧语义「已追平 = latest + 1 / 空缓冲 = 0」。
   */
  function emptyFromSeq(until: number | undefined): number {
    if (until !== undefined) return until + 1;
    return hub.latestSeq === 0 ? 0 : hub.latestSeq + 1;
  }

  function planReplay(ws: Ws): ReplayPlan {
    // 分段回放（additive `until_seq`）：把回放源裁成 `since < seq <= until`。
    // 窗口仍是有界的（从 until 往回取 1 MiB / 2000 条），所以一页 = 一段更早的
    // 历史；缺省 undefined 时与旧语义逐字节等价。
    const until = ws.data.until;
    const all = hub.since(ws.data.since);
    const source = until === undefined ? all : all.filter((item) => item.seq <= until);
    // 归属先按 seq 顺序扫描完整回放源：窗口裁剪后仍能识别 run.started。
    const replaySessions = buildRunSessions(source);
    const filtered = source.filter((item) => wsAccepts(ws, item.event, replaySessions));
    // 编码时顺手补会话归属：客户端拿不到归属就无法把增量挂回会话。
    const window = tailReplayWindow(filtered, (item) =>
      serializeEventFrame({ ...item, event: withSessionAttribution(item.event, replaySessions) }),
    );
    const ringGap = boundGap(hub.gapFor(ws.data.since), until);
    return {
      ...window,
      ...(ringGap !== undefined ? { ringGap } : {}),
      fromSeq: window.frames[0]?.item.seq ?? emptyFromSeq(until),
      replaySessions,
    };
  }

  /** hello → gap → 有界回放。hello 已由调用方按 epoch 语义先发。 */
  function sendReplay(ws: Ws, plan: ReplayPlan): void {
    const gapTo = Math.max(plan.ringGap?.to_seq ?? 0, plan.skippedTo ?? 0);
    if (gapTo > 0) {
      sendFrame(
        ws,
        gapFrame({ from_seq: plan.ringGap?.from_seq ?? ws.data.since + 1, to_seq: gapTo }),
      );
    }
    for (const frame of plan.frames) {
      sendEventToWs(ws, frame.item, plan.replaySessions, frame.encoded);
    }
  }

  /** 连接级 epoch：鉴权成功后发 hello，再回放。 */
  function replayTo(ws: Ws): void {
    wsClients.add(ws);
    const plan = planReplay(ws);
    sendFrame(ws, helloFrame(plan.fromSeq));
    sendReplay(ws, plan);
  }

  /** 订阅 epoch：每次成功的 `events.subscribe` 都重新发 hello；返回该 hello 的 from_seq。 */
  function resubscribeTo(ws: Ws): number {
    const plan = planReplay(ws);
    sendFrame(ws, helloFrame(plan.fromSeq));
    sendReplay(ws, plan);
    return plan.fromSeq;
  }

  /**
   * 订阅 hub 的脱敏 / 裁剪后事件（0.18）：agent registry → 广播。
   * 序号由 hub 分配，回放与实时读同一份副本。
   */
  const unsubscribe = hub.subscribeSequenced((item) => {
    const { event: safeEvent } = item;
    // 归属先更新再广播：同一批实时事件里 session_id 订阅者不落后。
    rememberEventSession(safeEvent);
    agentRegistry.ingest(safeEvent);
    broadcastEvent(item);
  });

  // ── 运行快照（只读控制面）─────────────────────

  /** 空快照：无控制面时的 wire 形状（`active_run_id` 不出现）。 */
  function emptyRuntimeSnapshot(): Record<string, unknown> {
    return {
      scheduler: {
        as_of: Date.now(),
        queued: [],
        running: [],
        stats: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
      },
    };
  }

  /**
   * 0.27：运行态只读控制面 snapshot（scheduler 是唯一 live 事实源）。
   * 形状与原 engine 版一致；`active_run_id` = 首个 running run。
   */
  function runtimeSnapshot(): Record<string, unknown> {
    const control = opts.runControl;
    if (control === undefined) return emptyRuntimeSnapshot();
    let snapshot: RunControlSnapshotLike;
    try {
      snapshot = control.snapshot();
    } catch {
      return emptyRuntimeSnapshot();
    }
    const queued = snapshot.queued.map((run) => ({
      run_id: run.run_id,
      session_id: run.session_id,
      agent_id: run.agent_id,
      status: run.status,
      ...(run.queue_position !== undefined ? { queue_position: run.queue_position } : {}),
      ...(run.wait_reason !== undefined ? { wait_reason: run.wait_reason } : {}),
      ...(run.queued_at !== undefined ? { queued_at: run.queued_at } : {}),
    }));
    const running = snapshot.running.map((run) => ({
      run_id: run.run_id,
      session_id: run.session_id,
      agent_id: run.agent_id,
      status: run.status,
      ...(run.started_at !== undefined ? { started_at: run.started_at } : {}),
    }));
    const stats = snapshot.stats ?? {
      queued: queued.length,
      running: running.length,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    const active = snapshot.running[0];
    return {
      ...(active !== undefined ? { active_run_id: active.run_id } : {}),
      scheduler: { as_of: snapshot.as_of, queued, running, stats },
    };
  }

  /** live run（queued + running）；无控制面 = 空。 */
  function liveRuns(): LiveRunSnapshotLike[] {
    const control = opts.runControl;
    if (control === undefined) return [];
    try {
      const snapshot = control.snapshot();
      return [...snapshot.queued, ...snapshot.running];
    } catch {
      return [];
    }
  }

  // ── 0.5 RPC 方法表（E10/E11；A-3 §10.1 v1.1） ──
  // 方法按域拆到 `gateway/methods/`；这里只负责组装，保持原方法顺序。

  /** 方法表在组装完成后才有值；capabilities.list 在调用时读取。 */
  let methodTable: RpcMethodTable;

  /**
   * 0.43：capabilities / manifest 看到的表 = 静态 + 当前动态 plugin 方法。
   * 静态重名时静态胜出（动态注册表本身不会产生静态名冲突）。
   */
  const currentMethodTable = (): RpcMethodTable => {
    const dynamic = opts.pluginHostManager?.rpc.list() ?? [];
    if (dynamic.length === 0) return methodTable;
    return {
      methods: [
        ...methodTable.methods,
        ...dynamic.filter((method) => !methodTable.byName.has(method.name)),
      ],
      byName: methodTable.byName,
    };
  };

  const configMethodsDeps = {
    defaultTenantId,
    version: opts.version,
    config: opts.config,
    runtimeSnapshot,
    methodTable: currentMethodTable,
    toolDescriptions,
    plugins,
    pluginCatalog: opts.pluginCatalog ?? (() => []),
    ...(opts.pluginHostManager !== undefined
      ? {
          pluginsContributions: () => opts.pluginHostManager?.contributionsFor() ?? {},
          pluginsMetadata: () => pluginMetadata(),
        }
      : {}),
    ...(opts.pluginsReload !== undefined
      ? {
          pluginsReload: async () => {
            const reload = opts.pluginsReload as () => Promise<PluginReloadResult>;
            const result = await reload();
            broadcastPluginChanged();
            return result;
          },
        }
      : {}),
    pluginHost,
    clientCount: () => sseClients.size + wsClients.size,
    latestSeq: () => hub.latestSeq,
    protocolInfo,
    nodeInfo,
    startedAt,
  };
  const observabilityMethodsDeps = {
    redactor,
    trace: opts.trace,
    metricsControl: opts.metricsControl,
    metrics: opts.metrics,
  };

  const rpcMethods: RpcMethodDefinition[] = [
    // 顺序与拆分前一致：health → capabilities → config → sessions → runs →
    // events.list → events.subscribe → tools/plugins → metrics → mcp → trace →
    // tenants → interactions → evals → feishu → gateway。
    ...createConfigMethods(configMethodsDeps),
    ...createSessionMethods({
      sessionFor: () => session,
      sessionData: opts.sessionData,
      runStoreFor: () => opts.durable?.store,
      compactRuntime: () => runtime,
      // CREATE-0.39：sessions.create|restart|activate 与 agents.* 共用同一注入面。
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    }),
    ...createRunMethods({
      defaultTenantId,
      runControl: () => opts.runControl,
      requireRunControl: () => requireRunControl(),
      durable: () => opts.durable,
      reserveResume,
      releaseResume,
    }),
    ...createEventsMethods(observabilityMethodsDeps),
    {
      name: 'events.subscribe',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          since: { type: 'integer', minimum: 0 },
          since_ts: { type: 'integer', minimum: 0 },
          run_id: { type: 'string' },
          // S1：按会话收敛（run_id 映射 + 事件自带 session_id）。
          session_id: { type: 'string' },
          // 条目以 `*` 结尾 = 前缀匹配；空数组等价于未提供。
          types: { type: 'array', items: { type: 'string' } },
          // 分段回放（additive）：只回放 `seq <= until_seq` 的区间，用于把有界窗口
          // 之外的更早历史分页拉回。缺省 = 原语义（从 since 到最新，仍有界）。
          until_seq: { type: 'integer', minimum: 0 },
        },
      },
      result_schema: {
        type: 'object',
        required: ['subscribed', 'from_seq', 'latest_seq', 'mode'],
        properties: {
          subscribed: { type: 'boolean' },
          from_seq: { type: 'integer' },
          latest_seq: { type: 'integer' },
          mode: { type: 'string', enum: ['ws', 'stream'] },
          stream_url: { type: 'string' },
        },
      },
      handler: (params, ctx) => {
        const since = typeof params.since === 'number' ? params.since : 0;
        const mode = ctx.connection === 'ws' ? 'ws' : 'stream';
        // WS 路径由 applyWsSubscribe 用本次 epoch 实际的 hello.from_seq 覆盖后再发 res
        // （窗口需要连接过滤，handler 里拿不到）；HTTP 路径没有 hello，返回下一期望序号。
        return {
          subscribed: true,
          from_seq: since + 1,
          latest_seq: hub.latestSeq,
          mode,
          ...(ctx.connection === 'http' ? { stream_url: `/v1/events?since=${since}` } : {}),
        };
      },
    },
    ...createToolMethods(configMethodsDeps),
    ...createPluginsMethods(configMethodsDeps),
    ...createMetricsMethods(observabilityMethodsDeps),
    ...createMcpMethods({ mcp: opts.mcp }),
    ...createTraceMethods(observabilityMethodsDeps),
    ...createInteractionMethods({
      // 0.27：交互状态唯一来源是 interactions registry（执行引擎已删除）。
      respondPermission: (requestId, decision, remember, scope, actor) =>
        interactions.respondPermission(requestId, decision, remember, scope, actor),
      respondAsk: (requestId, answers, actor) => interactions.respondAsk(requestId, answers, actor),
      interactions: {
        interactionRecords: interactions.interactionRecords,
        pendingPermissions: interactions.pendingPermissions,
        pendingAsks: interactions.pendingAsks,
      },
      // 0.51 dev：headless / 超时挂起的 ask 答完之后，由这里把那个 run 续跑起来
      //（应答不再只是「被动记录」）。没有 durable 的装配保持只记录答案。
      resumeSuspendedAsk,
      // 0.52：async ask 的答案不走「续跑旧 run」（那个 run 早就结束了），
      // 而是把答案作为一条新 user 消息投给该成员并起一次新 run。
      deliverAsyncAskAnswer,
    }),
    ...createEvalMethods({ evals: opts.evals }),
    ...createFeishuMethods({ requireFeishu }),
    // 0.12：追加在表尾，不改变既有方法顺序（DECISION-023 §2.3）。
    ...createAdminMethods({ reload: opts.reload }),
    // 0.14 P0：agents 注册表（additive，排在表尾）。
    ...createAgentMethods({
      registry: agentRegistry,
      liveRuns,
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      ...(opts.teams !== undefined ? { teams: opts.teams } : {}),
      // CREATE-0.39：`agents.create{keep_messages}` 按 `sessions.get().messages` 校验。
      ...(session !== undefined ? { sessionStore: () => session } : {}),
    }),
    // 0.19 S3：本地 Team 控制面（canonical teams.*；additive，排在表尾）。
    ...createTeamMethods({ teams: opts.teams }),
    // CONTRACT-hot-apply §7：permissions.setToolPolicy（additive，排在表尾）。
    ...createPermissionsMethods({
      ...(opts.permissions !== undefined ? { permissions: opts.permissions } : {}),
      pluginHost,
    }),
  ];

  methodTable = defineMethods(rpcMethods);
  const dispatcher = createRpcDispatcher({
    table: methodTable,
    ...(opts.pluginHostManager !== undefined ? { dynamic: opts.pluginHostManager.rpc } : {}),
    localPrincipal,
    makeContext: makeMethodContext,
    version: opts.version,
    describe: () => ({
      // gateway.manifest() 是 asm local dispatcher 的只读兼容入口（单执行面）。
      tools: toolDescriptions(),
      plugins: plugins(),
    }),
    // 结果校验只在 VESSEL_VALIDATE_RESULTS=1 时触发；事件 payload 只含 method/path。
    onResultInvalid: ({ method, path }) => {
      // 可观测性（DECISION-020 §R1.8）：只记 method/path，绝不打印结果 payload。
      console.warn('[vessel] rpc.result_invalid', { method, path });
      publishDiagnostic('rpc.result_invalid', 'rpc', { method, path });
    },
  });
  let capabilityManifest: CapabilityManifest = dispatcher.manifest();
  const manifest = (): CapabilityManifest => {
    capabilityManifest = dispatcher.manifest();
    return capabilityManifest;
  };

  /**
   * P0-1：0.x legacy WS 方法 → canonical 方法名。
   * 统一交给 dispatcher，保证 principal / tenant / 权限检查与 HTTP RPC 一致。
   */
  const LEGACY_WS_METHOD_MAP: Readonly<Record<string, string>> = {
    'run.submit': 'runs.start',
    'run.get': 'runs.get',
    'run.cancel': 'runs.cancel',
    'permission.respond': 'permission.respond',
    'ask.respond': 'ask.respond',
  };

  /** canonical 错误码 → 0.4 legacy 错误码（保持旧客户端契约）。 */
  function legacyResponseCode(error: RpcErrorBody): ProtocolError['code'] {
    const details = error.details as { legacy_code?: unknown } | undefined;
    if (details && typeof details.legacy_code === 'string') {
      return details.legacy_code as ProtocolError['code'];
    }
    if (error.code === 'invalid_params') return 'invalid_request';
    if (error.code === 'conflict') return 'busy';
    return error.code as ProtocolError['code'];
  }

  async function handleWsMessage(ws: Ws, raw: string | Buffer): Promise<void> {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as ClientFrame;
    } catch {
      sendResult(ws, '', false, undefined, protocolError('invalid_request', 'Invalid JSON frame'));
      return;
    }

    if (!ws.data.authed) {
      if (frame.kind !== 'auth') {
        ws.close(4401, 'auth required');
        return;
      }
      if (frame.v !== undefined && frame.v !== PROTOCOL_VERSION) {
        ws.close(4400, 'unsupported protocol');
        return;
      }
      const principal = resolvePrincipal(
        opts.auth,
        typeof frame.token === 'string' ? frame.token : null,
        token,
      );
      if (!principal) {
        ws.close(4401, 'unauthorized');
        return;
      }
      ws.data.authed = true;
      ws.data.principal = principal;
      if (ws.data.authTimer) clearTimeout(ws.data.authTimer);
      if (typeof frame.since === 'number' && frame.since > 0) ws.data.since = frame.since;
      replayTo(ws);
      return;
    }

    ws.data.alive = true;
    if (frame.kind === 'pong') return;
    if (frame.kind !== 'req') {
      sendResult(ws, '', false, undefined, protocolError('invalid_request', 'Expected req frame'));
      return;
    }
    if (frame.method.startsWith('team.')) {
      sendResult(
        ws,
        frame.id,
        false,
        undefined,
        protocolError('method_not_allowed', 'Team protocol is 0.2 (not implemented in 0.1.0)'),
      );
      return;
    }

    const legacyMethod = LEGACY_WS_METHOD_MAP[frame.method];
    if (legacyMethod !== undefined) {
      const legacyRequest: RpcRequest = {
        v: PROTOCOL_VERSION,
        id: typeof frame.id === 'string' ? frame.id : '',
        method: legacyMethod,
        ...(frame.params !== undefined ? { params: frame.params } : {}),
      };
      const response = await dispatcher.dispatchFor(
        legacyRequest,
        ws.data.principal ?? localPrincipal,
        'ws',
      );
      if (!response.ok) {
        sendResult(
          ws,
          frame.id,
          false,
          undefined,
          protocolError(
            legacyResponseCode(response.error),
            response.error.message,
            response.error.details,
          ),
        );
        return;
      }
      rememberRunsStartResult(legacyMethod, response.result);
      // Web `getRun` 现有契约是裸 RunStatus；canonical runs.get 返回 { run }。
      const result =
        frame.method === 'run.get' &&
        response.result !== null &&
        typeof response.result === 'object' &&
        'run' in response.result
          ? (response.result as { run: unknown }).run
          : response.result;
      sendResult(ws, frame.id, true, result);
      return;
    }

    if (
      !methodTable.byName.has(frame.method) &&
      opts.pluginHostManager?.rpc.resolve(frame.method) === undefined
    ) {
      // 0.4 WS 兼容：未知方法保持 method_not_allowed（HTTP RPC 用 not_found）
      sendResult(
        ws,
        frame.id,
        false,
        undefined,
        protocolError('method_not_allowed', `Unknown method: ${frame.method}`),
      );
      return;
    }

    const request: RpcRequest = {
      v: PROTOCOL_VERSION,
      id: typeof frame.id === 'string' ? frame.id : '',
      method: frame.method,
      ...(frame.params !== undefined ? { params: frame.params } : {}),
    };
    const response = await dispatcher.dispatchFor(
      request,
      ws.data.principal ?? localPrincipal,
      'ws',
    );
    if (response.ok) {
      rememberRunsStartResult(frame.method, response.result);
      let result = response.result;
      if (frame.method === 'events.subscribe') {
        // res 与刚发送的 hello 使用同一个 plan：不重复计算 / 序列化回放窗口。
        const fromSeq = applyWsSubscribe(ws, frame.params);
        if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
          result = { ...(result as Record<string, unknown>), from_seq: fromSeq };
        }
      }
      sendResult(ws, frame.id, true, result);
    } else {
      sendResult(
        ws,
        frame.id,
        false,
        undefined,
        protocolError(
          response.error.code as ProtocolError['code'],
          response.error.message,
          response.error.details,
        ),
      );
    }
  }

  /** 应用订阅过滤并发送新的 epoch；返回本次实际会发送的第一条 seq（供 res 对齐）。 */
  function applyWsSubscribe(ws: Ws, raw: unknown): number {
    const params =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    if (typeof params.since === 'number' && params.since >= 0) ws.data.since = params.since;
    ws.data.runId = typeof params.run_id === 'string' ? params.run_id : undefined;
    ws.data.sessionId = typeof params.session_id === 'string' ? params.session_id : undefined;
    ws.data.types = Array.isArray(params.types)
      ? params.types.filter((item): item is string => typeof item === 'string')
      : undefined;
    // 空数组等价于未提供：修正旧实现「空数组拒收一切」的歧义。
    if (ws.data.types !== undefined && ws.data.types.length === 0) ws.data.types = undefined;
    // 回填页上界（additive `until_seq`）：一次性，用完即清 —— 下一次 subscribe 不带
    // 它就回到原语义（从 since 到最新），实时广播从来不受它约束。
    const untilParam = params.until_seq;
    ws.data.until = typeof untilParam === 'number' && untilParam >= 0 ? untilParam : undefined;
    const fromSeq = resubscribeTo(ws);
    ws.data.until = undefined;
    return fromSeq;
  }

  /**
   * EventSource 无法设置 Authorization：仅 GET `/v1/events`（含 0.1 别名 `/events`）
   * 允许 query token。DECISION-020 §R1.8：其余 REST/SSE 一律拒绝 `?token=`。
   */
  function queryTokenAllowed(req: Request, path: string): boolean {
    return req.method === 'GET' && (path === '/v1/events' || path === '/events');
  }

  /**
   * REST/SSE 授权：Bearer 头优先；query token 只对 SSE `/v1/events` 生效。
   * WebSocket 不走这里：必须在首帧 `{kind:'auth',token,since}` 鉴权。
   */
  function principalForRequest(req: Request, url: URL, path: string): TenantPrincipal | null {
    const queryToken = queryTokenAllowed(req, path) ? url.searchParams.get('token') : null;
    const raw = extractToken(req.headers.get('authorization'), queryToken);
    return resolvePrincipal(opts.auth, raw, token);
  }

  /** 只认 Authorization 头的请求（健康检查等非 EventSource 端点）。 */
  function headerPrincipal(req: Request): TenantPrincipal | null {
    const raw = extractToken(req.headers.get('authorization'), null);
    return resolvePrincipal(opts.auth, raw, token);
  }

  function authorized(req: Request): boolean {
    return headerPrincipal(req) !== null;
  }

  /** 插件 HTTP 并发计数（key = pluginId:routeId）；按路由限额 fail-closed。 */
  const pluginHttpActive = new Map<string, number>();

  /** 0.48 M3：插件请求审计（CONTRACT-0.48 §4.8；不含 header/body/token/query）。 */
  function auditPluginRequest(
    provider: PluginHttpHostLike,
    route: PluginHttpRoute,
    method: string,
    kind: 'http' | 'ws',
    outcome: string,
    status: number,
    startedAt: number,
  ): void {
    provider.webSockets?.audit({
      event: 'plugin.http.request',
      data: {
        plugin: route.pluginId,
        route: route.id,
        method,
        kind,
        outcome,
        status,
        durationMs: Math.max(0, Date.now() - startedAt),
      },
    });
  }

  function httpOutcome(status: number): string {
    if (status < 400) return 'ok';
    if (status === 400) return 'invalid';
    if (status === 401) return 'unauthorized';
    if (status === 403) return 'forbidden';
    if (status === 404) return 'disabled';
    if (status === 503) return 'unavailable';
    return 'error';
  }

  /**
   * 0.48 M1/M3：插件 HTTP / WS 反代（CONTRACT-0.48 §3 / §4）。
   *
   * - 形态检查（§3.3）在鉴权前：普通请求命中 upgrade 路由 → 400；反之亦然；
   * - `auth: required` 走宿主 principal + scope；其余 auth 仅内置插件（路由表已校验）；
   * - 0.49 T3：单执行面，不再有 default-tenant 403；
   * - disabled → 404，unhealthy / invalid / 无 endpoint → 503；
   * - R6：`await resolve()` 后再 `srv.upgrade()`（Bun 1.3.9 实测允许）。
   */
  async function handlePluginHttpRoute(
    req: Request,
    url: URL,
    match: PluginHttpMatch,
    extra: Record<string, string>,
    srv: { upgrade(req: Request, options?: { data?: WsData }): boolean },
  ): Promise<Response | undefined> {
    const provider = opts.pluginHttp;
    if (provider === undefined || match.kind !== 'match') {
      return errorJson('not_found', `Not found: ${url.pathname}`, 404, extra);
    }
    const { route } = match;
    const startedAt = Date.now();
    const isUpgradeRequest = (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';
    const requestKind: 'http' | 'ws' = isUpgradeRequest ? 'ws' : 'http';

    // §3.3 形态检查：升级请求命中非 upgrade 路由 / 普通请求命中 upgrade 路由。
    if (route.upgrade !== isUpgradeRequest) {
      auditPluginRequest(provider, route, req.method, requestKind, 'invalid', 400, startedAt);
      return route.upgrade
        ? errorJson('upgrade_required', 'WebSocket upgrade required', 400, extra)
        : errorJson('upgrade_not_allowed', 'WebSocket upgrade is not allowed', 400, extra);
    }

    if (route.auth === 'required') {
      const principal = principalForRequest(req, url, url.pathname);
      if (principal === null) {
        auditPluginRequest(
          provider,
          route,
          req.method,
          requestKind,
          'unauthorized',
          401,
          startedAt,
        );
        return errorJson('unauthorized', 'Missing or invalid token', 401, extra);
      }
      if (!hasPermission(principal.role, route.scope)) {
        auditPluginRequest(provider, route, req.method, requestKind, 'forbidden', 403, startedAt);
        return errorJson('forbidden', `Requires ${route.scope} permission`, 403, extra);
      }
    }

    const key = `${route.pluginId}:${route.id}`;
    const active = pluginHttpActive.get(key) ?? 0;
    if (route.limits.maxConnections !== null && active >= route.limits.maxConnections) {
      if (route.upgrade) provider.webSockets?.rejected(route.pluginId);
      auditPluginRequest(provider, route, req.method, requestKind, 'busy', 503, startedAt);
      return errorJson('busy', 'Plugin HTTP connection limit reached', 503, extra);
    }
    pluginHttpActive.set(key, active + 1);

    let handedOff = false;
    const releaseSlot = (): void => {
      const remaining = (pluginHttpActive.get(key) ?? 1) - 1;
      if (remaining <= 0) pluginHttpActive.delete(key);
      else pluginHttpActive.set(key, remaining);
    };

    try {
      const resolution = await provider.resolve(route.pluginId);
      if (resolution.kind === 'disabled') {
        auditPluginRequest(provider, route, req.method, requestKind, 'disabled', 404, startedAt);
        return errorJson('not_found', `Not found: ${url.pathname}`, 404, extra);
      }
      if (resolution.kind === 'unavailable') {
        auditPluginRequest(provider, route, req.method, requestKind, 'unavailable', 503, startedAt);
        return errorJson('internal', 'Plugin HTTP surface is unavailable', 503, extra);
      }

      if (!route.upgrade) {
        const response = await proxyPluginHttpRequest({
          request: req,
          url,
          route,
          target: resolution.target,
          cors: extra,
        });
        auditPluginRequest(
          provider,
          route,
          req.method,
          'http',
          httpOutcome(response.status),
          response.status,
          startedAt,
        );
        return response;
      }

      // M3：先 resolve 再 upgrade（R6 已实测允许）；连接关闭时才归还槽位。
      const connection = new PluginWsConnection({
        route,
        target: resolution.target,
        path: `${url.pathname}${url.search}`,
        headers: req.headers,
        releaseSlot,
        accounting: provider.webSockets,
      });
      const upgraded = srv.upgrade(req, {
        data: {
          authed: true,
          since: 0,
          alive: true,
          backpressure: new ClientBackpressure({
            high: WS_BACKPRESSURE_HIGH,
            low: WS_BACKPRESSURE_LOW,
          }),
          pluginWs: connection,
        },
      });
      if (!upgraded) {
        provider.webSockets?.rejected(route.pluginId);
        auditPluginRequest(provider, route, req.method, 'ws', 'invalid', 400, startedAt);
        return errorJson('invalid_request', 'WebSocket upgrade failed', 400, extra);
      }
      handedOff = true;
      auditPluginRequest(provider, route, req.method, 'ws', 'accepted', 101, startedAt);
      return undefined;
    } finally {
      if (!handedOff) releaseSlot();
    }
  }

  /** 方法级上下文（单执行面，无 tenant 作用域） */
  function makeMethodContext(
    _method: RpcMethodDefinition,
    _params: Record<string, unknown>,
    principal: TenantPrincipal,
    connection: RpcMethodContext['connection'],
  ): RpcMethodContext {
    return {
      principal,
      isAdmin: principal.role === 'admin',
      connection,
    };
  }

  /** 单执行面的 run 控制面；缺失保持 0.4 `no_runtime` 语义。 */
  function requireRunControl(): RunControlLike {
    if (opts.runControl !== undefined) return opts.runControl;
    throw new RpcError('forbidden', 'No runtime configured', { legacy_code: 'no_runtime' });
  }

  /** 飞书渠道未配置 → 0.4 not_found */
  function requireFeishu(): FeishuGatewayOptions {
    if (opts.feishu !== undefined) return opts.feishu;
    throw new RpcError('not_found', 'Feishu channel is not enabled');
  }

  /** capabilities.list 的 tools（单执行面的 plugin host） */
  function toolDescriptions(): Array<{ name: string; description?: string }> {
    try {
      return (pluginHost()?.listTools() ?? []).map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
      }));
    } catch {
      return [];
    }
  }

  /** 单视图 plugins.list 数据源。 */
  function plugins(): Array<{ name: string; enabled: boolean }> {
    return opts.plugins?.() ?? [];
  }

  /** `plugins.list` 形状（含 E1 contributions）；`plugin.changed` 复用同一快照。 */
  function pluginListPayload(): {
    plugins: ReturnType<typeof mergePluginList>;
  } {
    return {
      plugins: mergePluginList(
        plugins(),
        opts.pluginHostManager?.contributionsFor(),
        pluginMetadata(),
      ),
    };
  }

  /** E10：manager 的 version / mode / status（与 plugins.list 同源）。 */
  function pluginMetadata(): ReturnType<typeof pluginListMetadata> {
    return pluginListMetadata(opts.pluginHostManager?.statuses() ?? []);
  }

  /** 0.43 E3：reload 后向单运行时流广播 `plugin.changed`（best-effort）。 */
  function broadcastPluginChanged(): void {
    const stream = hub.stream();
    if (stream === undefined) return;
    try {
      stream.publish({
        type: 'plugin.changed',
        run_id: 'plugin',
        data: pluginListPayload(),
        ts: Date.now(),
      });
    } catch {
      // 广播失败不影响 reload 结果
    }
  }

  // ── federation 入站与诊断事件 ──────────────────

  /** 诊断事件：投单运行时流；流不存在时直接丢弃——诊断失败不得影响主流程。 */
  function publishDiagnostic(type: string, runId: string, data: Record<string, unknown>): void {
    const stream = hub.stream();
    if (!stream) return;
    try {
      stream.publish({ type, run_id: runId, data, ts: Date.now() });
    } catch {
      // 诊断事件 best-effort
    }
  }

  /** 发布 federation 事件（core 内部 camelCase；gateway 边界统一转 snake_case） */
  function publishFederationEvent(type: string, data: Record<string, unknown>): void {
    publishDiagnostic(type, 'federation', data);
  }

  const federationRoute = createFederationRoute({
    ...(opts.federation !== undefined ? { federation: opts.federation } : {}),
    ...(opts.teams !== undefined ? { teams: opts.teams } : {}),
    publish: publishFederationEvent,
  });

  // ── 0.3 durable / MCP 端点 ─────────────────────

  /** core RunResumeError / 注入错误 → HTTP；未知 code 一律 500 */
  function resumeErrorResponse(error: unknown, extra: Record<string, string>): Response {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    switch (code) {
      case 'run_not_found':
        return errorJson('run_not_found', message, 404, extra);
      case 'run_not_resumable':
        return errorJson('run_not_resumable', message, 409, extra);
      case 'run_already_running':
        return errorJson('run_already_running', message, 409, extra);
      case 'run_store_required':
        return errorJson('durable_disabled', message, 503, extra);
      case 'agent_not_found':
        return errorJson('agent_not_found', message, 404, extra);
      default:
        return errorJson('internal', 'Failed to resume run', 500, extra);
    }
  }

  /**
   * 原子占位（在第一个 await 之前调用）：同一 run 只允许一个在途 resume。
   * 返回 false 表示已被占用 → 409 run_already_running。
   * 上限 1000，防 Set 无界增长。
   */
  function reserveResume(runId: string): boolean {
    if (resumedRuns.has(runId)) return false;
    resumedRuns.add(runId);
    while (resumedRuns.size > 1000) {
      const first = resumedRuns.keys().next();
      if (first.done) break;
      // 刚占位的在尾部，淘汰最旧的条目（极小概率淘汰到另一个在途 run）
      if (first.value === runId) break;
      resumedRuns.delete(first.value);
    }
    return true;
  }

  /** resume 失败时释放占位；成功占位保留，重复调用一律 conflict。 */
  function releaseResume(runId: string): void {
    resumedRuns.delete(runId);
  }

  /**
   * 在途的「挂起 ask 自动续跑」（0.51 dev）。
   *
   * 与 `resumedRuns` 分开：后者的语义是「本进程已受理过 `runs.resume`，后续一律
   * conflict」，而同一个 run 会因为下一次 ask 再次挂起、需要第二次续跑（resume 保持
   * run id 不变），所以自动路径只在「这次续跑还没跑完」期间占位，结束后释放。
   */
  const autoResuming = new Set<string>();

  /**
   * 该 session 现在是否已有 live run（queued / running）。
   *
   * 快照读不出来时按「没有」处理：单 run 的权威判据在 core，这里只是提前避开
   * 一次注定失败的 resume（失败也已 fail-closed）。
   */
  function hasLiveRunForSession(sessionId: string): boolean {
    const control = opts.runControl;
    if (control === undefined) return false;
    try {
      const snapshot = control.snapshot();
      return [...snapshot.queued, ...snapshot.running].some((run) => run.session_id === sessionId);
    } catch {
      // 快照读不出来时不赌：让 core 的单 run 守卫去判（那里是权威）。
      return false;
    }
  }

  /**
   * headless / 超时挂起的 ask 被回答后，尝试续跑那个 run（0.51 dev）。
   *
   * 全部前置都成立才受理，任何一条不成立都返回 `false`（**只记录答案**，
   * 不报错、不回滚、不重试）：
   * 1. durable 已启用且注入了 resume 适配器；
   * 2. checkpoint 能加载，且仍是 `interrupted`（`running` 说明别人已经在跑）；
   * 3. 记录与 checkpoint 指向同一个 session（防串台）；
   * 4. 该 session 没有别的 live run（同 session 并发会撞 core 的单 run 守卫）；
   * 5. 同一 run 没有在途的自动续跑（本进程内去重）。
   *
   * 答案如何进入被恢复的 run 不在这里：沿用既有 `--resume-run` 路径，
   * `startResume` 在 resume 前把已回答的 ask 作为 `source=ask_resume` 的
   * `user.message` 事件注入 session 日志（按 `request_id` 去重，ADR-082 Errata）。
   */
  async function resumeSuspendedAsk(record: StoredInteraction): Promise<boolean> {
    const durableStore = opts.durable;
    if (durableStore?.resume === undefined) return false;
    const runId = record.run_id;
    if (runId === '' || autoResuming.has(runId)) return false;
    autoResuming.add(runId);
    try {
      let checkpoint: DurableCheckpointLike | null = null;
      try {
        checkpoint = await durableStore.store.load(runId);
      } catch (error) {
        console.warn('[vessel] ask.respond: checkpoint load failed; answer recorded only', {
          run_id: runId,
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      if (checkpoint === null) return false;
      // 只接管「已挂起、没人跑」的 run；resume 适配器自己也会再校验一次。
      if (checkpoint.status !== 'interrupted') return false;
      if (record.session_id !== undefined && record.session_id !== checkpoint.session_id) {
        return false;
      }
      if (hasLiveRunForSession(checkpoint.session_id)) return false;
      await durableStore.resume(runId);
      return true;
    } catch (error) {
      // fail-closed：答案已经落定，续跑失败不得冒泡到 RPC（也不重试）。
      console.warn('[vessel] ask.respond: resume failed; answer recorded only', {
        run_id: runId,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      autoResuming.delete(runId);
    }
  }

  /**
   * async ask 的答案投放：把答案作为一条 user 消息投给提问的成员，并起一次新 run。
   *
   * 全部前置不成立时返回 `false`（**只记录答案**，不报错、不回滚、不重试）：
   * 1. app 侧注入了投放实现（`askAnswerDelivery`）；
   * 2. 记录已 answered 且**尚未投放过**（`answer.delivered_at` 缺失）；
   * 3. 记录带 `agent_id`（成员 bridge 补齐；没有归属就找不到投递目标）。
   *
   * 投放成功后才写 `delivered_at`：写失败只意味着下一次重复应答可能重复投递一次，
   * 而不写的话「投放 → 崩溃 → 重放」会稳定丢答案（选前者：多一条消息 vs 丢答案）。
   */
  function deliverAsyncAskAnswer(record: StoredInteraction): Promise<boolean> {
    const existing = asyncAnswerDeliveries.get(record.requestId);
    if (existing !== undefined) return existing;
    const task = (async (): Promise<boolean> => {
      const deliver = opts.askAnswerDelivery;
      if (deliver === undefined) return false;
      const current = interactions.interactionRecords.get(record.requestId);
      const target = current ?? record;
      if (target.answer?.delivered_at !== undefined) return true;
      if (target.agent_id === undefined || target.agent_id === '') return false;
      let delivered = false;
      try {
        delivered = (await deliver(target)) === true;
      } catch (error) {
        console.warn('[vessel] ask answer delivery failed; answer recorded only', {
          request_id: target.requestId,
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      if (delivered) interactions.markAnswerDelivered(target.requestId, Date.now());
      return delivered;
    })();
    asyncAnswerDeliveries.set(record.requestId, task);
    void task.finally(() => {
      if (asyncAnswerDeliveries.get(record.requestId) === task) {
        asyncAnswerDeliveries.delete(record.requestId);
      }
    });
    return task;
  }

  /** `/v1/durable/*`：只读 store，不写盘、不创建 run */
  async function handleDurable(
    req: Request,
    url: URL,
    path: string,
    extra: Record<string, string>,
    principal: TenantPrincipal,
  ): Promise<Response | null> {
    if (path !== '/v1/durable' && !path.startsWith('/v1/durable/')) return null;
    // P0-2/P1：durable store 是单执行面的。
    const durable = opts.durable;
    const missingStore = (): Response =>
      errorJson('durable_disabled', 'Durable runs are not enabled', 503, extra);

    if (path === '/v1/durable/runs') {
      if (req.method !== 'GET') {
        return errorJson('method_not_allowed', 'Method not allowed', 405, extra);
      }
      if (!durable) return missingStore();
      const statuses = parseStatusFilter(url.searchParams.get('status'));
      if (statuses === null) {
        return errorJson('invalid_request', 'Invalid status filter', 400, extra);
      }
      const limit = parseLimit(url.searchParams.get('limit'));
      if (limit === null) {
        return errorJson(
          'invalid_request',
          `limit must be an integer between 1 and ${MAX_DURABLE_LIMIT}`,
          400,
          extra,
        );
      }
      const sessionId = url.searchParams.get('session_id');
      if (sessionId !== null && sessionId.length === 0) {
        return errorJson('invalid_request', 'session_id must be a non-empty string', 400, extra);
      }
      try {
        const base = { limit, ...(sessionId !== null ? { session_id: sessionId } : {}) };
        const checkpoints =
          statuses.length === 0
            ? await durable.store.list(base)
            : (
                await Promise.all(statuses.map((status) => durable.store.list({ ...base, status })))
              ).flat();
        const runs = sortCheckpoints(dedupeCheckpoints(checkpoints))
          .slice(0, limit)
          .map(toRunSummary);
        return json({ runs }, 200, extra);
      } catch {
        return errorJson('internal', 'Failed to list durable runs', 500, extra);
      }
    }

    const resumeMatch = path.match(/^\/v1\/durable\/runs\/([^/]+)\/resume$/);
    if (resumeMatch) {
      if (req.method !== 'POST') {
        return errorJson('method_not_allowed', 'Method not allowed', 405, extra);
      }
      if (!durable) return missingStore();
      if (!durable.resume) {
        return errorJson(
          'durable_disabled',
          'Durable resume is not available in this mode',
          503,
          extra,
        );
      }
      // P0-2：resume 会启动 run，必须 write 及以上。
      if (!hasPermission(principal.role, 'write')) {
        return errorJson('forbidden', 'Durable resume requires write permission', 403, extra);
      }
      let runId: string;
      try {
        runId = decodeURIComponent(resumeMatch[1] ?? '');
      } catch {
        return errorJson('invalid_request', 'Invalid run id', 400, extra);
      }
      if (runId.length === 0 || runId.length > 256) {
        return errorJson('invalid_request', 'run id must be 1..256 characters', 400, extra);
      }
      // 原子占位必须在任何 await 之前：否则两个并发请求会同时通过检查。
      if (!reserveResume(runId)) {
        return errorJson(
          'run_already_running',
          `Run is already being resumed: ${runId}`,
          409,
          extra,
        );
      }

      let checkpoint: Awaited<ReturnType<typeof durable.store.load>>;
      try {
        checkpoint = await durable.store.load(runId);
      } catch (error) {
        // 预检失败必须释放占位，允许后续重试
        resumedRuns.delete(runId);
        return resumeErrorResponse(error, extra);
      }
      if (!checkpoint) {
        resumedRuns.delete(runId);
        return errorJson('run_not_found', `Run not found: ${runId}`, 404, extra);
      }
      if (!isResumableStatus(checkpoint.status)) {
        resumedRuns.delete(runId);
        return errorJson('run_not_resumable', `Run is not resumable: ${runId}`, 409, extra);
      }

      try {
        await durable.resume(runId);
      } catch (error) {
        // 适配器失败释放占位，允许重试
        resumedRuns.delete(runId);
        return resumeErrorResponse(error, extra);
      }
      return json({ run_id: runId, status: 'queued' }, 202, extra);
    }

    return errorJson('not_found', `Not found: ${path}`, 404, extra);
  }

  /** `/v1/mcp/*`：只读状态，未注入返回稳定 mcp_disabled */
  async function handleMcp(
    req: Request,
    path: string,
    extra: Record<string, string>,
    principal: TenantPrincipal,
  ): Promise<Response | null> {
    if (path !== '/v1/mcp' && !path.startsWith('/v1/mcp/')) return null;
    if (path !== '/v1/mcp/servers') {
      return errorJson('not_found', `Not found: ${path}`, 404, extra);
    }
    if (req.method !== 'GET') {
      return errorJson('method_not_allowed', 'Method not allowed', 405, extra);
    }
    try {
      return json(await callMethod('mcp.list', {}, principal), 200, extra);
    } catch (error) {
      if (error instanceof LegacyRpcError && error.code === 'not_found') {
        return errorJson('mcp_disabled', 'MCP status is not enabled', 503, extra);
      }
      return legacyErrorResponse(error, extra);
    }
  }

  // ── 0.4 metrics / feishu / evals 端点 ──

  const methodNotAllowed = (extra: Record<string, string>): Response =>
    errorJson('method_not_allowed', 'Method not allowed', 405, extra);

  /** `/v1/metrics`：只读快照 */
  async function handleMetrics(
    req: Request,
    path: string,
    extra: Record<string, string>,
    principal: TenantPrincipal,
  ): Promise<Response | null> {
    if (path !== '/v1/metrics') return null;
    if (req.method !== 'GET') return methodNotAllowed(extra);
    try {
      return json(await callMethod('metrics.get', { source: 'live' }, principal), 200, extra);
    } catch (error) {
      if (error instanceof LegacyRpcError && error.code === 'not_found') {
        return errorJson('metrics_disabled', 'Metrics are not enabled', 503, extra);
      }
      return legacyErrorResponse(error, extra);
    }
  }

  /** `/v1/channels/feishu`：只读状态，凭据二次掩码 */
  async function handleFeishu(
    req: Request,
    path: string,
    extra: Record<string, string>,
    principal: TenantPrincipal,
  ): Promise<Response | null> {
    if (path !== '/v1/channels/feishu') return null;
    if (req.method !== 'GET') return methodNotAllowed(extra);
    try {
      return json(await callMethod('feishu.status', {}, principal), 200, extra);
    } catch (error) {
      if (error instanceof LegacyRpcError && error.code === 'not_found') {
        return errorJson('channel_disabled', 'Feishu channel is not enabled', 503, extra);
      }
      return legacyErrorResponse(error, extra);
    }
  }

  const SAFE_SUITE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

  /** `/v1/evals/latest?suite=`：只读最近一次报告 */
  async function handleEvals(
    req: Request,
    url: URL,
    path: string,
    extra: Record<string, string>,
    principal: TenantPrincipal,
  ): Promise<Response | null> {
    if (path !== '/v1/evals/latest') return null;
    if (req.method !== 'GET') return methodNotAllowed(extra);
    const suite = (url.searchParams.get('suite') ?? '').trim();
    if (suite.length === 0) {
      return errorJson('invalid_request', 'suite is required', 400, extra);
    }
    if (!SAFE_SUITE_NAME.test(suite) || suite.includes('..')) {
      return errorJson('invalid_request', 'Invalid suite name', 400, extra);
    }
    try {
      return json(await callMethod('evals.latest', { suite }, principal), 200, extra);
    } catch (error) {
      if (error instanceof LegacyRpcError) {
        if (error.code === 'not_found') {
          return errorJson('eval_not_found', error.message, 404, extra);
        }
        if (error.code === 'invalid_request') {
          return errorJson('invalid_request', error.message, 400, extra);
        }
      }
      return errorJson('internal', 'Failed to read eval report', 500, extra);
    }
  }

  /** 轮询 peer 表，发布 join/left（失败只记录，不影响 v1） */
  /** 旧 REST 适配器的错误载体（保持 0.4 错误码） */
  class LegacyRpcError extends Error {
    constructor(
      readonly code: ProtocolError['code'],
      message: string,
    ) {
      super(message);
      this.name = 'LegacyRpcError';
    }
  }

  function legacyStatus(code: ProtocolError['code'] | RpcErrorCode, fallback = 400): number {
    switch (code) {
      case 'unauthorized':
        return 401;
      case 'forbidden':
        return 403;
      case 'not_found':
      case 'run_not_found':
      case 'eval_not_found':
        return 404;
      // CONTRACT-0.34-context C7：legacy REST 适配 canonical sessions.compact 时
      // 语义与 canonical 错误一致：会话不存在 = 404，压缩不可用 = 409。
      case 'session_not_found':
        return 404;
      case 'method_not_allowed':
        return 405;
      case 'conflict':
      case 'run_already_running':
      case 'data_locked':
      case 'compact_unavailable':
        return 409;
      case 'busy':
        return 429;
      case 'quota_exceeded':
      case 'payload_too_large':
        return code === 'quota_exceeded' ? 429 : 413;
      case 'expired':
      case 'run_ended':
        // 410 Gone：请求存在过，但已过期/已取消/所属 run 已结束。
        return 410;
      case 'internal':
        return 500;
      default:
        return fallback;
    }
  }

  function legacyErrorResponse(
    error: unknown,
    extra: Record<string, string>,
    fallback = 400,
  ): Response {
    if (error instanceof LegacyRpcError) {
      return errorJson(error.code, error.message, legacyStatus(error.code, fallback), extra);
    }
    if (error instanceof MethodError) {
      return errorJson(error.code, error.message, legacyStatus(error.code, fallback), extra);
    }
    return errorJson('internal', 'Gateway operation failed', 500, extra);
  }

  /** 旧 REST → canonical 方法；错误码映射回 0.4 */
  async function callMethod(
    method: string,
    params: Record<string, unknown>,
    principal: TenantPrincipal,
  ): Promise<unknown> {
    const response = await dispatcher.dispatchFor(
      { v: PROTOCOL_VERSION, id: randomUUID(), method, params },
      principal,
      'http',
    );
    if (response.ok) {
      rememberRunsStartResult(method, response.result);
      return response.result;
    }
    // 0.4 兼容：default tenant 未配置 session backend 时旧路径返回 invalid_request。
    if (
      response.error.code === 'internal' &&
      response.error.message === 'No session backend configured'
    ) {
      throw new LegacyRpcError('invalid_request', response.error.message);
    }
    const details = response.error.details as { legacy_code?: unknown } | undefined;
    const legacy =
      details && typeof details.legacy_code === 'string'
        ? (details.legacy_code as ProtocolError['code'])
        : response.error.code === 'invalid_params'
          ? 'invalid_request'
          : response.error.code === 'conflict'
            ? 'conflict'
            : (response.error.code as ProtocolError['code']);
    throw new LegacyRpcError(legacy, response.error.message);
  }

  /** POST /v1/rpc：信封校验 → dispatcher；方法错误 HTTP 200 + ok:false */
  async function handleRpc(
    req: Request,
    principal: TenantPrincipal,
    extra: Record<string, string>,
  ): Promise<Response> {
    const rpcFailure = (
      id: string,
      code: 'invalid_params' | 'payload_too_large',
      message: string,
      status: number,
    ): Response =>
      json({ v: PROTOCOL_VERSION, id, ok: false, error: { code, message } }, status, extra);

    let text: string;
    try {
      text = await req.text();
    } catch {
      return rpcFailure('', 'invalid_params', 'Failed to read request body', 400);
    }
    if (new TextEncoder().encode(text).byteLength > maxBodyBytes) {
      return rpcFailure('', 'payload_too_large', 'Request body too large', 413);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return rpcFailure('', 'invalid_params', 'Invalid JSON', 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return rpcFailure('', 'invalid_params', 'Request body must be an object', 400);
    }
    const record = body as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    if (record.v !== PROTOCOL_VERSION) {
      return rpcFailure(id, 'invalid_params', 'v must be 1', 400);
    }
    if (id.length === 0) {
      return rpcFailure('', 'invalid_params', 'id is required', 400);
    }
    if (typeof record.method !== 'string' || record.method.length === 0) {
      return rpcFailure(id, 'invalid_params', 'method is required', 400);
    }

    const request: RpcRequest = {
      v: PROTOCOL_VERSION,
      id,
      method: record.method,
      ...(record.params !== undefined ? { params: record.params } : {}),
    };
    const response: RpcResponse = await dispatcher.dispatchFor(request, principal, 'http');
    if (response.ok) rememberRunsStartResult(request.method, response.result);
    return json(response, 200, extra);
  }

  function reconfigure(next: GatewayReconfigureOptions): void {
    // 先归一化再赋值：非法输入抛错时保留旧 allowlist（不做半更新）。
    if (next.allowedOrigins !== undefined) {
      allowedOrigins = normalizeAllowedOrigins(next.allowedOrigins);
    }
  }

  const serveOptions: Bun.Serve.Options<WsData> = {
    port: opts.port ?? DEFAULT_PORT,
    hostname,
    // 0 = 禁用空闲超时（已用 Bun 1.3.9 实测：SSE 12s 不中断）。
    // 事件流/WS 都是长连接；心跳仍负责穿透代理与检测死客户端。
    idleTimeout: opts.idleTimeout ?? 0,
    ...(tlsMaterial ? { tls: tlsMaterial } : {}),
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const extra = corsHeaders(req, allowedOrigins);

      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: { Allow: 'GET, POST, OPTIONS', ...extra },
        });
      }

      if (!hostAllowed(req, hostname)) {
        return errorJson('invalid_host', 'Host header is not allowed', 403, extra);
      }
      if (!originAllowed(req, allowedOrigins)) {
        return errorJson('forbidden_origin', 'Origin is not allowed', 403, extra);
      }

      const requestedProtocol =
        req.headers.get('x-vessel-protocol') ?? url.searchParams.get('protocol');
      if (requestedProtocol !== null && requestedProtocol !== String(PROTOCOL_VERSION)) {
        return errorJson(
          'unsupported_protocol',
          `Unsupported protocol version: ${requestedProtocol}`,
          426,
          extra,
        );
      }

      // 健康检查：/health 始终开放；远程模式下 /v1/health 也要求 token
      if (path === '/health' || path === '/v1/health') {
        if (path === '/v1/health' && allowRemote && !authorized(req)) {
          return errorJson('unauthorized', 'Missing or invalid token', 401, extra);
        }
        const base = {
          status: 'ok',
          clients: sseClients.size + wsClients.size,
          latest_seq: hub.latestSeq,
        };
        if (path === '/health') return json(base, 200, extra);
        return json(
          {
            ...base,
            protocol: protocolInfo,
            node: nodeInfo(),
            started_at: startedAt,
          },
          200,
          extra,
        );
      }

      // 0.35：本机 WebUI 自动连接。只在**回环 socket + 同源（或无 Origin）**时返回
      // 显式配置的 legacy token；永不下发启动时自动生成的临时 token，也不带任何 CORS 头。
      // 安全边界：本机任意进程都能直接拿到该 token（回环便利的固有代价）——这是
      // 本机使用便利，不是远程能力；远程监听仍必须显式 token + TLS。
      if (path === '/v1/local/token') {
        if (req.method !== 'GET') {
          return errorJson('method_not_allowed', 'Only GET is allowed', 405, { Allow: 'GET' });
        }
        if (!isLoopbackAddress(srv.requestIP(req)?.address)) {
          return errorJson('forbidden', 'Local token is only available on loopback', 403);
        }
        // 反代 / 通配监听时，客户端 IP 仍可能是回环；Host 也必须是回环，
        // 否则代理域名下的页面会拿到 token。
        const host = req.headers.get('host');
        let hostName: string | null = null;
        try {
          hostName = host === null ? null : new URL(`http://${host}`).hostname;
        } catch {
          hostName = null;
        }
        if (hostName === null || !isLoopbackHostname(hostName)) {
          return errorJson('forbidden', 'Local token requires a loopback Host', 403);
        }
        if (!sameOriginRequest(req)) {
          return errorJson('forbidden', 'Local token requires a same-origin request', 403);
        }
        // 只下发显式 legacy gateway token（serve.token / token_env / VESSEL_GATEWAY_TOKEN）。
        // `serve.tokens`-only 时 `auth.legacyToken` 是首条客户端 token，不在此暴露；
        // 未配置时内部生成的临时 token 也绝不泄露（404 让前端安静回退到手动表单）。
        const localToken = configuredToken;
        if (localToken === undefined) return json({ token: null }, 404);
        return json({ token: localToken }, 200);
      }

      const isWebSocket = (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';

      // S7：federation 入站（独立 peer bearer；非该路径返回 null）。
      const federationResponse = await federationRoute.handle(req, extra);
      if (federationResponse !== null) return federationResponse;

      // WS：/v1/events（/ws 为 0.1.0 兼容别名）。
      // ADR-053：token 不进 URL/query，只接受首帧 `{kind:'auth',token,since}`。
      // `?since=N` 仍保留为回放兼容参数；auth 首帧的 since 优先。
      if ((path === '/v1/events' || path === '/ws') && isWebSocket) {
        if (url.searchParams.has('token')) {
          return errorJson(
            'invalid_request',
            'WebSocket auth must use the first auth frame; token in query is not supported',
            400,
            extra,
          );
        }
        const upgraded = srv.upgrade(req, {
          data: {
            authed: false,
            since: parseSince(url.searchParams.get('since')),
            alive: true,
            backpressure: new ClientBackpressure({
              high: WS_BACKPRESSURE_HIGH,
              low: WS_BACKPRESSURE_LOW,
            }),
          },
        });
        if (!upgraded) return errorJson('invalid_request', 'WebSocket upgrade failed', 400, extra);
        return;
      }

      // 0.48 M1：插件 HTTP 路由。插入点在 Host/Origin/protocol 与宿主路由之后、
      // 静态 SPA 之前；插件路径永不进入 serveStatic。冲突时路由表为空。
      if (opts.pluginHttp !== undefined) {
        const pluginMatch = opts.pluginHttp.match(req.method, path);
        if (pluginMatch.kind === 'invalid') {
          return errorJson('invalid_request', 'Invalid request path', 400, extra);
        }
        if (pluginMatch.kind === 'match') {
          return handlePluginHttpRoute(req, url, pluginMatch, extra, srv);
        }
      }

      // 静态 web 公开（GET/HEAD；API 路径不参与）
      const isApiPath =
        path === '/v1' ||
        path.startsWith('/v1/') ||
        path === '/sessions' ||
        path === '/run' ||
        path === '/events' ||
        path === '/ws';
      if (!isApiPath && (req.method === 'GET' || req.method === 'HEAD')) {
        // 0.43：plugin UI 静态路由（在门户静态目录之前；未知 id / entry 直接 404）。
        if (path === '/plugins' || path.startsWith('/plugins/')) {
          // 懒激活：首次页面访问在取静态资源前 spawn（v1 不预激活）。
          const pluginId = pluginStaticId(path);
          if (pluginId !== null && opts.pluginHostManager !== undefined) {
            try {
              await opts.pluginHostManager.ensureActive(pluginId);
            } catch (error) {
              const code = pluginErrorCodeOf(error) ?? 'plugin_activation_failed';
              const unavailable =
                code === 'plugin_activation_failed' ||
                code === 'plugin_manifest_invalid' ||
                code === 'plugin_config_invalid';
              // 静态路由用 HTTP 语义：禁用 / 未知 404；激活期崩溃 503。
              // 契约错误码保留在 message 前缀，响应不泄漏 payload。
              return errorJson(
                unavailable ? 'not_found' : 'internal',
                `${code}: ${error instanceof Error ? error.message : String(error)}`,
                unavailable ? 404 : 503,
                extra,
              );
            }
          }
          const pluginResponse = await servePluginAsset(
            path,
            opts.pluginHostManager?.staticMounts() ?? [],
          );
          if (pluginResponse !== null) {
            for (const [key, value] of Object.entries(extra)) {
              pluginResponse.headers.set(key, value);
            }
            return pluginResponse;
          }
          return errorJson('not_found', `Not found: ${path}`, 404, extra);
        }
        const staticResponse = await serveStatic(path, opts.staticDir);
        if (staticResponse) {
          const contentType = staticResponse.headers.get('content-type') ?? '';
          if (contentType.includes('text/html')) {
            staticResponse.headers.set(
              'Content-Security-Policy',
              buildContentSecurityPolicy(req, allowedOrigins),
            );
          }
          for (const [key, value] of Object.entries(extra)) staticResponse.headers.set(key, value);
          return staticResponse;
        }
        // 非 API 的 GET/HEAD 不进入鉴权链：配了 staticDir（legacy `--serve`）时
        // 静态未命中可直接 404；拆分模式 node 不宿 WebUI（staticDir 置空），
        // `/`、SPA 与未知非 API 路径同样确定性 404，不要求 token（CONTRACT-0.49 §2.2/§5.1）。
        return errorJson('not_found', `Not found: ${path}`, 404, extra);
      }

      // DECISION-020 §R1.8：token 不进 URL（SSE EventSource 例外见上）。
      if (url.searchParams.has('token') && !queryTokenAllowed(req, path)) {
        return errorJson(
          'unauthorized',
          'token in query is only accepted for GET /v1/events; use Authorization: Bearer',
          401,
          extra,
        );
      }

      const principal = principalForRequest(req, url, path);
      if (!principal) {
        return errorJson('unauthorized', 'Missing or invalid token', 401, extra);
      }

      // 0.5：统一 RPC 入口（方法错误 HTTP 200 + ok:false）
      if (path === '/v1/rpc') {
        if (req.method !== 'POST') return methodNotAllowed(extra);
        return handleRpc(req, principal, extra);
      }

      // 0.3：durable / MCP（未注入 → 503 *_disabled）
      const durableResponse = await handleDurable(req, url, path, extra, principal);
      if (durableResponse) return durableResponse;
      const mcpResponse = await handleMcp(req, path, extra, principal);
      if (mcpResponse) return mcpResponse;

      // 0.4：metrics / feishu / evals（未注入 → 稳定错误码）
      const metricsResponse = await handleMetrics(req, path, extra, principal);
      if (metricsResponse) return metricsResponse;
      const feishuResponse = await handleFeishu(req, path, extra, principal);
      if (feishuResponse) return feishuResponse;
      const evalsResponse = await handleEvals(req, url, path, extra, principal);
      if (evalsResponse) return evalsResponse;

      // SSE：只读事件流（EventSource 无法带 header，使用 ?token=）
      if ((path === '/v1/events' || path === '/events') && req.method === 'GET') {
        const since = parseSince(url.searchParams.get('since'));
        // 分段回放（additive，与 WS `until_seq` 同义）：只回放 `seq <= until_seq`。
        const until = parseSince(url.searchParams.get('until_seq')) || undefined;
        const sseRunId = url.searchParams.get('run_id') ?? undefined;
        const sseSessionId = url.searchParams.get('session_id') ?? undefined;
        const typeList = (url.searchParams.get('types') ?? '')
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        // 空列表等价于未提供；条目以 `*` 结尾按前缀匹配。
        const sseTypes = typeList.length > 0 ? typeList : undefined;
        // 回放期局部归属（在 start 里按 seq 顺序重建）；实时事件回落到全局 LRU。
        let sseReplaySessions: ReadonlyMap<string, string> = new Map();
        const accepts = (event: RunEvent): boolean => {
          // 0.49 C5：不按 tenant_id 过滤；run_id / session_id / types 过滤保留。
          return acceptsEvent(
            event,
            { runId: sseRunId, sessionId: sseSessionId, types: sseTypes },
            sseReplaySessions,
            runSessions,
          );
        };
        let controller: SseController | undefined;
        let state: SseClientState | undefined;
        const stream = new ReadableStream<unknown>(
          {
            start(ctrl) {
              controller = ctrl;
              const clientState: SseClientState = {
                backpressure: new ClientBackpressure({
                  high: SSE_HIGH_WATER_FRAMES,
                  low: SSE_LOW_WATER_FRAMES,
                }),
                unacked: 0,
                encodeGap: (gap) => `data: ${JSON.stringify(gapFrame(gap))}\n\n`,
                onClose: () => sseClients.delete(ctrl),
                accepts,
              };
              state = clientState;
              sseClients.set(ctrl, clientState);

              // 先算窗口再写 hello：hello.from_seq 必须是本次实际会发送的第一条。
              // 分段回放（additive `until_seq`）：窗口终点裁到 until，窗口之后仍由
              // pull 一路拉到最新（SSE 本来就是前向分批回放，不是「尾部窗口之后就丢」）。
              const source = hub.since(since);
              const bounded =
                until === undefined ? source : source.filter((item) => item.seq <= until);
              sseReplaySessions = buildRunSessions(bounded);
              const window = tailReplayWindow(
                bounded.filter((item) => accepts(item.event)),
                (item) =>
                  serializeEventFrame({
                    ...item,
                    event: withSessionAttribution(item.event, sseReplaySessions),
                  }),
              );
              const fromSeq = window.frames[0]?.item.seq ?? emptyFromSeq(until);
              writeSse(ctrl, clientState, 'retry: 3000\n\n');
              writeSse(ctrl, clientState, `data: ${JSON.stringify(helloFrame(fromSeq))}\n\n`);
              const ringGap = boundGap(hub.gapFor(since), until);
              const gapTo = Math.max(ringGap?.to_seq ?? 0, window.skippedTo ?? 0);
              if (gapTo > 0) {
                writeSse(
                  ctrl,
                  clientState,
                  clientState.encodeGap({
                    from_seq: ringGap?.from_seq ?? since + 1,
                    to_seq: gapTo,
                  }),
                );
              }

              // 窗口内已序列化，pull 时直接复用；窗口外的新事件再按需序列化。
              const windowFrames = new Map<number, string>();
              for (const frame of window.frames) {
                windowFrames.set(frame.item.seq, `data: ${frame.encoded}\n\n`);
              }
              const cursor = window.frames[0]?.item.seq ?? hub.latestSeq + 1;
              clientState.replay = {
                // 有界回放：从保留窗口的第一条开始，而不是从 since 全量重放。
                cursor,
                batch: SSE_REPLAY_BATCH,
                accepts,
                encode: (item) =>
                  windowFrames.get(item.seq) ?? `data: ${serializeEventFrame(item)}\n\n`,
              };
              if (cursor > hub.latestSeq) clientState.replay = undefined;
            },
            pull() {
              if (!controller || !state) return;
              state.unacked = 0;
              pumpSseReplay(controller, state, hub);
              flushSseGap(controller, state);
            },
            cancel() {
              if (controller) sseClients.delete(controller);
            },
          },
          { highWaterMark: SSE_HIGH_WATER_FRAMES },
        );
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...extra,
          },
        });
      }

      // 会话列表（/sessions 为 0.1.0 兼容别名）
      if ((path === '/v1/sessions' || path === '/sessions') && req.method === 'GET') {
        try {
          return json(await callMethod('sessions.list', {}, principal), 200, extra);
        } catch (error) {
          return legacyErrorResponse(error, extra);
        }
      }

      // 工具列表（不含 handler）
      if (path === '/v1/tools' && req.method === 'GET') {
        try {
          return json(await callMethod('tools.list', {}, principal), 200, extra);
        } catch (error) {
          return legacyErrorResponse(error, extra);
        }
      }

      // 运行列表（内存内当前进程）
      if (path === '/v1/runs' && req.method === 'GET') {
        const sessionFilter = url.searchParams.get('session_id');
        try {
          return json(
            await callMethod(
              'runs.list',
              sessionFilter !== null ? { session_id: sessionFilter } : {},
              principal,
            ),
            200,
            extra,
          );
        } catch (error) {
          return legacyErrorResponse(error, extra);
        }
      }

      // 提交运行（异步；事件流负责结果）
      if (path === '/v1/runs' && req.method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes, extra);
        if (body instanceof Response) return body;
        try {
          return json(await callMethod('runs.start', body, principal), 202, extra);
        } catch (error) {
          return legacyErrorResponse(error, extra);
        }
      }

      // 运行状态 / 取消
      const runMatch = path.match(/^\/v1\/runs\/([^/]+)(\/cancel)?$/);
      if (runMatch) {
        const runId = decodeURIComponent(runMatch[1] ?? '');
        const isCancel = Boolean(runMatch[2]);
        if (isCancel && req.method === 'POST') {
          try {
            return json(await callMethod('runs.cancel', { run_id: runId }, principal), 200, extra);
          } catch (error) {
            return legacyErrorResponse(error, extra, 404);
          }
        }
        if (!isCancel && req.method === 'GET') {
          try {
            const result = (await callMethod('runs.get', { run_id: runId }, principal)) as {
              run?: unknown;
            };
            return json(result.run ?? result, 200, extra);
          } catch (error) {
            return legacyErrorResponse(error, extra, 404);
          }
        }
        return errorJson('method_not_allowed', 'Method not allowed', 405, extra);
      }

      // 权限应答
      const permissionMatch = path.match(/^\/v1\/permissions\/([^/]+)$/);
      if (permissionMatch && req.method === 'POST') {
        const requestId = decodeURIComponent(permissionMatch[1] ?? '');
        const body = await readJsonBody(req, maxBodyBytes, extra);
        if (body instanceof Response) return body;
        const decision = body.decision;
        if (decision !== 'allow' && decision !== 'deny') {
          return errorJson('invalid_request', "decision must be 'allow' or 'deny'", 400, extra);
        }
        try {
          return json(
            await callMethod(
              'permission.respond',
              {
                request_id: requestId,
                decision,
                ...(body.remember === true ? { remember: true } : {}),
                ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
              },
              principal,
            ),
            200,
            extra,
          );
        } catch (error) {
          return legacyErrorResponse(error, extra, 404);
        }
      }

      // ask_user 应答（answers=[] 表示取消）
      const askMatch = path.match(/^\/v1\/ask\/([^/]+)$/);
      if (askMatch && req.method === 'POST') {
        const requestId = decodeURIComponent(askMatch[1] ?? '');
        const body = await readJsonBody(req, maxBodyBytes, extra);
        if (body instanceof Response) return body;
        if (!Array.isArray(body.answers)) {
          return errorJson('invalid_request', 'answers must be an array', 400, extra);
        }
        try {
          return json(
            await callMethod(
              'ask.respond',
              { request_id: requestId, answers: body.answers },
              principal,
            ),
            200,
            extra,
          );
        } catch (error) {
          return legacyErrorResponse(error, extra, 404);
        }
      }

      // 0.1.0 兼容：阻塞式 /run 已删除（0.27）。
      // gateway 不再持有 run 记录，无法等待终态；app 侧执行生命周期归 AgentService。
      // 旧客户端改用 `POST /v1/runs`（202 + 事件流）。
      if (path === '/run' && req.method === 'POST') {
        return errorJson(
          'method_not_allowed',
          'POST /run is removed; use POST /v1/runs (async) and subscribe to events',
          405,
          extra,
        );
      }

      return errorJson('not_found', `Not found: ${path}`, 404, extra);
    },
    websocket: {
      data: {} as WsData,
      open(ws) {
        if (ws.data.pluginWs !== undefined) {
          pluginWsClients.add(ws);
          ws.data.pluginWs.begin(ws);
          return;
        }
        ws.data.alive = true;
        if (ws.data.authed) {
          replayTo(ws);
          return;
        }
        ws.data.authTimer = setTimeout(() => {
          if (!ws.data.authed) ws.close(4401, 'auth timeout');
        }, authTimeoutMs);
        const timer = ws.data.authTimer as { unref?: () => void };
        timer.unref?.();
      },
      message(ws, message) {
        if (ws.data.pluginWs !== undefined) {
          ws.data.pluginWs.message(message);
          return;
        }
        void handleWsMessage(ws, message);
      },
      close(ws, code, reason) {
        if (ws.data.pluginWs !== undefined) {
          pluginWsClients.delete(ws);
          ws.data.pluginWs.clientClose(code, reason);
          return;
        }
        if (ws.data.authTimer) clearTimeout(ws.data.authTimer);
        wsClients.delete(ws);
      },
      pong(ws) {
        if (ws.data.pluginWs !== undefined) {
          ws.data.pluginWs.pong();
          return;
        }
        ws.data.alive = true;
      },
    },
  };

  const localOnly = opts.localOnly === true;
  let server: Bun.Server<WsData> | undefined;
  if (!localOnly) {
    try {
      server = Bun.serve<WsData>(serveOptions);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to start gateway on ${hostname}:${opts.port ?? DEFAULT_PORT}: ${detail}`,
        { cause: error },
      );
    }
  }

  const actualPort = server?.port ?? (localOnly ? 0 : (opts.port ?? DEFAULT_PORT));

  // 心跳：WS 发 ping（客户端回 pong 或 {kind:'pong'}），SSE 发注释行。
  // 本地 dispatcher 无连接，不启动心跳。
  const heartbeat = localOnly
    ? undefined
    : setInterval(() => {
        for (const ws of [...wsClients]) {
          if (!ws.data.alive) {
            ws.close(1001, 'heartbeat timeout');
            wsClients.delete(ws);
            continue;
          }
          ws.data.alive = false;
          sendFrame(ws, { v: PROTOCOL_VERSION, kind: 'ping', node_id: nodeId, ts: Date.now() });
          // 客户端已排空但没有新事件时，心跳负责补发 pending gap。
          flushWsGap(ws);
        }
        for (const [ctrl, state] of [...sseClients]) {
          if (!flushSseGap(ctrl, state)) continue;
          writeSse(ctrl, state, ': ping\n\n');
        }
      }, heartbeatMs);
  (heartbeat as { unref?: () => void } | undefined)?.unref?.();

  /** 关闭路径的异常只记 stderr，不阻断后续清理 */
  function reportStopError(action: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[vessel] gateway stop: ${action} failed: ${detail}`);
  }

  function closeWsClients(): void {
    for (const ws of wsClients) {
      try {
        ws.close(1001, 'server stopping');
      } catch (error) {
        reportStopError('close websocket', error);
      }
    }
    wsClients.clear();
  }

  /** 0.48 M3：关闭全部插件 WS（独立于事件连接）。 */
  function closePluginWsClients(): void {
    for (const ws of pluginWsClients) {
      try {
        ws.close(1001, 'server stopping');
      } catch (error) {
        reportStopError('close plugin websocket', error);
      }
    }
    pluginWsClients.clear();
  }

  function closeSseClients<T>(clients: Map<SseController, T>): void {
    for (const ctrl of clients.keys()) {
      try {
        ctrl.close();
      } catch (error) {
        reportStopError('close event stream', error);
      }
    }
    clients.clear();
  }

  async function shutdown(): Promise<void> {
    if (heartbeat !== undefined) clearInterval(heartbeat);

    // 0.27：执行生命周期归 app / AgentService —— gateway 只退订、关连接。
    // 这里不再清队列、不中断 active run、不等终态。
    try {
      unsubscribe();
    } catch (error) {
      reportStopError('unsubscribe events', error);
    }
    try {
      unsubscribeInteractions();
    } catch (error) {
      reportStopError('unsubscribe interactions', error);
    }

    closeWsClients();
    closePluginWsClients();
    closeSseClients(sseClients);

    if (server) {
      try {
        await server.stop(true);
      } catch (error) {
        reportStopError('stop http server', error);
      }
    }
  }

  let stopPromise: Promise<void> | undefined;

  return {
    port: actualPort,
    url: `${scheme}://${hostname}:${actualPort}`,
    token,
    nodeId,
    protocol: protocolInfo,
    tls: tlsMaterial !== undefined,
    reconfigure,
    rpc: dispatcher.dispatch,
    manifest,
    stop() {
      stopPromise ??= shutdown();
      return stopPromise;
    },
  };
}
