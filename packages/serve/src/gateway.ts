/**
 * Gateway — 本地 HTTP/WS 服务网关（协议 vessel.gateway/1）
 * @module @vessel/serve
 *
 * 把 runtime 的 EventStream 暴露为 WS / SSE 广播，并提供 /v1 控制端点：
 * 会话、工具、运行提交/查询/取消、权限应答、静态 web 托管。
 *
 * 设计约束：
 * - 只监听回环地址（默认 127.0.0.1），不做远程暴露；
 * - 事件在传输层分配单调 seq，支持 since 回放与 gap 信号，不改 core 类型；
 * - 单 runtime / 单 ContextManager：运行串行执行；会话切换时 clear 上下文（G2）；
 * - `/v1/team/*` 属于 0.2，0.1.0 只保留协议草案（见 protocol.ts）。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import type {
  AgentMessage,
  ContextManager,
  EventStream,
  PluginHost,
  RunEvent,
  RunnableAgent,
  SessionBackend,
  ToolDefinition,
  TraceRedactor,
} from '@vessel/core';
import { createDefaultTraceRedactor } from '@vessel/core';
import { ClientBackpressure } from './backpressure.js';
import {
  type DurableGatewayOptions,
  dedupeCheckpoints,
  isResumableStatus,
  MAX_DURABLE_LIMIT,
  parseLimit,
  parseStatusFilter,
  sortCheckpoints,
  toRunSummary,
} from './durable.js';
import { type EvalsGatewayOptions, normalizeEvalReport } from './evals.js';
import { type EventGap, type SeqEvent, SeqEventBuffer } from './event-buffer.js';
import { type FeishuGatewayOptions, normalizeFeishuStatus } from './feishu.js';
import { type McpGatewayOptions, normalizeMcpServers } from './mcp.js';
import { type MetricsProvider, type MetricsSnapshot, normalizeMetricsSnapshot } from './metrics.js';
import {
  type ClientFrame,
  type NodeInfo,
  PROTOCOL_VERSION,
  type ProtocolError,
  type ProtocolInfo,
  protocolError,
  type ServerFrame,
  type ToolInfo,
} from './protocol.js';
import {
  buildCapabilityManifest,
  type CapabilityManifest,
  createRpcDispatcher,
  defineMethods,
  type RpcDispatcher,
  RpcError,
  type RpcMethodContext,
  type RpcMethodDefinition,
  type RpcRequest,
  type RpcResponse,
} from './rpc.js';
import { createRunEngine } from './run-engine.js';
import {
  fromWireMessage,
  isRemoteAddress,
  isTeamEvent,
  normalizeLocalAddress,
  parseAddress,
  type TeamGatewayOptions,
  TeamProtocolError,
  toWireAgentStatus,
  toWireEvent,
  toWireMessage,
  toWirePeer,
} from './team.js';
import {
  type ConfigGatewayOptionsLike,
  DEFAULT_TENANT_ID,
  eventVisible,
  extractToken,
  type GatewayAuthLike,
  mapTenantError,
  normalizeTenantInfo,
  resolveLocalPrincipal,
  resolvePrincipal,
  resolveTenantScope,
  type TenantControlLike,
  type TenantInfo,
  type TenantPrincipal,
  type TenantQuota,
} from './tenant.js';
import {
  dedupeWorkflowSummaries,
  isSafeWorkflowName,
  MAX_WORKFLOW_LIMIT,
  parseWorkflowLimit,
  parseWorkflowStatus,
  sortWorkflowSummaries,
  toWireWorkflowDetail,
  toWireWorkflowSummary,
  type WorkflowGatewayOptions,
  type WorkflowRunStatus,
} from './workflow.js';

/** 网关启动选项 */
export interface GatewayOptions {
  /** 事件流（必填）——广播源 */
  events: EventStream;
  /** 会话后端（可选）——/v1/sessions 数据源 */
  session?: SessionBackend;
  /** 运行时（可选）——运行控制端点；结构类型 RunnableAgent（A10），不要断言成 AgentRuntime */
  runtime?: RunnableAgent;
  /** 上下文管理器（可选）——会话切换时 clear，修跨会话串历史 */
  context?: ContextManager;
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
  /** 节点 id；缺省 team.nodeId 或随机。team/transport 必须使用同一个值（U3） */
  nodeId?: string;
  /** 静态 web 目录（可选，托管 apps/web/dist） */
  staticDir?: string;
  /** 事件环形缓冲容量（默认 10000） */
  maxHistory?: number;
  /** 请求体上限（字节，默认 1 MiB） */
  maxBodyBytes?: number;
  /** 运行队列上限（默认 100） */
  maxQueue?: number;
  /** 额外允许的浏览器 Origin（默认只允许同源） */
  allowedOrigins?: string[];
  /** 心跳间隔（毫秒，默认 15000） */
  heartbeatMs?: number;
  /** WS 首帧鉴权超时（毫秒，默认 5000） */
  authTimeoutMs?: number;
  /**
   * Bun.serve 的空闲超时（秒）。默认 0 = 不超时。
   * 事件流是长连接，不能用 Bun 的 10s 默认值；SSE 心跳 `: ping` 仍用于穿透代理。
   */
  idleTimeout?: number;
  /** R3 team 端点配置；缺省 = team 关闭（`/v1/team/*` 返回 404） */
  team?: TeamGatewayOptions;
  /**
   * 显式允许非回环监听（默认 false）。
   * 非回环 hostname 必须同时给出 allowRemote=true 与非空 token。
   */
  allowRemote?: boolean;
  /** TLS 证书对；必须成对提供，缺一即启动失败 */
  tls?: { certFile: string; keyFile: string };
  /** durable run 查询/恢复注入；缺省 = durable 端点关闭 */
  durable?: DurableGatewayOptions;
  /** MCP server 状态注入；缺省 = MCP 端点关闭 */
  mcp?: McpGatewayOptions;
  /** workflow 控制面注入；缺省 = `/v1/workflows*` 返回 workflow_disabled */
  workflows?: WorkflowGatewayOptions;
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
  /** tenant registry / quota（asm 注入） */
  tenants?: TenantControlLike;
  /** plugins.list 数据源（全局） */
  plugins?: () => Array<{ name: string; enabled: boolean }>;
  /** 0.5 A-6.3：per-tenant plugins.list / capabilities.list；缺省回退 `plugins` */
  pluginsFor?: (tenantId: string) => Array<{ name: string; enabled: boolean }>;
  /** metrics.reset / trace 重建 */
  metricsControl?: {
    reset?(tenantId?: string): void;
    rebuild?(tenantId: string): Promise<MetricsSnapshot>;
  };
  /** 可选 per-tenant live metrics；缺省 default tenant 用 `metrics` */
  metricsFor?: (tenantId: string) => MetricsProvider;
  /** trace 读取 / prune（core readTraceEvents / pruneTrace，由 asm 注入） */
  trace?: {
    prune?(options: Record<string, unknown>): Promise<unknown>;
    readEvents?(filter: Record<string, unknown>, tenantId?: string): Promise<RunEvent[]>;
  };
  /** core deleteSessionData，由 asm 注入 */
  sessionData?: {
    deleteSessionData(
      sessionId: string,
      tenantId?: string,
    ): Promise<{
      sessions_deleted: number;
      runs_deleted: number;
      events_deleted: number;
    }>;
  };
  /** 出站事件脱敏；缺省 core 默认 redactor */
  redactor?: TraceRedactor;
  /** per-tenant 执行面（A-3 §10.4） */
  runtimeFor?: (tenantId: string) => RunnableAgent | undefined;
  sessionFor?: (tenantId: string) => SessionBackend | undefined;
  contextFor?: (tenantId: string) => ContextManager | undefined;
  pluginHostFor?: (tenantId: string) => PluginHost | undefined;
  /** 缺省 tenant（wildcard admin 未指定时使用） */
  defaultTenantId?: string;
  /**
   * 内部：只构建方法表/引擎，不调用 `Bun.serve`。
   * 由 `createLocalRpcDispatcher` 使用；外部不要设置。
   * @internal
   */
  localOnly?: boolean;
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
   * 启动 gateway 后再接入 team（asm 需先拿到实际端口构造 LoopbackTransport）。
   * 只设置一次；重复调用会替换 team 配置。
   */
  attachTeam(team: TeamGatewayOptions): void;
  /**
   * 进程内 dispatcher（与 asm `RpcDispatcher` 结构一致）。
   * asm 用它构造 `LocalRpcClient`；principal 缺省为本地 default/admin。
   */
  rpc: RpcDispatcher;
  /** 当前 capability manifest（capabilities.list 同源） */
  manifest(): CapabilityManifest;
  stop(): void;
}

/** SSE 回放状态：由 pull 驱动，慢连接不会一次性堆满队列 */
interface SseReplayState {
  /** 下一条要回放的 seq */
  cursor: number;
  /** 每次 pull 最多发送的事件数 */
  batch: number;
  accepts: (event: RunEvent) => boolean;
  encode: (item: SeqEvent) => string;
}

/** 单个 SSE 连接的状态 */
interface SseClientState {
  backpressure: ClientBackpressure;
  /** pull 之后自增；作为 Bun desiredSize 失效时的退化信号 */
  unacked: number;
  encodeGap: (gap: EventGap) => string;
  replay?: SseReplayState;
  onClose?: () => void;
  /** 0.5 tenant 过滤；undefined = 不过滤（team/MCP legacy 流） */
  tenantId?: string;
  allTenants?: boolean;
  /** 可选事件过滤（events.subscribe run_id / types） */
  accepts?: (event: RunEvent) => boolean;
}

/** team SSE 连接状态 */
interface TeamClientState extends SseClientState {
  agentId?: string;
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
  tenantId: string;
  allTenants: boolean;
  /** events.subscribe 过滤 */
  runId?: string;
  types?: string[];
}

type Ws = import('bun').ServerWebSocket<WsData>;
type SseController = ReadableStreamDefaultController<unknown>;

/** 运行队列上限（防止无界堆积） */
const MAX_QUEUE = 100;
/** 保留的运行记录数 */
const MAX_RUNS = 200;
/** WS 慢客户端硬关闭阈值（最终安全网） */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** WS 事件背压：高水位开始丢事件，低水位补 gap（DECISION-009 §10.3.5） */
const WS_BACKPRESSURE_HIGH = 2 * 1024 * 1024;
const WS_BACKPRESSURE_LOW = 512 * 1024;
/** SSE 背压按帧计；highWaterMark 同时用于控制器队列 */
const SSE_HIGH_WATER_FRAMES = 256;
const SSE_LOW_WATER_FRAMES = 64;
/** 每次 pull 回放的批大小 */
const SSE_REPLAY_BATCH = 64;

const DEFAULT_PORT = 8642;
const DEFAULT_HOSTNAME = '127.0.0.1';
const DEFAULT_MAX_HISTORY = 10_000;
const DEFAULT_MAX_BODY = 1024 * 1024;

const BASE_FEATURES = ['events.replay', 'permissions', 'tools', 'static', 'runs.async'];

/** 回环判定：localhost / 127.0.0.0/8 / ::1（可带方括号） */
export function isLoopbackHostname(hostname: string): boolean {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === '::1') return true;
  return isIP(lower) === 4 && lower.startsWith('127.');
}

/** 通配绑定：0.0.0.0 / ::（可带方括号） */
function isWildcardHostname(hostname: string): boolean {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return host === '0.0.0.0' || host === '::';
}

/** 读取 TLS 证书/私钥；空文件与不可读都给出明确错误 */
function loadTlsMaterial(tls: { certFile: string; keyFile: string }): {
  cert: string;
  key: string;
} {
  if (!tls.certFile || !tls.keyFile) {
    throw new Error('serve.tls requires both cert_file and key_file.');
  }
  const read = (path: string, label: 'cert_file' | 'key_file'): string => {
    try {
      const content = readFileSync(path, 'utf8');
      if (content.trim().length === 0) throw new Error('file is empty');
      return content;
    } catch (error) {
      const detail =
        (error as NodeJS.ErrnoException).code ??
        (error instanceof Error ? error.message : String(error));
      throw new Error(`Failed to read TLS ${label} "${path}": ${detail}`);
    }
  };
  return { cert: read(tls.certFile, 'cert_file'), key: read(tls.keyFile, 'key_file') };
}

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; " +
  "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

/** 方法级错误（映射到协议错误码） */
class MethodError extends Error {
  constructor(
    readonly code: ProtocolError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'MethodError';
  }
}

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

/** 判断 Host 是否指向回环地址（防 DNS rebinding） */
function hostAllowed(req: Request, listenHost: string): boolean {
  const host = req.headers.get('host');
  if (!host) return true;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (isLoopbackHostname(hostname)) return true;
  // 通配绑定无法与 Host 精确比较；远程模式仍要求 token，浏览器 Origin 仍须同源。
  if (isWildcardHostname(listenHost)) return true;
  return hostname === listenHost.toLowerCase();
}

/** Origin 校验：无 Origin（curl / peer）放行；浏览器必须同源或在允许列表 */
function originAllowed(req: Request, allowedOrigins: string[]): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  const host = req.headers.get('host');
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
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

/** 允许列表命中时返回 CORS 头（同源不需要） */
function corsHeaders(req: Request, allowedOrigins: string[]): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Vessel-Protocol',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/** 从请求体读取 JSON 对象（带大小上限） */
async function readJsonBody(
  req: Request,
  maxBytes: number,
): Promise<Record<string, unknown> | Response> {
  const contentType = req.headers.get('content-type');
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
    return errorJson('invalid_request', 'Content-Type must be application/json', 415);
  }
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return errorJson('payload_too_large', `Request body exceeds ${maxBytes} bytes`, 413);
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return errorJson('invalid_request', 'Cannot read request body', 400);
  }
  if (Buffer.byteLength(text) > maxBytes) {
    return errorJson('payload_too_large', `Request body exceeds ${maxBytes} bytes`, 413);
  }
  if (text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return errorJson('invalid_request', 'Request body must be a JSON object', 400);
    }
    return parsed as Record<string, unknown>;
  } catch {
    return errorJson('invalid_request', 'Invalid JSON', 400);
  }
}

/** 启动本地服务网关 */
export function startGateway(opts: GatewayOptions): Gateway {
  const events = opts.events;
  const { session, runtime, context } = opts;
  const hostname = opts.hostname ?? DEFAULT_HOSTNAME;
  if (hostname.includes('/')) {
    throw new Error(`Invalid gateway hostname "${hostname}": must be a bare host or IP address.`);
  }

  const allowRemote = opts.allowRemote === true;
  if (!isLoopbackHostname(hostname) && !allowRemote) {
    throw new Error(
      `Refusing to listen on non-loopback hostname "${hostname}": ` +
        'set serve.allow_remote=true (and a gateway token) to expose the gateway.',
    );
  }
  if (allowRemote && opts.token !== undefined && opts.token.trim().length === 0) {
    throw new Error(
      'Remote mode requires a non-empty gateway token ' +
        '(serve token, VESSEL_GATEWAY_TOKEN, or gateway-generated).',
    );
  }
  const token =
    opts.token !== undefined && opts.token.trim().length > 0 ? opts.token : generateToken();

  const tlsMaterial = opts.tls ? loadTlsMaterial(opts.tls) : undefined;

  const defaultTenantId = opts.defaultTenantId ?? DEFAULT_TENANT_ID;
  const redactor: TraceRedactor = opts.redactor ?? createDefaultTraceRedactor();
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
  if (opts.workflows !== undefined) {
    const required = [
      'listRuns',
      'getRun',
      'start',
      'resume',
      'cancel',
      'resolveDefinition',
    ] as const;
    for (const key of required) {
      if (typeof opts.workflows[key] !== 'function') {
        throw new Error(`workflows.${key} must be a function.`);
      }
    }
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

  const features = [...BASE_FEATURES];
  if (opts.durable?.store && opts.durable.resume) features.push('durable-resume');
  if (opts.mcp) features.push('mcp-status');
  if (tlsMaterial) features.push('tls');
  if (opts.workflows) features.push('workflow');
  if (opts.evals) features.push('evals');
  if (opts.feishu) features.push('feishu');
  if (opts.metrics) features.push('metrics');
  if (opts.config) features.push('config');
  if (opts.tenants) features.push('tenants');
  const protocolInfo: ProtocolInfo = {
    name: 'vessel.gateway',
    version: PROTOCOL_VERSION,
    min: PROTOCOL_VERSION,
    features,
  };
  const scheme = tlsMaterial ? 'https' : 'http';

  const nodeId = opts.nodeId ?? opts.team?.nodeId ?? randomUUID();
  const startedAt = Date.now();
  // gateway 事件缓冲始终有界：缺省/0 = 10000；与 core MemoryEventStream 的
  // `0 = unlimited` 语义无关（DECISION-009 §10.3.4）。
  const configuredHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
  if (!Number.isSafeInteger(configuredHistory) || configuredHistory < 0) {
    throw new Error('maxHistory must be a non-negative integer.');
  }
  const buffer = new SeqEventBuffer(
    configuredHistory === 0 ? DEFAULT_MAX_HISTORY : configuredHistory,
  );
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const maxQueue = opts.maxQueue ?? MAX_QUEUE;
  const allowedOrigins = opts.allowedOrigins ?? [];
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const authTimeoutMs = opts.authTimeoutMs ?? 5_000;

  const sseClients = new Map<SseController, SseClientState>();
  const wsClients = new Set<Ws>();

  // 共享运行引擎（gateway 与 createLocalRpcDispatcher 同一套实现，A-5 §12.1）
  const engine = createRunEngine({
    events,
    ...(runtime ? { runtime } : {}),
    ...(context ? { context } : {}),
    ...(opts.runtimeFor ? { runtimeFor: opts.runtimeFor } : {}),
    ...(opts.contextFor ? { contextFor: opts.contextFor } : {}),
    defaultTenantId,
    maxQueue,
    maxRuns: MAX_RUNS,
  });
  const runs = engine.runs;
  const queue = engine.queue;
  const coreToJob = engine.coreToJob;
  const publicStatus = engine.publicStatus;
  const submitRun = engine.submitRun;
  const cancelRun = engine.cancelRun;
  const respondPermission = engine.respondPermission;
  const respondAsk = engine.respondAsk;
  /**
   * 本进程已受理的 durable resume（快速 409，不替代 core 校验）。
   * Addendum A §2：首个调用成功，后续（含重复）一律 run_already_running。
   */
  const resumedRuns = new Set<string>();
  /** workflow resume 在途占位（同一 run 只允许一个），LRU 上限 1000 */
  const resumedWorkflows = new Set<string>();

  /** R3 team 状态（默认关闭） */
  let team: TeamGatewayOptions | undefined = opts.team;
  const teamClients = new Map<SseController, TeamClientState>();
  let teamPollTimer: ReturnType<typeof setInterval> | undefined;
  let knownPeers = new Set<string>();
  let inboundCursor = 0;
  /** 入站去重（transport.deliver 之外的兜底，防止注入 deliver 时绕过） */
  const seenInbound = new Map<string, true>();

  const pluginHost = (): PluginHost | undefined => opts.pluginHost ?? runtime?.pluginHost;

  const listTools = (): ToolDefinition[] => {
    try {
      return pluginHost()?.listTools() ?? [];
    } catch {
      return [];
    }
  };

  const nodeInfo = (): NodeInfo => ({
    node_id: nodeId,
    ...(opts.nodeName ? { name: opts.nodeName } : {}),
    pid: process.pid,
    started_at: startedAt,
    endpoint: `${scheme}://${hostname}:${actualPort}`,
    role: 'standalone',
    status: engine.active ? 'busy' : 'idle',
    ...(engine.active
      ? { current_run_id: engine.active.run_id, current_session_id: engine.active.session_id }
      : {}),
    capabilities: {
      tools: listTools().map((tool) => tool.name),
      max_concurrency: 1,
      protocol: PROTOCOL_VERSION,
    },
  });

  // ── 事件广播：分配 seq → 扇出 ──────────────────

  function eventFrame(item: SeqEvent): ServerFrame {
    const jobId = coreToJob.get(item.event.run_id);
    return {
      v: 1,
      kind: 'event',
      node_id: nodeId,
      ts: Date.now(),
      seq: item.seq,
      ...(jobId ? { job_id: jobId } : {}),
      // A7：agent.* / team.* 的 data 在 gateway 边界映射为 snake_case
      event: toWireEvent(item.event),
    };
  }

  function helloFrame(fromSeq: number, tenantId?: string): ServerFrame {
    const latest = buffer.latestSeq;
    // from_seq = 本次回放的第一条 seq；空缓冲时为 0（此时 latest_seq 也是 0）。
    // 已追平时为 since + 1（= latest + 1），表示「下一条期望序号」。
    return {
      v: 1,
      kind: 'hello',
      node_id: nodeId,
      ts: Date.now(),
      protocol: protocolInfo,
      node: nodeInfo(),
      from_seq: latest === 0 ? 0 : Math.max(fromSeq + 1, buffer.oldestSeq),
      latest_seq: latest,
      ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
    };
  }

  function gapFrame(gap: EventGap): ServerFrame {
    return {
      v: 1,
      kind: 'gap',
      node_id: nodeId,
      ts: Date.now(),
      from_seq: gap.from_seq,
      to_seq: gap.to_seq,
    };
  }

  function sendFrame(ws: Ws, frame: ServerFrame): boolean {
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
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      wsClients.delete(ws);
      return false;
    }
  }

  function sendResult(ws: Ws, id: string, ok: boolean, result?: unknown, error?: ProtocolError) {
    if (ok) {
      sendFrame(ws, { v: 1, kind: 'res', node_id: nodeId, ts: Date.now(), id, ok: true, result });
      return;
    }
    sendFrame(ws, {
      v: 1,
      kind: 'res',
      node_id: nodeId,
      ts: Date.now(),
      id,
      ok: false,
      error: error ?? protocolError('internal', 'Unknown error'),
    });
  }

  function wsAccepts(ws: Ws, event: RunEvent): boolean {
    if (!eventVisible(event, ws.data.tenantId, ws.data.allTenants)) return false;
    if (ws.data.runId !== undefined && event.run_id !== ws.data.runId) return false;
    if (ws.data.types !== undefined && !ws.data.types.includes(event.type)) return false;
    return true;
  }

  function sendEventToWs(ws: Ws, item: SeqEvent): void {
    if (!wsAccepts(ws, item.event)) return;
    const inflight = ws.getBufferedAmount();
    if (!ws.data.backpressure.admit(item.seq, inflight)) return;
    const gap = ws.data.backpressure.takeGap(inflight);
    if (gap) sendFrame(ws, gapFrame(gap));
    sendFrame(ws, eventFrame(item));
  }

  function flushWsGap(ws: Ws): void {
    const gap = ws.data.backpressure.takeGap(ws.getBufferedAmount());
    if (gap) sendFrame(ws, gapFrame(gap));
  }

  function sseInflight(ctrl: SseController, state: SseClientState): number {
    const desired = ctrl.desiredSize;
    const queued = typeof desired === 'number' ? Math.max(0, SSE_HIGH_WATER_FRAMES - desired) : 0;
    return Math.max(queued, state.unacked);
  }

  function writeSse(ctrl: SseController, state: SseClientState, chunk: string): boolean {
    try {
      ctrl.enqueue(chunk);
      state.unacked += 1;
      return true;
    } catch {
      state.onClose?.();
      return false;
    }
  }

  function flushSseGap(ctrl: SseController, state: SseClientState): boolean {
    const gap = state.backpressure.takeGap(sseInflight(ctrl, state));
    if (!gap) return true;
    return writeSse(ctrl, state, state.encodeGap(gap));
  }

  function sendGatedSse(
    ctrl: SseController,
    state: SseClientState,
    seq: number,
    chunk: string,
  ): boolean {
    if (ctrl.desiredSize === null) {
      state.onClose?.();
      return false;
    }
    const inflight = sseInflight(ctrl, state);
    if (!state.backpressure.admit(seq, inflight)) return true;
    if (!flushSseGap(ctrl, state)) return false;
    return writeSse(ctrl, state, chunk);
  }

  /** 由 pull 驱动回放：每次只发 batch 条，慢客户端自然停在队列满时 */
  function pumpSseReplay(ctrl: SseController, state: SseClientState): void {
    const replay = state.replay;
    if (!replay) return;
    const historyGap = buffer.gapFor(replay.cursor - 1);
    if (historyGap) {
      if (!writeSse(ctrl, state, state.encodeGap(historyGap))) return;
      replay.cursor = historyGap.to_seq + 1;
    }
    let sent = 0;
    for (const item of buffer.since(replay.cursor - 1)) {
      const desired = ctrl.desiredSize;
      if (typeof desired === 'number' && desired <= 0) return;
      replay.cursor = item.seq + 1;
      if (!replay.accepts(item.event)) continue;
      if (!sendGatedSse(ctrl, state, item.seq, replay.encode(item))) return;
      sent += 1;
      if (sent >= replay.batch) return;
    }
    if (replay.cursor > buffer.latestSeq) state.replay = undefined;
  }

  function broadcastEvent(item: SeqEvent): void {
    const encoded = JSON.stringify(eventFrame(item));
    for (const ws of [...wsClients]) sendEventToWs(ws, item);
    const sseFrame = `data: ${encoded}\n\n`;
    for (const [ctrl, state] of [...sseClients]) {
      // 回放期间由 pull 驱动，避免新事件插到历史事件前面。
      if (state.replay) continue;
      if (
        state.tenantId !== undefined &&
        !eventVisible(item.event, state.tenantId, state.allTenants === true)
      ) {
        continue;
      }
      if (state.accepts && !state.accepts(item.event)) continue;
      sendGatedSse(ctrl, state, item.seq, sseFrame);
    }
  }

  function replayEventsTo(ws: Ws): void {
    const gap = buffer.gapFor(ws.data.since);
    if (gap) sendFrame(ws, gapFrame(gap));
    for (const item of buffer.since(ws.data.since)) sendEventToWs(ws, item);
  }

  function replayTo(ws: Ws): void {
    wsClients.add(ws);
    sendFrame(ws, helloFrame(ws.data.since, ws.data.tenantId));
    replayEventsTo(ws);
  }

  /** 订阅 core 事件流：分配 seq、记录 run 映射与权限请求、广播 */
  const unsubscribe = events.subscribe((event: RunEvent) => {
    engine.handleEvent(event);
    // 0.5：出站前统一脱敏（实时与回放都是脱敏后的副本；A-3 §10.3）
    const safeEvent = redactor.redact(event);
    const seq = buffer.append(safeEvent);
    broadcastEvent({ seq, event: safeEvent });

    // R3：team 事件流（agent.* / team.*），可选按 agent_id 过滤
    if (isTeamEvent(safeEvent) && teamClients.size > 0) {
      const wire = toWireEvent(safeEvent);
      const frame = `data: ${JSON.stringify({
        protocol: 1,
        node_id: nodeId,
        seq,
        kind: 'team.event',
        event: wire,
      })}\n\n`;
      for (const [ctrl, state] of [...teamClients]) {
        if (state.replay) continue;
        const agentId = (wire.data as Record<string, unknown>).agent_id;
        if (state.agentId !== undefined && agentId !== state.agentId) continue;
        sendGatedSse(ctrl, state, seq, frame);
      }
    }
  });

  // ── 运行队列 ───────────────────────────────────

  async function listSessions(
    tenantId: string = defaultTenantId,
  ): Promise<{ sessions: unknown[] }> {
    const backend = sessionFor(tenantId);
    if (!backend) {
      // 非 default tenant 未注入 sessionFor → 明确的 forbidden；default 保持旧语义。
      if (tenantId !== defaultTenantId) {
        throw new RpcError('forbidden', `Tenant session backend is not configured: ${tenantId}`);
      }
      throw new MethodError('no_session', 'No session backend configured');
    }
    return { sessions: await backend.listRich() };
  }

  function toolsPayload(tenantId: string = defaultTenantId): { tools: ToolInfo[] } {
    const host = pluginHostFor(tenantId);
    if (tenantId !== defaultTenantId && !host) {
      throw new RpcError('forbidden', `Tenant plugin host is not configured: ${tenantId}`);
    }
    const tools = host?.listTools() ?? [];
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
        has_permission_check: typeof tool.checkPermission === 'function',
      })),
    };
  }

  // ── 0.5 RPC 方法表（E10/E11；A-3 §10.1 v1.1） ──

  const tenantParamSchema = {
    type: 'object',
    properties: { tenant_id: { type: 'string' } },
  } as const;

  function configControl(): ConfigGatewayOptionsLike {
    if (!opts.config) throw new RpcError('not_found', 'Config view is not available');
    return opts.config;
  }

  async function checkQuota(
    tenantId: string,
    operation: 'runs.start' | 'sessions.create',
  ): Promise<void> {
    try {
      await opts.tenants?.checkQuota?.(tenantId, operation);
    } catch (error) {
      mapTenantError(error);
    }
  }

  async function enforceConcurrentQuota(tenantId: string): Promise<void> {
    let limit: number | undefined;
    try {
      limit = (await opts.tenants?.get(tenantId))?.quota?.max_concurrent_runs;
    } catch (error) {
      mapTenantError(error);
    }
    if (limit !== undefined && engine.activeCount(tenantId) >= limit) {
      throw new RpcError('quota_exceeded', `max_concurrent_runs exceeded for tenant ${tenantId}`, {
        tenant_id: tenantId,
        limit,
      });
    }
  }

  function throwWorkflowError(error: unknown): never {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    switch (code) {
      case 'workflow_not_found':
        throw new RpcError('not_found', message);
      case 'workflow_invalid':
        throw new RpcError('invalid_params', message);
      case 'workflow_already_running':
        throw new RpcError('conflict', message, { legacy_code: 'workflow_already_running' });
      case 'workflow_not_resumable':
        throw new RpcError('conflict', message, { legacy_code: 'workflow_not_resumable' });
      case 'workflow_cancelled':
        throw new RpcError('conflict', message, { legacy_code: 'workflow_invalid' });
      case 'workflow_disabled':
        throw new RpcError('not_found', message);
      default:
        throw new RpcError('internal', 'Workflow operation failed');
    }
  }

  function metricsProvider(tenantId: string): MetricsProvider | undefined {
    if (tenantId === defaultTenantId) return opts.metrics;
    return opts.metricsFor?.(tenantId);
  }

  function tenantInfoOrThrow(info: unknown): TenantInfo {
    const normalized = normalizeTenantInfo(info);
    if (!normalized) throw new RpcError('internal', 'Invalid tenant metadata');
    return normalized;
  }

  function stringParam(params: Record<string, unknown>, key: string): string {
    const value = params[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new RpcError('invalid_params', `${key} is required`);
    }
    return value;
  }

  const rpcMethods: RpcMethodDefinition[] = [
    {
      name: 'health.get',
      permission: 'read',
      params_schema: { type: 'object' },
      handler: (_params, ctx) => ({
        status: 'ok',
        clients: sseClients.size + wsClients.size,
        latest_seq: buffer.latestSeq,
        protocol: protocolInfo,
        node: nodeInfo(),
        started_at: startedAt,
        tenant_id: ctx.tenantId,
        team: team
          ? { enabled: true, node_id: team.nodeId, transport: team.transport?.kind ?? 'in-process' }
          : { enabled: false },
      }),
    },
    {
      name: 'capabilities.list',
      permission: 'read',
      params_schema: { type: 'object' },
      handler: (_params, ctx) =>
        buildCapabilityManifest({
          version: opts.version ?? '0.0.0',
          table: methodTable,
          tools: toolDescriptionsForTenant(ctx.tenantId),
          plugins: pluginsForTenant(ctx.tenantId),
        }),
    },
    {
      name: 'config.get',
      permission: 'read',
      params_schema: tenantParamSchema,
      handler: async (_params, ctx) => {
        const snapshot = await configControl().snapshot(ctx.tenantId);
        return {
          schema_version: snapshot.schema_version,
          config: snapshot.config,
          // A-5 §12.2：TUI 需要展示 user/project 路径
          paths: snapshot.paths ?? { user: '', project: '' },
          tenant_id: snapshot.tenant_id ?? ctx.tenantId,
          ...(snapshot.tenant_overlay_keys
            ? { tenant_overlay_keys: snapshot.tenant_overlay_keys }
            : {}),
        };
      },
    },
    {
      name: 'config.sources',
      permission: 'read',
      params_schema: tenantParamSchema,
      handler: async (_params, ctx) => {
        const snapshot = await configControl().snapshot(ctx.tenantId);
        return {
          sources: snapshot.sources,
          tenant_id: snapshot.tenant_id ?? ctx.tenantId,
          ...(snapshot.tenant_overlay_keys
            ? { tenant_overlay_keys: snapshot.tenant_overlay_keys }
            : {}),
        };
      },
    },
    {
      name: 'sessions.list',
      permission: 'read',
      params_schema: tenantParamSchema,
      handler: (_params, ctx) => listSessions(ctx.tenantId),
    },
    {
      name: 'sessions.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['session_id'],
        properties: { session_id: { type: 'string', minLength: 1 } },
      },
      handler: async (params, ctx) => {
        const backend = requireSession(ctx.tenantId);
        const state = await backend.load(stringParam(params, 'session_id'));
        if (!state) throw new RpcError('not_found', 'Session not found');
        return { session: state };
      },
    },
    {
      name: 'sessions.delete',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['session_id'],
        properties: { session_id: { type: 'string', minLength: 1 } },
      },
      handler: async (params, ctx) => {
        if (!opts.sessionData) {
          throw new RpcError('internal', 'deleteSessionData is not configured');
        }
        try {
          return await opts.sessionData.deleteSessionData(
            stringParam(params, 'session_id'),
            ctx.tenantId,
          );
        } catch (error) {
          mapTenantError(error);
        }
      },
    },
    {
      name: 'sessions.rename',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['session_id', 'title'],
        properties: {
          session_id: { type: 'string', minLength: 1 },
          title: { type: 'string', maxLength: 512 },
        },
      },
      handler: async (params, ctx) => {
        const backend = requireSession(ctx.tenantId);
        const sessionId = stringParam(params, 'session_id');
        const title = stringParam(params, 'title');
        const state = await backend.load(sessionId);
        if (!state) throw new RpcError('not_found', 'Session not found');
        await backend.save({ ...state, title, updated_at: Date.now() });
        return { session_id: sessionId, title };
      },
    },
    {
      name: 'runs.list',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          status: { type: 'string' },
        },
      },
      handler: (params, ctx) => {
        const sessionFilter = typeof params.session_id === 'string' ? params.session_id : undefined;
        const statusFilter = typeof params.status === 'string' ? params.status : undefined;
        return {
          runs: [...runs.values()]
            .filter((record) => record.tenant_id === ctx.tenantId)
            .filter((record) => !sessionFilter || record.session_id === sessionFilter)
            .filter((record) => !statusFilter || record.status === statusFilter)
            .map(publicStatus),
        };
      },
    },
    {
      name: 'runs.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['run_id'],
        properties: { run_id: { type: 'string', minLength: 1 } },
      },
      handler: async (params, ctx) => {
        const runId = stringParam(params, 'run_id');
        const record = runs.get(runId);
        if (record && record.tenant_id === ctx.tenantId) return { run: publicStatus(record) };
        const store = opts.durable?.store;
        if (!store) throw new RpcError('not_found', `Run not found: ${runId}`);
        const checkpoint = await store.load(runId);
        if (!checkpoint) throw new RpcError('not_found', `Run not found: ${runId}`);
        return { run: checkpoint };
      },
    },
    {
      name: 'runs.start',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['input'],
        properties: {
          input: { type: 'string', minLength: 1 },
          session_id: { type: 'string' },
          tenant_id: { type: 'string' },
        },
      },
      handler: async (params, ctx) => {
        requireRuntime(ctx.tenantId);
        await enforceConcurrentQuota(ctx.tenantId);
        await checkQuota(ctx.tenantId, 'runs.start');
        return submitRun(params, ctx.tenantId);
      },
    },
    {
      name: 'runs.cancel',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['run_id'],
        properties: { run_id: { type: 'string', minLength: 1 } },
      },
      handler: (params, ctx) => ({
        cancelled: cancelRun(stringParam(params, 'run_id'), ctx.tenantId),
      }),
    },
    {
      name: 'runs.resume',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['run_id'],
        properties: { run_id: { type: 'string', minLength: 1 } },
      },
      handler: async (params) => {
        const durable = opts.durable;
        if (!durable?.store || !durable.resume) {
          throw new RpcError('not_found', 'Durable resume is not available');
        }
        const runId = stringParam(params, 'run_id');
        if (!reserveResume(runId)) {
          throw new RpcError('conflict', `Run is already being resumed: ${runId}`, {
            legacy_code: 'run_already_running',
          });
        }
        let checkpoint: Awaited<ReturnType<typeof durable.store.load>>;
        try {
          checkpoint = await durable.store.load(runId);
        } catch (error) {
          resumedRuns.delete(runId);
          mapTenantError(error);
        }
        if (!checkpoint) {
          resumedRuns.delete(runId);
          throw new RpcError('not_found', `Run not found: ${runId}`);
        }
        if (!isResumableStatus(checkpoint.status)) {
          resumedRuns.delete(runId);
          throw new RpcError('conflict', `Run is not resumable: ${runId}`, {
            legacy_code: 'run_not_resumable',
          });
        }
        try {
          await durable.resume(runId);
        } catch (error) {
          resumedRuns.delete(runId);
          const code = (error as { code?: unknown }).code;
          if (code === 'run_not_found' || code === 'run_store_required') {
            throw new RpcError(
              'not_found',
              error instanceof Error ? error.message : 'Run not found',
            );
          }
          throw new RpcError('conflict', error instanceof Error ? error.message : 'Resume failed');
        }
        return { run_id: runId, status: 'queued' };
      },
    },
    {
      name: 'events.list',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          since_seq: { type: 'integer', minimum: 0 },
          since_ts: { type: 'integer', minimum: 0 },
          types: { type: 'array', items: { type: 'string' } },
          type_prefix: { type: 'string' },
          limit: { type: 'integer', minimum: 0, maximum: 500 },
          all_tenants: { type: 'boolean' },
          tenant_id: { type: 'string' },
        },
      },
      handler: async (params, ctx) => {
        if (!opts.trace?.readEvents)
          throw new RpcError('not_found', 'Trace reader is not available');
        if (params.types !== undefined && params.type_prefix !== undefined) {
          throw new RpcError('invalid_params', 'types and type_prefix are mutually exclusive');
        }
        const filter: Record<string, unknown> = {};
        for (const key of [
          'run_id',
          'since_seq',
          'since_ts',
          'types',
          'type_prefix',
          'limit',
        ] as const) {
          if (params[key] !== undefined) filter[key] = params[key];
        }
        try {
          const events = await opts.trace.readEvents(filter, ctx.tenantId);
          return {
            events: events.filter((event) => eventVisible(event, ctx.tenantId, ctx.allTenants)),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('invalid_params')) {
            throw new RpcError('invalid_params', message);
          }
          throw new RpcError('internal', 'Failed to read trace');
        }
      },
    },
    {
      name: 'events.subscribe',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          since: { type: 'integer', minimum: 0 },
          since_ts: { type: 'integer', minimum: 0 },
          run_id: { type: 'string' },
          types: { type: 'array', items: { type: 'string' } },
          all_tenants: { type: 'boolean' },
          tenant_id: { type: 'string' },
        },
      },
      handler: (params, ctx) => {
        const since = typeof params.since === 'number' ? params.since : 0;
        const mode = ctx.connection === 'ws' ? 'ws' : 'stream';
        return {
          subscribed: true,
          from_seq: since + 1,
          latest_seq: buffer.latestSeq,
          mode,
          ...(ctx.connection === 'http'
            ? { stream_url: `/v1/events?since=${since}${ctx.allTenants ? '&all_tenants=1' : ''}` }
            : {}),
        };
      },
    },
    {
      name: 'tools.list',
      permission: 'read',
      params_schema: tenantParamSchema,
      handler: (_params, ctx) => toolsPayload(ctx.tenantId),
    },
    {
      name: 'plugins.list',
      permission: 'read',
      params_schema: { type: 'object' },
      handler: (_params, ctx) => ({ plugins: pluginsForTenant(ctx.tenantId) }),
    },
    {
      name: 'metrics.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['live', 'trace'] },
          tenant_id: { type: 'string' },
        },
      },
      handler: async (params, ctx) => {
        const source = params.source === 'trace' ? 'trace' : 'live';
        if (source === 'trace') {
          if (!opts.metricsControl?.rebuild) {
            throw new RpcError('not_found', 'Trace metrics rebuild is not available');
          }
          const snapshot = await opts.metricsControl.rebuild(ctx.tenantId);
          return { metrics: normalizeMetricsSnapshot(snapshot), source };
        }
        const provider = metricsProvider(ctx.tenantId);
        if (!provider) throw new RpcError('not_found', 'Metrics are not available');
        return { metrics: normalizeMetricsSnapshot(provider()), source };
      },
    },
    {
      name: 'metrics.reset',
      permission: 'write',
      params_schema: tenantParamSchema,
      handler: (_params, ctx) => {
        if (!opts.metricsControl?.reset) {
          throw new RpcError('not_found', 'Metrics reset is not available');
        }
        opts.metricsControl.reset(ctx.tenantId);
        return { ok: true };
      },
    },
    {
      name: 'mcp.list',
      permission: 'read',
      params_schema: { type: 'object' },
      handler: async () => {
        if (!opts.mcp) throw new RpcError('not_found', 'MCP is not enabled');
        try {
          return { servers: normalizeMcpServers(await opts.mcp.listServers()) };
        } catch {
          throw new RpcError('internal', 'Failed to read MCP server status');
        }
      },
    },
    {
      name: 'mcp.reconnect',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1 } },
      },
      handler: async (params, ctx) => {
        if (!opts.mcp?.reconnect) {
          throw new RpcError('not_found', 'MCP reconnect is not available');
        }
        await opts.mcp.reconnect(stringParam(params, 'name'));
        return { ok: true, tenant_id: ctx.tenantId };
      },
    },
    {
      name: 'trace.prune',
      permission: 'admin',
      params_schema: {
        type: 'object',
        properties: {
          older_than_days: { type: 'integer', minimum: 0 },
          max_runs: { type: 'integer', minimum: 0 },
          max_bytes: { type: 'integer', minimum: 0 },
          tenant_id: { type: 'string' },
        },
      },
      handler: async (params, ctx) => {
        if (!opts.trace?.prune) throw new RpcError('not_found', 'Trace prune is not available');
        return opts.trace.prune({ ...params, tenant_id: ctx.tenantId });
      },
    },
    {
      name: 'tenants.list',
      permission: 'admin',
      params_schema: { type: 'object' },
      handler: async () => {
        if (!opts.tenants) throw new RpcError('not_found', 'Tenant registry is not available');
        return { tenants: (await opts.tenants.list()).map(tenantInfoOrThrow) };
      },
    },
    {
      name: 'tenants.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['tenant_id'],
        properties: { tenant_id: { type: 'string', minLength: 1 } },
      },
      handler: async (params, ctx) => {
        if (!opts.tenants) throw new RpcError('not_found', 'Tenant registry is not available');
        const tenantId = stringParam(params, 'tenant_id');
        if (!ctx.isAdmin && tenantId !== ctx.principal.tenant_id) {
          throw new RpcError('forbidden', 'Cross-tenant access is not allowed');
        }
        const info = await opts.tenants.get(tenantId);
        if (!info) throw new RpcError('not_found', `Tenant not found: ${tenantId}`);
        return { tenant: tenantInfoOrThrow(info) };
      },
    },
    {
      name: 'tenants.create',
      permission: 'admin',
      params_schema: {
        type: 'object',
        required: ['tenant_id'],
        properties: {
          tenant_id: { type: 'string', minLength: 1 },
          name: { type: 'string' },
          quota: { type: 'object' },
        },
      },
      handler: async (params) => {
        if (!opts.tenants?.create) {
          throw new RpcError('not_found', 'Tenant create is not available');
        }
        const info = await opts.tenants.create(stringParam(params, 'tenant_id'), {
          ...(typeof params.name === 'string' ? { name: params.name } : {}),
          ...(typeof params.quota === 'object' && params.quota !== null
            ? { quota: params.quota as TenantQuota }
            : {}),
        });
        return { tenant: tenantInfoOrThrow(info) };
      },
    },
    {
      name: 'tenants.update',
      permission: 'admin',
      params_schema: {
        type: 'object',
        required: ['tenant_id'],
        properties: {
          tenant_id: { type: 'string', minLength: 1 },
          name: { type: 'string' },
          status: { type: 'string', enum: ['active', 'disabled'] },
          quota: { type: 'object' },
        },
      },
      handler: async (params) => {
        if (!opts.tenants?.update) {
          throw new RpcError('not_found', 'Tenant update is not available');
        }
        const info = await opts.tenants.update(stringParam(params, 'tenant_id'), {
          ...(typeof params.name === 'string' ? { name: params.name } : {}),
          ...(params.status === 'active' || params.status === 'disabled'
            ? { status: params.status }
            : {}),
          ...(typeof params.quota === 'object' && params.quota !== null
            ? { quota: params.quota as TenantQuota }
            : {}),
        });
        return { tenant: tenantInfoOrThrow(info) };
      },
    },
    {
      name: 'permission.respond',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['request_id', 'decision'],
        properties: {
          request_id: { type: 'string', minLength: 1 },
          decision: { type: 'string', enum: ['allow', 'deny'] },
          remember: { type: 'boolean' },
          tenant_id: { type: 'string' },
        },
      },
      handler: (params) => {
        const requestId = stringParam(params, 'request_id');
        const decision = params.decision;
        if (decision !== 'allow' && decision !== 'deny') {
          throw new RpcError('invalid_params', "decision must be 'allow' or 'deny'");
        }
        respondPermission(requestId, decision, params.remember === true);
        return { ok: true };
      },
    },
    {
      name: 'ask.respond',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['request_id', 'answers'],
        properties: {
          request_id: { type: 'string', minLength: 1 },
          answers: { type: 'array' },
          tenant_id: { type: 'string' },
        },
      },
      handler: (params) => {
        const answers = params.answers;
        if (!Array.isArray(answers)) {
          throw new RpcError('invalid_params', 'answers must be an array');
        }
        respondAsk(stringParam(params, 'request_id'), answers);
        return { ok: true };
      },
    },
    {
      name: 'workflow.list',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          tenant_id: { type: 'string' },
        },
      },
      handler: async (params) => {
        if (!opts.workflows) throw new RpcError('not_found', 'Workflow control is not enabled');
        const rawStatus = typeof params.status === 'string' ? params.status : null;
        const status = parseWorkflowStatus(rawStatus);
        if (rawStatus !== null && status === null) {
          throw new RpcError('invalid_params', 'Invalid workflow status filter');
        }
        const limit = parseWorkflowLimit(
          typeof params.limit === 'number' ? String(params.limit) : null,
        );
        if (limit === null) throw new RpcError('invalid_params', 'Invalid workflow limit');
        try {
          const list = await opts.workflows.listRuns({
            ...(status !== null ? { status } : {}),
            limit,
          });
          const summaries = list
            .map((run) => toWireWorkflowSummary(run))
            .filter((run): run is NonNullable<typeof run> => run !== null);
          return {
            workflows: sortWorkflowSummaries(dedupeWorkflowSummaries(summaries)).slice(0, limit),
          };
        } catch (error) {
          throwWorkflowError(error);
        }
      },
    },
    {
      name: 'workflow.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['workflow_run_id'],
        properties: { workflow_run_id: { type: 'string', minLength: 1 } },
      },
      handler: async (params) => {
        if (!opts.workflows) throw new RpcError('not_found', 'Workflow control is not enabled');
        const id = stringParam(params, 'workflow_run_id');
        try {
          const run = await opts.workflows.getRun(id);
          if (!run) throw new RpcError('not_found', `Workflow run not found: ${id}`);
          const detail = toWireWorkflowDetail(run);
          if (!detail) throw new RpcError('internal', 'Invalid workflow run payload');
          return { workflow: detail };
        } catch (error) {
          if (error instanceof RpcError) throw error;
          throwWorkflowError(error);
        }
      },
    },
    {
      name: 'workflow.start',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 64 },
          inputs: { type: 'object' },
          tenant_id: { type: 'string' },
        },
      },
      handler: async (params) => {
        if (!opts.workflows) throw new RpcError('not_found', 'Workflow control is not enabled');
        const name = stringParam(params, 'name').trim();
        if (!isSafeWorkflowName(name)) {
          throw new RpcError('invalid_params', 'Invalid workflow name');
        }
        const inputs = parseWorkflowInputs(params.inputs);
        if (inputs === null) {
          throw new RpcError('invalid_params', 'inputs must be a flat string map (max 64 entries)');
        }
        let definitionPath: string | undefined;
        try {
          definitionPath = opts.workflows.resolveDefinition(name);
        } catch {
          throw new RpcError('internal', 'Failed to resolve workflow definition');
        }
        if (definitionPath === undefined) {
          throw new RpcError('not_found', `Workflow not found: ${name}`);
        }
        try {
          const started = await opts.workflows.start(definitionPath, {
            ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
          });
          return { workflow_run_id: started.workflowRunId, status: 'queued' };
        } catch (error) {
          throwWorkflowError(error);
        }
      },
    },
    {
      name: 'workflow.resume',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['workflow_run_id'],
        properties: { workflow_run_id: { type: 'string', minLength: 1 } },
      },
      handler: async (params) => {
        if (!opts.workflows) throw new RpcError('not_found', 'Workflow control is not enabled');
        const id = stringParam(params, 'workflow_run_id');
        if (!reserveWorkflowResume(id)) {
          throw new RpcError('conflict', `Workflow run is already resuming: ${id}`, {
            legacy_code: 'workflow_already_running',
          });
        }
        try {
          const run = await opts.workflows.getRun(id);
          if (!run) throw new RpcError('not_found', `Workflow run not found: ${id}`);
          const summary = toWireWorkflowSummary(run);
          if (!summary) throw new RpcError('internal', 'Invalid workflow run payload');
          if (summary.status === 'running') {
            throw new RpcError('conflict', `Workflow run is already running: ${id}`, {
              legacy_code: 'workflow_already_running',
            });
          }
          if (summary.status === 'completed' || summary.status === 'cancelled') {
            throw new RpcError('conflict', `Workflow run is not resumable: ${id}`, {
              legacy_code: 'workflow_not_resumable',
            });
          }
          const resumed = await opts.workflows.resume(id);
          void resumed.done.finally(() => releaseWorkflowResume(id)).catch(() => undefined);
          return { workflow_run_id: resumed.workflowRunId, status: 'queued' };
        } catch (error) {
          releaseWorkflowResume(id);
          if (error instanceof RpcError) throw error;
          throwWorkflowError(error);
        }
      },
    },
    {
      name: 'workflow.cancel',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['workflow_run_id'],
        properties: { workflow_run_id: { type: 'string', minLength: 1 } },
      },
      handler: async (params) => {
        if (!opts.workflows) throw new RpcError('not_found', 'Workflow control is not enabled');
        const id = stringParam(params, 'workflow_run_id');
        try {
          const run = await opts.workflows.getRun(id);
          if (!run) throw new RpcError('not_found', `Workflow run not found: ${id}`);
          const summary = toWireWorkflowSummary(run);
          if (!summary) throw new RpcError('internal', 'Invalid workflow run payload');
          if (summary.status === 'cancelled') {
            return { workflow_run_id: id, status: 'cancelled' };
          }
          if (summary.status === 'completed' || summary.status === 'failed') {
            throw new RpcError('invalid_params', 'Run is not cancellable');
          }
          await opts.workflows.cancel(id);
          return { workflow_run_id: id, status: 'cancelled' };
        } catch (error) {
          if (error instanceof RpcError) throw error;
          throwWorkflowError(error);
        }
      },
    },
    {
      name: 'evals.latest',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['suite'],
        properties: { suite: { type: 'string', minLength: 1 } },
      },
      handler: async (params) => {
        const suite = stringParam(params, 'suite').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(suite) || suite.includes('..')) {
          throw new RpcError('invalid_params', 'Invalid suite name');
        }
        if (!opts.evals) throw new RpcError('not_found', 'Eval report not found');
        try {
          const report = await opts.evals.latest(suite);
          const normalized = report ? normalizeEvalReport(report) : null;
          if (!normalized) throw new RpcError('not_found', `Eval report not found: ${suite}`);
          return { report: normalized };
        } catch (error) {
          if (error instanceof RpcError) throw error;
          const code = (error as { code?: unknown }).code;
          if (code === 'eval_not_found') throw new RpcError('not_found', String(error));
          if (code === 'eval_invalid') throw new RpcError('invalid_params', String(error));
          throw new RpcError('internal', 'Failed to read eval report');
        }
      },
    },
    {
      name: 'evals.run',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['suite'],
        properties: { suite: { type: 'string', minLength: 1 } },
      },
      handler: async (params) => {
        if (!opts.evals?.run) throw new RpcError('not_found', 'Evals runner is not available');
        const suite = stringParam(params, 'suite');
        return { report: normalizeEvalReport(await opts.evals.run(suite)) };
      },
    },
    {
      name: 'feishu.status',
      permission: 'read',
      params_schema: { type: 'object' },
      handler: () => {
        if (!opts.feishu) throw new RpcError('not_found', 'Feishu channel is not enabled');
        return { channel: normalizeFeishuStatus(opts.feishu.status()) };
      },
    },
  ];

  const methodTable = defineMethods(rpcMethods);
  const dispatcher = createRpcDispatcher({
    table: methodTable,
    localPrincipal,
    makeContext: makeMethodContext,
    version: opts.version,
    describe: () => ({
      // gateway.manifest() 是默认 tenant 的兼容入口（asm local dispatcher 在用）
      tools: toolDescriptionsForTenant(defaultTenantId),
      plugins: pluginsForTenant(defaultTenantId),
    }),
  });
  let capabilityManifest: CapabilityManifest = dispatcher.manifest();
  const manifest = (): CapabilityManifest => {
    capabilityManifest = dispatcher.manifest();
    return capabilityManifest;
  };

  async function dispatchMethod(method: string, rawParams: unknown): Promise<unknown> {
    const params =
      rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
        ? (rawParams as Record<string, unknown>)
        : {};
    switch (method) {
      case 'run.submit':
        return submitRun(params);
      case 'run.cancel': {
        const id = params.run_id;
        if (typeof id !== 'string') throw new MethodError('invalid_request', 'run_id is required');
        return { cancelled: cancelRun(id) };
      }
      case 'run.get': {
        const id = params.run_id;
        if (typeof id !== 'string') throw new MethodError('invalid_request', 'run_id is required');
        const record = runs.get(id);
        if (!record) throw new MethodError('not_found', `Run not found: ${id}`);
        return publicStatus(record);
      }
      case 'sessions.list':
        return listSessions();
      case 'tools.list':
        return toolsPayload();
      case 'permission.respond': {
        const requestId = params.request_id;
        if (typeof requestId !== 'string') {
          throw new MethodError('invalid_request', 'request_id is required');
        }
        const decision = params.decision;
        if (decision !== 'allow' && decision !== 'deny') {
          throw new MethodError('invalid_request', "decision must be 'allow' or 'deny'");
        }
        respondPermission(requestId, decision, params.remember === true);
        return { ok: true };
      }
      case 'ask.respond': {
        const requestId = params.request_id;
        if (typeof requestId !== 'string') {
          throw new MethodError('invalid_request', 'request_id is required');
        }
        const answers = params.answers;
        if (!Array.isArray(answers)) {
          throw new MethodError('invalid_request', 'answers must be an array');
        }
        respondAsk(requestId, answers);
        return { ok: true };
      }
      case 'team.nodes':
      case 'team.dispatch':
      case 'team.task':
      case 'team.cancel':
        throw new MethodError(
          'method_not_allowed',
          'Team protocol is 0.2 (not implemented in 0.1.0)',
        );
      default:
        throw new MethodError('method_not_allowed', `Unknown method: ${method}`);
    }
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
      ws.data.tenantId = principal.tenant_id === '*' ? defaultTenantId : principal.tenant_id;
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
    const legacyMethod =
      frame.method === 'run.submit' ||
      frame.method === 'run.get' ||
      frame.method === 'run.cancel' ||
      frame.method === 'permission.respond' ||
      frame.method === 'ask.respond' ||
      frame.method.startsWith('team.');

    if (legacyMethod) {
      try {
        const result = await dispatchMethod(frame.method, frame.params);
        sendResult(ws, frame.id, true, result);
      } catch (error) {
        if (error instanceof RpcError) {
          sendResult(
            ws,
            frame.id,
            false,
            undefined,
            protocolError(legacyProtocolCode(error), error.message),
          );
        } else if (error instanceof MethodError) {
          sendResult(ws, frame.id, false, undefined, protocolError(error.code, error.message));
        } else {
          const message = error instanceof Error ? error.message : String(error);
          sendResult(ws, frame.id, false, undefined, protocolError('internal', message));
        }
      }
      return;
    }

    if (!methodTable.byName.has(frame.method)) {
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
      v: 1,
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
      if (frame.method === 'events.subscribe') applyWsSubscribe(ws, frame.params);
      sendResult(ws, frame.id, true, response.result);
    } else {
      sendResult(
        ws,
        frame.id,
        false,
        undefined,
        protocolError(response.error.code as ProtocolError['code'], response.error.message),
      );
    }
  }

  function legacyProtocolCode(error: RpcError): ProtocolError['code'] {
    const details = error.details as { legacy_code?: unknown } | undefined;
    if (details && typeof details.legacy_code === 'string') {
      return details.legacy_code as ProtocolError['code'];
    }
    if (error.code === 'invalid_params') return 'invalid_request';
    if (error.code === 'conflict') return 'busy';
    return error.code as ProtocolError['code'];
  }

  function applyWsSubscribe(ws: Ws, raw: unknown): void {
    const params =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    if (typeof params.since === 'number' && params.since >= 0) ws.data.since = params.since;
    ws.data.runId = typeof params.run_id === 'string' ? params.run_id : undefined;
    ws.data.types = Array.isArray(params.types)
      ? params.types.filter((item): item is string => typeof item === 'string')
      : undefined;
    ws.data.allTenants = params.all_tenants === true && ws.data.principal?.role === 'admin';
    replayEventsTo(ws);
  }

  /** 授权：Bearer 头优先，兼容 ?token=；返回 principal */
  function principalForRequest(req: Request, url: URL): TenantPrincipal | null {
    const raw = extractToken(req.headers.get('authorization'), url.searchParams.get('token'));
    return resolvePrincipal(opts.auth, raw, token);
  }

  function authorized(req: Request, url: URL): boolean {
    return principalForRequest(req, url) !== null;
  }

  /** 方法级 tenant 作用域（admin 可显式跨 tenant） */
  function makeMethodContext(
    method: RpcMethodDefinition,
    params: Record<string, unknown>,
    principal: TenantPrincipal,
    connection: RpcMethodContext['connection'],
  ): RpcMethodContext {
    const scope = resolveTenantScope(principal, params, defaultTenantId);
    return {
      principal,
      tenantId: scope.tenantId,
      allTenants: method.name === 'events.subscribe' ? scope.allTenants : false,
      isAdmin: principal.role === 'admin',
      connection,
    };
  }

  /** per-tenant 执行面；非 default 无工厂 → forbidden（A-3 §10.4） */
  function runtimeFor(tenantId: string): RunnableAgent | undefined {
    if (tenantId === defaultTenantId) return runtime;
    return opts.runtimeFor?.(tenantId);
  }

  function sessionFor(tenantId: string): SessionBackend | undefined {
    if (tenantId === defaultTenantId) return session;
    return opts.sessionFor?.(tenantId);
  }

  function pluginHostFor(tenantId: string): PluginHost | undefined {
    if (tenantId === defaultTenantId) return pluginHost();
    return opts.pluginHostFor?.(tenantId);
  }

  /** A-6.3：capabilities.list 的 tools；未注入 per-tenant 时回退全局 host */
  function toolDescriptionsForTenant(
    tenantId: string,
  ): Array<{ name: string; description?: string }> {
    // A6-24：一旦注入 pluginHostFor，非 default tenant 未命中时返回空，
    // 不得回退全局 host（否则 tenant b 会看到 default 的 tools）。
    // 只有未注入 pluginHostFor 的单 tenant / legacy 路径才回退全局。
    let host: PluginHost | undefined;
    if (tenantId === defaultTenantId) {
      host = pluginHost();
    } else if (opts.pluginHostFor) {
      host = opts.pluginHostFor(tenantId);
    } else {
      host = pluginHost();
    }
    try {
      return (host?.listTools() ?? []).map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
      }));
    } catch {
      return [];
    }
  }

  /** A-6.3：per-tenant plugins；只有未注入 pluginsFor 时才回退全局 `plugins` */
  function pluginsForTenant(tenantId: string): Array<{ name: string; enabled: boolean }> {
    if (tenantId !== defaultTenantId && opts.pluginsFor) {
      return opts.pluginsFor(tenantId) ?? [];
    }
    return opts.pluginsFor?.(tenantId) ?? opts.plugins?.() ?? [];
  }

  function requireRuntime(tenantId: string): RunnableAgent {
    const resolved = runtimeFor(tenantId);
    if (!resolved) {
      // 非 default tenant 未注入 runtimeFor → forbidden；default 保持旧码。
      if (tenantId !== defaultTenantId) {
        throw new RpcError('forbidden', `Tenant runtime is not configured: ${tenantId}`);
      }
      throw new RpcError('forbidden', 'No runtime configured', { legacy_code: 'no_runtime' });
    }
    return resolved;
  }

  function requireSession(tenantId: string): SessionBackend {
    const resolved = sessionFor(tenantId);
    if (!resolved) {
      if (tenantId !== defaultTenantId) {
        throw new RpcError('forbidden', `Tenant session backend is not configured: ${tenantId}`);
      }
      throw new RpcError('not_found', 'No session backend configured');
    }
    return resolved;
  }

  /** 静态资源响应（同源托管 apps/web/dist） */
  async function serveStatic(pathname: string): Promise<Response | null> {
    if (!opts.staticDir) return null;
    const root = resolve(opts.staticDir);
    let relative = pathname;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    relative = relative.replace(/^\/+/, '');
    const target = resolve(root, relative || 'index.html');
    if (target !== root && !target.startsWith(root + sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    const file = Bun.file(target);
    if (await file.exists()) {
      const stat = await file.stat();
      if (!stat.isDirectory()) return fileResponse(file, target);
    }
    if (!extname(target)) {
      const index = Bun.file(resolve(root, 'index.html'));
      if (await index.exists()) return fileResponse(index, resolve(root, 'index.html'));
    }
    return null;
  }

  function fileResponse(file: Bun.BunFile, path: string): Response {
    const isHtml = path.toLowerCase().endsWith('.html');
    const headers: Record<string, string> = {
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    };
    if (isHtml) headers['Content-Security-Policy'] = CSP;
    return new Response(file, { headers });
  }

  // ── R3 team 端点 ───────────────────────────────

  /** 发布 team/agent 事件（core 内部 camelCase；gateway 边界统一转 snake_case） */
  function publishTeamEvent(type: string, data: Record<string, unknown>): void {
    events.publish({ type, run_id: 'team', data, ts: Date.now() });
  }

  function publishTeamError(error: unknown): void {
    publishTeamEvent('team.transport.error', {
      code: (error as { code?: string }).code ?? 'internal',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  /** TeamProtocolError / PeerTransportError → HTTP */
  function teamErrorResponse(error: unknown, extra: Record<string, string>): Response {
    if (error instanceof TeamProtocolError) {
      const status = error.code === 'not_found' || error.code === 'agent_not_found' ? 404 : 400;
      return errorJson(error.code as ProtocolError['code'], error.message, status, extra);
    }
    const code = (error as { code?: string }).code;
    if (code) {
      const status =
        code === 'unauthorized'
          ? 401
          : code === 'unsupported_protocol'
            ? 426
            : code === 'peer_not_found'
              ? 404
              : code === 'transport_closed'
                ? 409
                : code === 'timeout'
                  ? 504
                  : code === 'peer_unreachable' || code === 'peer_error'
                    ? 502
                    : 400;
      return errorJson(
        code as ProtocolError['code'],
        error instanceof Error ? error.message : String(error),
        status,
        extra,
      );
    }
    return errorJson(
      'internal',
      error instanceof Error ? error.message : String(error),
      500,
      extra,
    );
  }

  /** 入站投递：deliver 注入优先 → transport.deliver → host.send */
  async function deliverInbound(message: AgentMessage): Promise<boolean> {
    const t = team;
    if (!t) throw new TeamProtocolError('team_disabled', 'Team is not enabled');
    if (isRemoteAddress(message.to, t.nodeId)) {
      throw new TeamProtocolError('agent_not_found', `Cannot relay to another node: ${message.to}`);
    }
    if (seenInbound.has(message.id)) return false;
    seenInbound.set(message.id, true);
    while (seenInbound.size > 1000) {
      const first = seenInbound.keys().next();
      if (first.done) break;
      seenInbound.delete(first.value);
    }
    const local = normalizeLocalAddress(message, t.nodeId);
    if (t.deliver) {
      await t.deliver(local);
      return true;
    }
    const withDeliver = t.transport as unknown as {
      deliver?: (msg: AgentMessage) => boolean | Promise<boolean>;
    };
    if (typeof withDeliver?.deliver === 'function') {
      const result = await withDeliver.deliver(local);
      return result !== false;
    }
    if (t.host?.send) {
      await t.host.send(local);
      return true;
    }
    throw new TeamProtocolError('no_host', 'No team delivery handler configured');
  }

  /** team 事件 SSE */
  function openTeamStream(url: URL, extra: Record<string, string>): Response {
    const agentId = url.searchParams.get('agent_id') ?? undefined;
    const since = parseSince(url.searchParams.get('since'));
    let controller: SseController | undefined;
    let state: TeamClientState | undefined;
    const stream = new ReadableStream<unknown>(
      {
        start(ctrl) {
          controller = ctrl;
          const clientState: TeamClientState = {
            ...(agentId !== undefined ? { agentId } : {}),
            backpressure: new ClientBackpressure({
              high: SSE_HIGH_WATER_FRAMES,
              low: SSE_LOW_WATER_FRAMES,
            }),
            unacked: 0,
            encodeGap: (gap) =>
              `data: ${JSON.stringify({
                protocol: 1,
                node_id: nodeId,
                kind: 'gap',
                from_seq: gap.from_seq,
                to_seq: gap.to_seq,
              })}\n\n`,
            onClose: () => teamClients.delete(ctrl),
          };
          state = clientState;
          teamClients.set(ctrl, clientState);
          writeSse(ctrl, clientState, 'retry: 3000\n\n');
          const latest = buffer.latestSeq;
          writeSse(
            ctrl,
            clientState,
            `data: ${JSON.stringify({
              protocol: 1,
              node_id: nodeId,
              kind: 'team.hello',
              from_seq: latest === 0 ? 0 : Math.max(since + 1, buffer.oldestSeq),
              latest_seq: latest,
            })}\n\n`,
          );
          const gap = buffer.gapFor(since);
          if (gap) writeSse(ctrl, clientState, clientState.encodeGap(gap));
          clientState.replay = {
            cursor: Math.max(since + 1, buffer.oldestSeq),
            batch: SSE_REPLAY_BATCH,
            accepts: (event) => {
              if (!isTeamEvent(event)) return false;
              if (agentId === undefined) return true;
              const wire = toWireEvent(event);
              return (wire.data as Record<string, unknown>).agent_id === agentId;
            },
            encode: (item) => {
              const wire = toWireEvent(item.event);
              return `data: ${JSON.stringify({
                protocol: 1,
                node_id: nodeId,
                seq: item.seq,
                kind: 'team.event',
                event: wire,
              })}\n\n`;
            },
          };
          if (clientState.replay.cursor > buffer.latestSeq) clientState.replay = undefined;
        },
        pull() {
          if (!controller || !state) return;
          state.unacked = 0;
          pumpSseReplay(controller, state);
          flushSseGap(controller, state);
        },
        cancel() {
          if (controller) teamClients.delete(controller);
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

  /** `/v1/team/*` 路由；未启用 team 返回 404 */
  async function handleTeam(
    req: Request,
    url: URL,
    path: string,
    extra: Record<string, string>,
  ): Promise<Response | null> {
    if (path !== '/v1/team' && !path.startsWith('/v1/team/')) return null;
    const t = team;
    if (!t) return errorJson('not_found', `Not found: ${path}`, 404, extra);

    if (path === '/v1/team/peers' && req.method === 'GET') {
      let peers = t.transport ? await t.transport.peers().catch(() => []) : [];
      if (peers.length === 0) {
        peers = [
          {
            nodeId: t.nodeId,
            agents: t.host?.list() ?? [],
            protocol: 1,
          },
        ];
      }
      return json({ protocol: 1, node_id: t.nodeId, peers: peers.map(toWirePeer) }, 200, extra);
    }

    if (path === '/v1/team/messages' && req.method === 'POST') {
      const body = await readJsonBody(req, maxBodyBytes);
      if (body instanceof Response) return body;
      if (body.protocol !== 1) {
        return errorJson('unsupported_protocol', 'protocol must be 1', 426, extra);
      }
      let message: AgentMessage;
      try {
        message = fromWireMessage(body.message);
      } catch (error) {
        return teamErrorResponse(error, extra);
      }
      // F9：入站 HTTP 不接受跨节点广播；本地 /v1/team/send 的 '*' 仍然允许。
      if (message.to === '*') {
        return errorJson(
          'broadcast_not_supported',
          'Inbound broadcast is not supported; use a concrete recipient',
          400,
          extra,
        );
      }
      // F11：有 node 前缀的 from 必须与 envelope node_id 一致（防伪）；本机简写放行。
      const fromNode = parseAddress(message.from).nodeId;
      if (fromNode !== undefined && body.node_id !== fromNode) {
        return errorJson('invalid_request', 'body.node_id must match message.from', 400, extra);
      }
      try {
        const accepted = await deliverInbound(message);
        const target = message.to === '*' ? undefined : parseAddress(message.to).agentId;
        publishTeamEvent('team.message.received', {
          messageId: message.id,
          from: message.from,
          to: message.to,
          kind: message.kind,
          ...(target ? { agentId: target } : {}),
        });
        return json(
          {
            protocol: 1,
            ok: true,
            message_id: message.id,
            ...(accepted ? {} : { deduplicated: true }),
            cursor: String(++inboundCursor),
          },
          accepted ? 202 : 200,
          extra,
        );
      } catch (error) {
        return teamErrorResponse(error, extra);
      }
    }

    if (path === '/v1/team/send' && req.method === 'POST') {
      if (!t.transport) {
        return errorJson('team_disabled', 'No loopback transport configured', 404, extra);
      }
      const body = await readJsonBody(req, maxBodyBytes);
      if (body instanceof Response) return body;
      if (body.protocol !== 1) {
        return errorJson('unsupported_protocol', 'protocol must be 1', 426, extra);
      }
      let message: AgentMessage;
      try {
        message = fromWireMessage(body.message);
      } catch (error) {
        return teamErrorResponse(error, extra);
      }
      try {
        await t.transport.send(message);
        publishTeamEvent('team.message.sent', {
          messageId: message.id,
          from: message.from,
          to: message.to,
          kind: message.kind,
        });
        return json({ protocol: 1, ok: true, message_id: message.id }, 202, extra);
      } catch (error) {
        publishTeamError(error);
        return teamErrorResponse(error, extra);
      }
    }

    if (path === '/v1/team/inbox' && req.method === 'GET') {
      if (!t.host) return errorJson('no_host', 'No team host configured', 400, extra);
      const agentId = url.searchParams.get('agent_id');
      if (!agentId || agentId.includes(':')) {
        return errorJson('invalid_request', 'agent_id must be a local agent id', 400, extra);
      }
      const cursor = url.searchParams.get('cursor') ?? undefined;
      try {
        const page = await t.host.inbox(agentId, cursor);
        return json(
          {
            protocol: 1,
            agent_id: agentId,
            messages: page.messages.map(toWireMessage),
            cursor: page.cursor,
          },
          200,
          extra,
        );
      } catch (error) {
        return teamErrorResponse(error, extra);
      }
    }

    if (path === '/v1/team/stream' && req.method === 'GET') {
      return openTeamStream(url, extra);
    }

    if (path === '/v1/team/agents') {
      if (req.method === 'GET') {
        if (!t.host) return errorJson('no_host', 'No team host configured', 400, extra);
        return json({ protocol: 1, agents: t.host.list().map(toWireAgentStatus) }, 200, extra);
      }
      if (req.method === 'POST') {
        if (!t.spawn) return errorJson('no_spawn', 'No spawn handler configured', 400, extra);
        const body = await readJsonBody(req, maxBodyBytes);
        if (body instanceof Response) return body;
        const name = body.name;
        const model = body.model;
        const systemPrompt = body.system_prompt;
        if (name !== undefined && typeof name !== 'string') {
          return errorJson('invalid_request', 'name must be a string', 400, extra);
        }
        if (model !== undefined && typeof model !== 'string') {
          return errorJson('invalid_request', 'model must be a string', 400, extra);
        }
        if (systemPrompt !== undefined && typeof systemPrompt !== 'string') {
          return errorJson('invalid_request', 'system_prompt must be a string', 400, extra);
        }
        try {
          const status = await t.spawn({
            ...(name !== undefined ? { name } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          });
          return json({ protocol: 1, agent: toWireAgentStatus(status) }, 201, extra);
        } catch (error) {
          return teamErrorResponse(error, extra);
        }
      }
    }

    const agentMatch = path.match(/^\/v1\/team\/agents\/([^/]+)(?:\/(cancel|close))?$/);
    if (agentMatch) {
      const id = decodeURIComponent(agentMatch[1] ?? '');
      const action = agentMatch[2];
      if (id.includes(':')) {
        if (action === 'cancel') {
          return errorJson(
            'remote_cancel_not_supported',
            'Remote agents are addressed by messages; HTTP endpoints are local-only',
            400,
            extra,
          );
        }
        return errorJson('agent_not_found', `Remote agent is not local: ${id}`, 404, extra);
      }
      if (action === 'cancel' && req.method === 'POST') {
        if (!t.host) return errorJson('no_host', 'No team host configured', 400, extra);
        // F10：未知 agent 返回 404，不让 host.cancel 抛成 500。
        if (!t.host.get(id)) {
          return errorJson('agent_not_found', `Unknown agent: ${id}`, 404, extra);
        }
        try {
          t.host.cancel(id);
        } catch (error) {
          return errorJson(
            'agent_not_found',
            error instanceof Error ? error.message : `Unknown agent: ${id}`,
            404,
            extra,
          );
        }
        return json({ protocol: 1, cancelled: true }, 200, extra);
      }
      if (action === 'close' && req.method === 'POST') {
        const handle = t.host?.get(id);
        if (!handle) return errorJson('agent_not_found', `Unknown agent: ${id}`, 404, extra);
        await handle.close();
        return json({ protocol: 1, closed: true }, 200, extra);
      }
      if (!action && req.method === 'GET') {
        if (!t.host) return errorJson('no_host', 'No team host configured', 400, extra);
        const status = t.host.get(id)?.status() ?? t.host.list().find((item) => item.id === id);
        if (!status) return errorJson('agent_not_found', `Unknown agent: ${id}`, 404, extra);
        return json({ protocol: 1, agent: toWireAgentStatus(status) }, 200, extra);
      }
    }

    return errorJson('not_found', `Not found: ${path}`, 404, extra);
  }

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

  /** `/v1/durable/*`：只读 store，不写盘、不创建 run */
  async function handleDurable(
    req: Request,
    url: URL,
    path: string,
    extra: Record<string, string>,
  ): Promise<Response | null> {
    if (path !== '/v1/durable' && !path.startsWith('/v1/durable/')) return null;
    const durable = opts.durable;

    if (path === '/v1/durable/runs') {
      if (req.method !== 'GET') {
        return errorJson('method_not_allowed', 'Method not allowed', 405, extra);
      }
      if (!durable) {
        return errorJson('durable_disabled', 'Durable runs are not enabled', 503, extra);
      }
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
      if (!durable) {
        return errorJson('durable_disabled', 'Durable runs are not enabled', 503, extra);
      }
      if (!durable.resume) {
        return errorJson(
          'durable_disabled',
          'Durable resume is not available in this mode',
          503,
          extra,
        );
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

  // ── 0.4 workflow / metrics / feishu / evals 端点 ──

  const methodNotAllowed = (extra: Record<string, string>): Response =>
    errorJson('method_not_allowed', 'Method not allowed', 405, extra);

  /** workflow 控制面错误 → HTTP；未知 code 一律 500，不泄露内部堆栈 */
  function workflowErrorResponse(error: unknown, extra: Record<string, string>): Response {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    switch (code) {
      case 'workflow_not_found':
        return errorJson('workflow_not_found', message, 404, extra);
      case 'workflow_invalid':
        return errorJson('workflow_invalid', message, 400, extra);
      case 'workflow_already_running':
        return errorJson('workflow_already_running', message, 409, extra);
      case 'workflow_not_resumable':
        return errorJson('workflow_not_resumable', message, 409, extra);
      case 'workflow_cancelled':
        // 不新增协议码（DECISION-009 §10.3.7）
        return errorJson('workflow_invalid', message, 409, extra);
      case 'workflow_disabled':
        return errorJson('workflow_disabled', message, 503, extra);
      default:
        return errorJson('internal', 'Workflow operation failed', 500, extra);
    }
  }

  /** 原子占位：同一 workflow run 同时只允许一个 resume */
  function reserveWorkflowResume(runId: string): boolean {
    if (resumedWorkflows.has(runId)) return false;
    resumedWorkflows.add(runId);
    while (resumedWorkflows.size > 1000) {
      const first = resumedWorkflows.keys().next();
      if (first.done) break;
      if (first.value === runId) break;
      resumedWorkflows.delete(first.value);
    }
    return true;
  }

  function releaseWorkflowResume(runId: string): void {
    resumedWorkflows.delete(runId);
  }

  function decodeWorkflowId(raw: string): string | null {
    let id: string;
    try {
      id = decodeURIComponent(raw);
    } catch {
      return null;
    }
    return id.length > 0 && id.length <= 256 ? id : null;
  }

  /** inputs 只接受扁平 string map；上限防止请求体外的二次膨胀 */
  function parseWorkflowInputs(raw: unknown): Record<string, string> | null {
    if (raw === undefined) return {};
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > 64) return null;
    const inputs: Record<string, string> = {};
    for (const [key, value] of entries) {
      if (key.length === 0 || key.length > 64) return null;
      if (typeof value !== 'string' || value.length > 10_000) return null;
      inputs[key] = value;
    }
    return inputs;
  }

  /** `/v1/workflows*`：列表 / 详情 / 启动 / 恢复 / 取消 */
  async function handleWorkflows(
    req: Request,
    url: URL,
    path: string,
    extra: Record<string, string>,
  ): Promise<Response | null> {
    if (path !== '/v1/workflows' && !path.startsWith('/v1/workflows/')) return null;
    const workflows = opts.workflows;
    const disabled = (): Response =>
      errorJson('workflow_disabled', 'Workflow control is not enabled', 503, extra);

    if (path === '/v1/workflows') {
      if (req.method !== 'GET') return methodNotAllowed(extra);
      if (!workflows) return disabled();
      const rawStatus = url.searchParams.get('status');
      const status: WorkflowRunStatus | null = parseWorkflowStatus(rawStatus);
      if (rawStatus !== null && status === null) {
        return errorJson('invalid_request', 'Invalid workflow status filter', 400, extra);
      }
      const limit = parseWorkflowLimit(url.searchParams.get('limit'));
      if (limit === null) {
        return errorJson(
          'invalid_request',
          `limit must be an integer between 1 and ${MAX_WORKFLOW_LIMIT}`,
          400,
          extra,
        );
      }
      try {
        const runs = await workflows.listRuns({
          ...(status !== null ? { status } : {}),
          limit,
        });
        const summaries = runs
          .map((run) => toWireWorkflowSummary(run))
          .filter((run): run is NonNullable<typeof run> => run !== null);
        return json(
          {
            workflows: sortWorkflowSummaries(dedupeWorkflowSummaries(summaries)).slice(0, limit),
          },
          200,
          extra,
        );
      } catch (error) {
        return workflowErrorResponse(error, extra);
      }
    }

    if (path === '/v1/workflows/run') {
      if (req.method !== 'POST') return methodNotAllowed(extra);
      if (!workflows) return disabled();
      const body = await readJsonBody(req, maxBodyBytes);
      if (body instanceof Response) return body;
      const rawName = body.name;
      if (typeof rawName !== 'string' || rawName.trim().length === 0) {
        return errorJson('invalid_request', 'name is required', 400, extra);
      }
      const name = rawName.trim();
      if (!isSafeWorkflowName(name)) {
        return errorJson('workflow_invalid', 'Invalid workflow name', 400, extra);
      }
      const inputs = parseWorkflowInputs(body.inputs);
      if (inputs === null) {
        return errorJson(
          'invalid_request',
          'inputs must be a flat string map (max 64 entries)',
          400,
          extra,
        );
      }
      let definitionPath: string | undefined;
      try {
        definitionPath = workflows.resolveDefinition(name);
      } catch {
        return errorJson('internal', 'Failed to resolve workflow definition', 500, extra);
      }
      if (definitionPath === undefined) {
        return errorJson('workflow_not_found', `Workflow not found: ${name}`, 404, extra);
      }
      try {
        const started = await workflows.start(definitionPath, {
          ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
        });
        return json({ workflow_run_id: started.workflowRunId, status: 'queued' }, 202, extra);
      } catch (error) {
        return workflowErrorResponse(error, extra);
      }
    }

    const match = path.match(/^\/v1\/workflows\/([^/]+)(?:\/(resume|cancel))?$/);
    if (!match) return errorJson('not_found', `Not found: ${path}`, 404, extra);
    const workflowRunId = decodeWorkflowId(match[1] ?? '');
    if (workflowRunId === null) {
      return errorJson('invalid_request', 'Invalid workflow run id', 400, extra);
    }
    const action = match[2];

    if (action === 'resume') {
      if (req.method !== 'POST') return methodNotAllowed(extra);
      if (!workflows) return disabled();
      // 占位必须在任何 await 之前，保证并发 resume 只有一个通过。
      if (!reserveWorkflowResume(workflowRunId)) {
        return errorJson(
          'workflow_already_running',
          `Workflow run is already resuming: ${workflowRunId}`,
          409,
          extra,
        );
      }
      try {
        const run = await workflows.getRun(workflowRunId);
        if (!run) {
          releaseWorkflowResume(workflowRunId);
          return errorJson(
            'workflow_not_found',
            `Workflow run not found: ${workflowRunId}`,
            404,
            extra,
          );
        }
        const summary = toWireWorkflowSummary(run);
        if (!summary) {
          releaseWorkflowResume(workflowRunId);
          return errorJson('internal', 'Invalid workflow run payload', 500, extra);
        }
        if (summary.status === 'running') {
          releaseWorkflowResume(workflowRunId);
          return errorJson(
            'workflow_already_running',
            `Workflow run is already running: ${workflowRunId}`,
            409,
            extra,
          );
        }
        if (summary.status === 'completed' || summary.status === 'cancelled') {
          releaseWorkflowResume(workflowRunId);
          return errorJson(
            'workflow_not_resumable',
            `Workflow run is not resumable: ${workflowRunId}`,
            409,
            extra,
          );
        }
        const resumed = await workflows.resume(workflowRunId);
        // done 恰好 resolve 一次；不阻塞 HTTP 响应。
        void resumed.done
          .finally(() => releaseWorkflowResume(workflowRunId))
          .catch(() => undefined);
        return json({ workflow_run_id: resumed.workflowRunId, status: 'queued' }, 202, extra);
      } catch (error) {
        releaseWorkflowResume(workflowRunId);
        return workflowErrorResponse(error, extra);
      }
    }

    if (action === 'cancel') {
      if (req.method !== 'POST') return methodNotAllowed(extra);
      if (!workflows) return disabled();
      try {
        const run = await workflows.getRun(workflowRunId);
        if (!run) {
          return errorJson(
            'workflow_not_found',
            `Workflow run not found: ${workflowRunId}`,
            404,
            extra,
          );
        }
        const summary = toWireWorkflowSummary(run);
        if (!summary) return errorJson('internal', 'Invalid workflow run payload', 500, extra);
        if (summary.status === 'cancelled') {
          return json({ workflow_run_id: workflowRunId, status: 'cancelled' }, 202, extra);
        }
        if (summary.status === 'completed' || summary.status === 'failed') {
          return errorJson('workflow_invalid', 'Run is not cancellable', 409, extra);
        }
        await workflows.cancel(workflowRunId);
        return json({ workflow_run_id: workflowRunId, status: 'cancelled' }, 202, extra);
      } catch (error) {
        return workflowErrorResponse(error, extra);
      }
    }

    if (req.method !== 'GET') return methodNotAllowed(extra);
    if (!workflows) return disabled();
    try {
      const run = await workflows.getRun(workflowRunId);
      if (!run) {
        return errorJson(
          'workflow_not_found',
          `Workflow run not found: ${workflowRunId}`,
          404,
          extra,
        );
      }
      const detail = toWireWorkflowDetail(run);
      if (!detail) return errorJson('internal', 'Invalid workflow run payload', 500, extra);
      return json({ workflow: detail }, 200, extra);
    } catch (error) {
      return workflowErrorResponse(error, extra);
    }
  }

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

  function legacyStatus(code: ProtocolError['code'], fallback = 400): number {
    switch (code) {
      case 'unauthorized':
        return 401;
      case 'forbidden':
        return 403;
      case 'not_found':
      case 'run_not_found':
      case 'workflow_not_found':
      case 'eval_not_found':
        return 404;
      case 'method_not_allowed':
        return 405;
      case 'conflict':
      case 'run_already_running':
      case 'workflow_already_running':
      case 'workflow_not_resumable':
      case 'tenant_locked':
        return 409;
      case 'busy':
        return 429;
      case 'quota_exceeded':
      case 'payload_too_large':
        return code === 'quota_exceeded' ? 429 : 413;
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
      { v: 1, id: randomUUID(), method, params },
      principal,
      'http',
    );
    if (response.ok) return response.result;
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
    ): Response => json({ v: 1, id, ok: false, error: { code, message } }, status, extra);

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
    if (record.v !== 1) {
      return rpcFailure(id, 'invalid_params', 'v must be 1', 400);
    }
    if (id.length === 0) {
      return rpcFailure('', 'invalid_params', 'id is required', 400);
    }
    if (typeof record.method !== 'string' || record.method.length === 0) {
      return rpcFailure(id, 'invalid_params', 'method is required', 400);
    }

    const request: RpcRequest = {
      v: 1,
      id,
      method: record.method,
      ...(record.params !== undefined ? { params: record.params } : {}),
    };
    const response: RpcResponse = await dispatcher.dispatchFor(request, principal, 'http');
    return json(response, 200, extra);
  }

  function startTeamPolling(): void {
    if (teamPollTimer) clearInterval(teamPollTimer);
    teamPollTimer = undefined;
    if (!team?.transport) return;
    const poll = async (): Promise<void> => {
      const t = team;
      if (!t?.transport) return;
      try {
        const peers = await t.transport.peers();
        const current = new Set(peers.map((peer) => peer.nodeId));
        for (const id of current) {
          if (id !== nodeId && !knownPeers.has(id)) {
            publishTeamEvent('team.peer.joined', { nodeId: id });
          }
        }
        for (const id of knownPeers) {
          if (id !== nodeId && !current.has(id)) {
            publishTeamEvent('team.peer.left', { nodeId: id });
          }
        }
        knownPeers = current;
      } catch (error) {
        publishTeamError(error);
      }
    };
    void poll();
    teamPollTimer = setInterval(() => {
      void poll();
    }, team?.peerPollMs ?? 5_000);
    (teamPollTimer as { unref?: () => void }).unref?.();
  }

  /** 启动后接入 team（asm 先拿端口构造 transport） */
  function attachTeam(next: TeamGatewayOptions): void {
    if (next.nodeId !== nodeId) {
      throw new Error(`team.nodeId "${next.nodeId}" must match gateway nodeId "${nodeId}"`);
    }
    team = next;
    knownPeers = new Set();
    startTeamPolling();
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
        if (path === '/v1/health' && allowRemote && !authorized(req, url)) {
          return errorJson('unauthorized', 'Missing or invalid token', 401, extra);
        }
        const base = {
          status: 'ok',
          clients: sseClients.size + wsClients.size,
          latest_seq: buffer.latestSeq,
        };
        if (path === '/health') return json(base, 200, extra);
        const teamInfo = team
          ? {
              enabled: true,
              node_id: team.nodeId,
              transport: team.transport?.kind ?? 'in-process',
            }
          : { enabled: false };
        return json(
          {
            ...base,
            protocol: protocolInfo,
            node: nodeInfo(),
            started_at: startedAt,
            team: teamInfo,
          },
          200,
          extra,
        );
      }

      const isWebSocket = (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';

      // WS：/v1/events?since=N（/ws 为 0.1.0 兼容别名）
      if ((path === '/v1/events' || path === '/ws') && isWebSocket) {
        const principal = resolvePrincipal(
          opts.auth,
          extractToken(null, url.searchParams.get('token')),
          token,
        );
        const upgraded = srv.upgrade(req, {
          data: {
            authed: principal !== null,
            ...(principal ? { principal } : {}),
            tenantId:
              principal !== null && principal.tenant_id !== '*'
                ? principal.tenant_id
                : defaultTenantId,
            allTenants: false,
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

      // 静态 web 公开（GET/HEAD；API 路径不参与）
      const isApiPath =
        path === '/v1' ||
        path.startsWith('/v1/') ||
        path === '/sessions' ||
        path === '/run' ||
        path === '/events' ||
        path === '/ws';
      if (!isApiPath && (req.method === 'GET' || req.method === 'HEAD')) {
        const staticResponse = await serveStatic(path);
        if (staticResponse) {
          for (const [key, value] of Object.entries(extra)) staticResponse.headers.set(key, value);
          return staticResponse;
        }
        // 配了 staticDir 就没有「未知非 API 路径」可回落——直接 404，不要求 token。
        if (opts.staticDir) return errorJson('not_found', `Not found: ${path}`, 404, extra);
      }

      const principal = principalForRequest(req, url);
      if (!principal) {
        return errorJson('unauthorized', 'Missing or invalid token', 401, extra);
      }

      // 0.5：统一 RPC 入口（方法错误 HTTP 200 + ok:false）
      if (path === '/v1/rpc') {
        if (req.method !== 'POST') return methodNotAllowed(extra);
        return handleRpc(req, principal, extra);
      }

      // R3：team 端点（默认关闭 → 404）
      const teamResponse = await handleTeam(req, url, path, extra);
      if (teamResponse) return teamResponse;

      // 0.3：durable / MCP（未注入 → 503 *_disabled）
      const durableResponse = await handleDurable(req, url, path, extra);
      if (durableResponse) return durableResponse;
      const mcpResponse = await handleMcp(req, path, extra, principal);
      if (mcpResponse) return mcpResponse;

      // 0.4：workflow / metrics / feishu / evals（未注入 → 稳定错误码）
      const workflowsResponse = await handleWorkflows(req, url, path, extra);
      if (workflowsResponse) return workflowsResponse;
      const metricsResponse = await handleMetrics(req, path, extra, principal);
      if (metricsResponse) return metricsResponse;
      const feishuResponse = await handleFeishu(req, path, extra, principal);
      if (feishuResponse) return feishuResponse;
      const evalsResponse = await handleEvals(req, url, path, extra, principal);
      if (evalsResponse) return evalsResponse;

      // SSE：只读事件流（EventSource 无法带 header，使用 ?token=）
      if ((path === '/v1/events' || path === '/events') && req.method === 'GET') {
        const since = parseSince(url.searchParams.get('since'));
        const sseTenantId = principal.tenant_id === '*' ? defaultTenantId : principal.tenant_id;
        const sseAllTenants =
          url.searchParams.get('all_tenants') === '1' && principal.role === 'admin';
        const sseRunId = url.searchParams.get('run_id') ?? undefined;
        const sseTypes = (url.searchParams.get('types') ?? '')
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        const accepts = (event: RunEvent): boolean => {
          if (!eventVisible(event, sseTenantId, sseAllTenants)) return false;
          if (sseRunId !== undefined && event.run_id !== sseRunId) return false;
          if (sseTypes.length > 0 && !sseTypes.includes(event.type)) return false;
          return true;
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
                tenantId: sseTenantId,
                allTenants: sseAllTenants,
                accepts,
              };
              state = clientState;
              sseClients.set(ctrl, clientState);
              writeSse(ctrl, clientState, 'retry: 3000\n\n');
              writeSse(
                ctrl,
                clientState,
                `data: ${JSON.stringify(helloFrame(since, sseTenantId))}\n\n`,
              );
              const gap = buffer.gapFor(since);
              if (gap) writeSse(ctrl, clientState, clientState.encodeGap(gap));
              clientState.replay = {
                cursor: Math.max(since + 1, buffer.oldestSeq),
                batch: SSE_REPLAY_BATCH,
                accepts,
                encode: (item) => `data: ${JSON.stringify(eventFrame(item))}\n\n`,
              };
              if (clientState.replay.cursor > buffer.latestSeq) clientState.replay = undefined;
            },
            pull() {
              if (!controller || !state) return;
              state.unacked = 0;
              pumpSseReplay(controller, state);
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
        const body = await readJsonBody(req, maxBodyBytes);
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
        const body = await readJsonBody(req, maxBodyBytes);
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
        const body = await readJsonBody(req, maxBodyBytes);
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

      // 0.1.0 兼容：阻塞式 /run（旧 web 客户端 / 脚本）
      if (path === '/run' && req.method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes);
        if (body instanceof Response) return body;
        if (typeof body.input !== 'string' || body.input.length === 0) {
          return errorJson('invalid_request', 'input is required', 400, extra);
        }
        try {
          const started = (await callMethod('runs.start', body, principal)) as {
            run_id?: unknown;
          };
          const runId = typeof started.run_id === 'string' ? started.run_id : '';
          const record = runs.get(runId);
          if (!record) return errorJson('internal', 'Run not found', 500, extra);
          await record.done;
          if (record.status === 'completed') return json({ output: record.output }, 200, extra);
          return errorJson(
            record.status === 'cancelled' ? 'cancelled' : 'internal',
            record.error ?? 'Run failed',
            record.status === 'cancelled' ? 409 : 500,
            extra,
          );
        } catch (error) {
          return legacyErrorResponse(error, extra);
        }
      }

      return errorJson('not_found', `Not found: ${path}`, 404, extra);
    },
    websocket: {
      data: {} as WsData,
      open(ws) {
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
        void handleWsMessage(ws, message);
      },
      close(ws) {
        if (ws.data.authTimer) clearTimeout(ws.data.authTimer);
        wsClients.delete(ws);
      },
      pong(ws) {
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

  if (team && !localOnly) startTeamPolling();

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
          sendFrame(ws, { v: 1, kind: 'ping', node_id: nodeId, ts: Date.now() });
          // 客户端已排空但没有新事件时，心跳负责补发 pending gap。
          flushWsGap(ws);
        }
        for (const [ctrl, state] of [...sseClients]) {
          if (!flushSseGap(ctrl, state)) continue;
          writeSse(ctrl, state, ': ping\n\n');
        }
        for (const [ctrl, state] of [...teamClients]) {
          if (!flushSseGap(ctrl, state)) continue;
          writeSse(ctrl, state, ': ping\n\n');
        }
      }, heartbeatMs);
  (heartbeat as { unref?: () => void } | undefined)?.unref?.();

  // 清理过期的权限请求记录
  const permissionSweeper = setInterval(() => {
    engine.sweep();
  }, 30_000);
  (permissionSweeper as { unref?: () => void }).unref?.();

  return {
    port: actualPort,
    url: `${scheme}://${hostname}:${actualPort}`,
    token,
    nodeId,
    protocol: protocolInfo,
    tls: tlsMaterial !== undefined,
    attachTeam,
    rpc: dispatcher.dispatch,
    manifest,
    stop() {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      clearInterval(permissionSweeper);
      if (teamPollTimer) clearInterval(teamPollTimer);
      teamPollTimer = undefined;
      unsubscribe();
      engine.active?.controller.abort();
      for (const record of queue.splice(0)) {
        record.status = 'cancelled';
        record.completed_at = Date.now();
        record.resolveDone();
      }
      for (const ws of wsClients) {
        try {
          ws.close(1001, 'server stopping');
        } catch {
          // 已断开
        }
      }
      wsClients.clear();
      for (const ctrl of sseClients.keys()) {
        try {
          ctrl.close();
        } catch {
          // 已关闭
        }
      }
      sseClients.clear();
      for (const ctrl of teamClients.keys()) {
        try {
          ctrl.close();
        } catch {
          // 已关闭
        }
      }
      teamClients.clear();
      knownPeers.clear();
      void server?.stop(true);
    },
  };
}
