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

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
} from '@vessel/core';
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
import { type EventGap, type SeqEvent, SeqEventBuffer } from './event-buffer.js';
import { type McpGatewayOptions, normalizeMcpServers } from './mcp.js';
import {
  type ClientFrame,
  type NodeInfo,
  PROTOCOL_VERSION,
  type ProtocolError,
  type ProtocolInfo,
  protocolError,
  type RunStatus,
  type ServerFrame,
  type ToolInfo,
} from './protocol.js';
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
  stop(): void;
}

/** WS 连接自定义数据 */
interface WsData {
  authed: boolean;
  since: number;
  alive: boolean;
  authTimer?: ReturnType<typeof setTimeout>;
}

type Ws = import('bun').ServerWebSocket<WsData>;
type SseController = ReadableStreamDefaultController<unknown>;

/** 网关级运行记录 */
interface RunRecord extends RunStatus {
  input: string;
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
}

/** 运行队列上限（防止无界堆积） */
const MAX_QUEUE = 100;
/** 保留的运行记录数 */
const MAX_RUNS = 200;
/** 权限请求记录的清理阈值（与 core 的 120s 超时对齐） */
const PERMISSION_TTL_MS = 120_000;
/** 慢客户端缓冲阈值 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

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

/** 恒定时间字符串比较 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
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

  const features = [...BASE_FEATURES];
  if (opts.durable?.store && opts.durable.resume) features.push('durable-resume');
  if (opts.mcp) features.push('mcp-status');
  if (tlsMaterial) features.push('tls');
  const protocolInfo: ProtocolInfo = {
    name: 'vessel.gateway',
    version: PROTOCOL_VERSION,
    min: PROTOCOL_VERSION,
    features,
  };
  const scheme = tlsMaterial ? 'https' : 'http';

  const nodeId = opts.nodeId ?? opts.team?.nodeId ?? randomUUID();
  const startedAt = Date.now();
  const buffer = new SeqEventBuffer(opts.maxHistory ?? DEFAULT_MAX_HISTORY);
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const maxQueue = opts.maxQueue ?? MAX_QUEUE;
  const allowedOrigins = opts.allowedOrigins ?? [];
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const authTimeoutMs = opts.authTimeoutMs ?? 5_000;

  const sseClients = new Set<SseController>();
  const wsClients = new Set<Ws>();
  const runs = new Map<string, RunRecord>();
  const queue: RunRecord[] = [];
  const coreToJob = new Map<string, string>();
  const pendingPermissions = new Map<
    string,
    { run_id: string; tool: string; input: unknown; ts: number }
  >();
  const pendingAsks = new Map<string, { run_id: string; ts: number }>();
  /**
   * 本进程已受理的 durable resume（快速 409，不替代 core 校验）。
   * Addendum A §2：首个调用成功，后续（含重复）一律 run_already_running。
   */
  const resumedRuns = new Set<string>();

  /** R3 team 状态（默认关闭） */
  let team: TeamGatewayOptions | undefined = opts.team;
  const teamClients = new Map<SseController, { agentId?: string }>();
  let teamPollTimer: ReturnType<typeof setInterval> | undefined;
  let knownPeers = new Set<string>();
  let inboundCursor = 0;
  /** 入站去重（transport.deliver 之外的兜底，防止注入 deliver 时绕过） */
  const seenInbound = new Map<string, true>();

  let active: RunRecord | null = null;
  let activeSessionId = 'default';

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
    status: active ? 'busy' : 'idle',
    ...(active ? { current_run_id: active.run_id, current_session_id: active.session_id } : {}),
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

  function helloFrame(fromSeq: number): ServerFrame {
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

  function broadcast(frame: ServerFrame): void {
    const encoded = JSON.stringify(frame);
    for (const ws of [...wsClients]) {
      if (ws.readyState !== 1) {
        wsClients.delete(ws);
        continue;
      }
      if (ws.getBufferedAmount() > MAX_BUFFERED_BYTES) {
        ws.close(1013, 'slow_consumer');
        wsClients.delete(ws);
        continue;
      }
      try {
        ws.send(encoded);
      } catch {
        wsClients.delete(ws);
      }
    }
    const sseFrame = `data: ${encoded}\n\n`;
    for (const ctrl of [...sseClients]) {
      try {
        ctrl.enqueue(sseFrame);
      } catch {
        sseClients.delete(ctrl);
      }
    }
  }

  function replayTo(ws: Ws): void {
    wsClients.add(ws);
    sendFrame(ws, helloFrame(ws.data.since));
    const gap = buffer.gapFor(ws.data.since);
    if (gap) sendFrame(ws, gapFrame(gap));
    for (const item of buffer.since(ws.data.since)) sendFrame(ws, eventFrame(item));
  }

  /** 订阅 core 事件流：分配 seq、记录 run 映射与权限请求、广播 */
  const unsubscribe = events.subscribe((event: RunEvent) => {
    if (event.type === 'run.started' && active && !active.core_run_id) {
      active.core_run_id = event.run_id;
      coreToJob.set(event.run_id, active.run_id);
    }
    if (event.type === 'tool.permission.request') {
      const data = event.data as Record<string, unknown>;
      const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;
      if (requestId) {
        pendingPermissions.set(requestId, {
          run_id: event.run_id,
          tool: typeof data.tool === 'string' ? data.tool : 'tool',
          input: data.input,
          ts: Date.now(),
        });
      }
    }
    if (event.type === 'ask.user.requested') {
      const data = event.data as Record<string, unknown>;
      const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;
      if (requestId) pendingAsks.set(requestId, { run_id: event.run_id, ts: Date.now() });
    }
    if (event.type === 'run.completed' || event.type === 'run.failed') {
      if (active && active.core_run_id === event.run_id) {
        const data = event.data as Record<string, unknown>;
        if (data.usage && typeof data.usage === 'object') {
          active.usage = data.usage as RunStatus['usage'];
        }
      }
      // 运行结束后清理该 run 的待答询问，避免陈旧弹窗
      for (const [id, pending] of pendingAsks) {
        if (pending.run_id === event.run_id) pendingAsks.delete(id);
      }
    }
    const seq = buffer.append(event);
    broadcast(eventFrame({ seq, event }));

    // R3：team 事件流（agent.* / team.*），可选按 agent_id 过滤
    if (isTeamEvent(event) && teamClients.size > 0) {
      const wire = toWireEvent(event);
      const frame = `data: ${JSON.stringify({
        protocol: 1,
        node_id: nodeId,
        seq,
        kind: 'team.event',
        event: wire,
      })}\n\n`;
      for (const [ctrl, filter] of [...teamClients]) {
        const agentId = (wire.data as Record<string, unknown>).agent_id;
        if (filter.agentId !== undefined && agentId !== filter.agentId) continue;
        try {
          ctrl.enqueue(frame);
        } catch {
          teamClients.delete(ctrl);
        }
      }
    }
  });

  // ── 运行队列 ───────────────────────────────────

  function createRun(input: string, sessionId: string): RunRecord {
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolveDoneFn) => {
      resolveDone = resolveDoneFn;
    });
    const record: RunRecord = {
      run_id: randomUUID(),
      session_id: sessionId,
      input,
      status: 'queued',
      controller: new AbortController(),
      done,
      resolveDone,
    };
    runs.set(record.run_id, record);
    queue.push(record);
    return record;
  }

  function queuePosition(record: RunRecord): number | undefined {
    if (record.status !== 'queued') return undefined;
    const index = queue.indexOf(record);
    return index >= 0 ? index + 1 : undefined;
  }

  function publicStatus(record: RunRecord): RunStatus {
    return {
      run_id: record.run_id,
      ...(record.core_run_id ? { core_run_id: record.core_run_id } : {}),
      session_id: record.session_id,
      status: record.status,
      ...(record.output !== undefined ? { output: record.output } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.usage ? { usage: record.usage } : {}),
      ...(record.started_at !== undefined ? { started_at: record.started_at } : {}),
      ...(record.completed_at !== undefined ? { completed_at: record.completed_at } : {}),
      ...(queuePosition(record) !== undefined ? { queue_position: queuePosition(record) } : {}),
    };
  }

  async function execute(record: RunRecord): Promise<void> {
    record.status = 'running';
    record.started_at = Date.now();
    active = record;

    // G2：切换会话时清空共享 Context，让 runtime 从 SessionBackend 重新加载目标会话历史。
    if (context && context.getSessionId() !== record.session_id) {
      context.setSessionId(record.session_id);
      context.clear();
    }

    try {
      if (!runtime) throw new MethodError('no_runtime', 'No runtime configured');
      const output = await runtime.run(record.input, record.session_id, {
        signal: record.controller.signal,
      });
      record.output = output;
      record.status = record.controller.signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record.status = record.controller.signal.aborted ? 'cancelled' : 'failed';
      record.error = message;
    } finally {
      record.completed_at = Date.now();
      active = null;
      record.resolveDone();
      trimRuns();
      pump();
    }
  }

  function pump(): void {
    if (active || queue.length === 0) return;
    const next = queue.shift();
    if (!next) return;
    void execute(next);
  }

  function trimRuns(): void {
    if (runs.size <= MAX_RUNS) return;
    for (const [id, record] of runs) {
      if (runs.size <= MAX_RUNS) break;
      if (record.status !== 'running' && record.status !== 'queued') runs.delete(id);
    }
  }

  function cancelRun(id: string): boolean {
    const record = runs.get(id);
    if (!record) throw new MethodError('not_found', `Run not found: ${id}`);
    if (record.status === 'queued') {
      const index = queue.indexOf(record);
      if (index >= 0) queue.splice(index, 1);
      record.status = 'cancelled';
      record.completed_at = Date.now();
      record.resolveDone();
      return true;
    }
    if (record.status === 'running') {
      record.controller.abort();
      return true;
    }
    return false;
  }

  function submitRun(params: Record<string, unknown>): {
    run_id: string;
    status: RunStatus['status'];
    queue_position?: number;
  } {
    if (!runtime) throw new MethodError('no_runtime', 'No runtime configured');
    const input = params.input;
    if (typeof input !== 'string' || input.length === 0) {
      throw new MethodError('invalid_request', 'input is required');
    }
    if (queue.length + (active ? 1 : 0) >= maxQueue) {
      throw new MethodError('busy', 'Run queue is full');
    }
    const requestedSession = params.session_id;
    const sessionId =
      typeof requestedSession === 'string' && requestedSession.length > 0
        ? requestedSession
        : activeSessionId;
    activeSessionId = sessionId;
    const record = createRun(input, sessionId);
    pump();
    return {
      run_id: record.run_id,
      status: record.status,
      ...(queuePosition(record) !== undefined ? { queue_position: queuePosition(record) } : {}),
    };
  }

  async function listSessions(): Promise<{ sessions: unknown[] }> {
    if (!session) throw new MethodError('no_session', 'No session backend configured');
    return { sessions: await session.listRich() };
  }

  function toolsPayload(): { tools: ToolInfo[] } {
    return {
      tools: listTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
        has_permission_check: typeof tool.checkPermission === 'function',
      })),
    };
  }

  function respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    remember: boolean,
  ): void {
    const pending = pendingPermissions.get(requestId);
    if (!pending) throw new MethodError('not_found', `Permission request not found: ${requestId}`);
    events.publish({
      type: 'tool.permission.response',
      run_id: pending.run_id,
      data: { requestId, decision, ...(remember ? { remember: true } : {}) },
      ts: Date.now(),
    });
    pendingPermissions.delete(requestId);
  }

  /** 回答 ask_user：发布 ask.user.answered；answers 为空数组表示取消 */
  function respondAsk(requestId: string, answers: unknown[]): void {
    const pending = pendingAsks.get(requestId);
    if (!pending) throw new MethodError('not_found', `Ask request not found: ${requestId}`);
    events.publish({
      type: 'ask.user.answered',
      run_id: pending.run_id,
      data: { requestId, answers },
      ts: Date.now(),
    });
    pendingAsks.delete(requestId);
  }

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
      if (!safeEqual(frame.token, token)) {
        ws.close(4401, 'unauthorized');
        return;
      }
      ws.data.authed = true;
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
    try {
      const result = await dispatchMethod(frame.method, frame.params);
      sendResult(ws, frame.id, true, result);
    } catch (error) {
      if (error instanceof MethodError) {
        sendResult(ws, frame.id, false, undefined, protocolError(error.code, error.message));
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendResult(ws, frame.id, false, undefined, protocolError('internal', message));
      }
    }
  }

  /** 授权：Bearer 头优先，兼容 ?token= */
  function authorized(req: Request, url: URL): boolean {
    const header = req.headers.get('authorization');
    if (header?.startsWith('Bearer ') && safeEqual(header.slice(7), token)) return true;
    const queryToken = url.searchParams.get('token');
    return queryToken !== null && safeEqual(queryToken, token);
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
    const stream = new ReadableStream<unknown>({
      start(ctrl) {
        controller = ctrl;
        teamClients.set(ctrl, { ...(agentId !== undefined ? { agentId } : {}) });
        ctrl.enqueue('retry: 3000\n\n');
        const latest = buffer.latestSeq;
        ctrl.enqueue(
          `data: ${JSON.stringify({
            protocol: 1,
            node_id: nodeId,
            kind: 'team.hello',
            from_seq: latest === 0 ? 0 : Math.max(since + 1, buffer.oldestSeq),
            latest_seq: latest,
          })}\n\n`,
        );
        const gap = buffer.gapFor(since);
        if (gap) {
          ctrl.enqueue(
            `data: ${JSON.stringify({
              protocol: 1,
              node_id: nodeId,
              kind: 'gap',
              from_seq: gap.from_seq,
              to_seq: gap.to_seq,
            })}\n\n`,
          );
        }
        for (const item of buffer.since(since)) {
          if (!isTeamEvent(item.event)) continue;
          const wire = toWireEvent(item.event);
          const eventAgentId = (wire.data as Record<string, unknown>).agent_id;
          if (agentId !== undefined && eventAgentId !== agentId) continue;
          ctrl.enqueue(
            `data: ${JSON.stringify({
              protocol: 1,
              node_id: nodeId,
              seq: item.seq,
              kind: 'team.event',
              event: wire,
            })}\n\n`,
          );
        }
      },
      cancel() {
        if (controller) teamClients.delete(controller);
      },
    });
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
  ): Promise<Response | null> {
    if (path !== '/v1/mcp' && !path.startsWith('/v1/mcp/')) return null;
    if (path !== '/v1/mcp/servers') {
      return errorJson('not_found', `Not found: ${path}`, 404, extra);
    }
    if (req.method !== 'GET') {
      return errorJson('method_not_allowed', 'Method not allowed', 405, extra);
    }
    if (!opts.mcp) {
      return errorJson('mcp_disabled', 'MCP status is not enabled', 503, extra);
    }
    try {
      const servers = normalizeMcpServers(await opts.mcp.listServers());
      return json({ servers }, 200, extra);
    } catch {
      return errorJson('internal', 'Failed to read MCP server status', 500, extra);
    }
  }

  /** 轮询 peer 表，发布 join/left（失败只记录，不影响 v1） */
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
        const queryToken = url.searchParams.get('token');
        const authed = queryToken !== null && safeEqual(queryToken, token);
        const upgraded = srv.upgrade(req, {
          data: {
            authed,
            since: parseSince(url.searchParams.get('since')),
            alive: true,
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

      if (!authorized(req, url)) {
        return errorJson('unauthorized', 'Missing or invalid token', 401, extra);
      }

      // R3：team 端点（默认关闭 → 404）
      const teamResponse = await handleTeam(req, url, path, extra);
      if (teamResponse) return teamResponse;

      // 0.3：durable / MCP（未注入 → 503 *_disabled）
      const durableResponse = await handleDurable(req, url, path, extra);
      if (durableResponse) return durableResponse;
      const mcpResponse = await handleMcp(req, path, extra);
      if (mcpResponse) return mcpResponse;

      // SSE：只读事件流（EventSource 无法带 header，使用 ?token=）
      if ((path === '/v1/events' || path === '/events') && req.method === 'GET') {
        const since = parseSince(url.searchParams.get('since'));
        let controller: SseController | undefined;
        const stream = new ReadableStream<unknown>({
          start(ctrl) {
            controller = ctrl;
            sseClients.add(ctrl);
            ctrl.enqueue('retry: 3000\n\n');
            ctrl.enqueue(`data: ${JSON.stringify(helloFrame(since))}\n\n`);
            const gap = buffer.gapFor(since);
            if (gap) ctrl.enqueue(`data: ${JSON.stringify(gapFrame(gap))}\n\n`);
            for (const item of buffer.since(since)) {
              ctrl.enqueue(`data: ${JSON.stringify(eventFrame(item))}\n\n`);
            }
          },
          cancel() {
            if (controller) sseClients.delete(controller);
          },
        });
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
          return json(await listSessions(), 200, extra);
        } catch (error) {
          if (error instanceof MethodError) return errorJson(error.code, error.message, 400, extra);
          return errorJson('internal', 'Failed to list sessions', 500, extra);
        }
      }

      // 工具列表（不含 handler）
      if (path === '/v1/tools' && req.method === 'GET') {
        return json(toolsPayload(), 200, extra);
      }

      // 运行列表（内存内当前进程）
      if (path === '/v1/runs' && req.method === 'GET') {
        const sessionFilter = url.searchParams.get('session_id');
        const list = [...runs.values()]
          .filter((record) => !sessionFilter || record.session_id === sessionFilter)
          .map(publicStatus);
        return json({ runs: list }, 200, extra);
      }

      // 提交运行（异步；事件流负责结果）
      if (path === '/v1/runs' && req.method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes);
        if (body instanceof Response) return body;
        try {
          return json(submitRun(body), 202, extra);
        } catch (error) {
          if (error instanceof MethodError) {
            const status = error.code === 'busy' ? 429 : 400;
            return errorJson(error.code, error.message, status, extra);
          }
          return errorJson('internal', 'Failed to submit run', 500, extra);
        }
      }

      // 运行状态 / 取消
      const runMatch = path.match(/^\/v1\/runs\/([^/]+)(\/cancel)?$/);
      if (runMatch) {
        const runId = decodeURIComponent(runMatch[1] ?? '');
        const isCancel = Boolean(runMatch[2]);
        if (isCancel && req.method === 'POST') {
          try {
            return json({ cancelled: cancelRun(runId) }, 200, extra);
          } catch (error) {
            if (error instanceof MethodError) {
              return errorJson(error.code, error.message, 404, extra);
            }
            return errorJson('internal', 'Failed to cancel run', 500, extra);
          }
        }
        if (!isCancel && req.method === 'GET') {
          const record = runs.get(runId);
          if (!record) return errorJson('not_found', `Run not found: ${runId}`, 404, extra);
          return json(publicStatus(record), 200, extra);
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
          respondPermission(requestId, decision, body.remember === true);
          return json({ ok: true }, 200, extra);
        } catch (error) {
          if (error instanceof MethodError) {
            return errorJson(error.code, error.message, 404, extra);
          }
          return errorJson('internal', 'Failed to respond to permission request', 500, extra);
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
          respondAsk(requestId, body.answers);
          return json({ ok: true }, 200, extra);
        } catch (error) {
          if (error instanceof MethodError) {
            return errorJson(error.code, error.message, 404, extra);
          }
          return errorJson('internal', 'Failed to respond to ask request', 500, extra);
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
          const sessionId =
            typeof body.session_id === 'string' && body.session_id.length > 0
              ? body.session_id
              : activeSessionId;
          activeSessionId = sessionId;
          const record = createRun(body.input, sessionId);
          pump();
          await record.done;
          if (record.status === 'completed') return json({ output: record.output }, 200, extra);
          return errorJson(
            record.status === 'cancelled' ? 'cancelled' : 'internal',
            record.error ?? 'Run failed',
            record.status === 'cancelled' ? 409 : 500,
            extra,
          );
        } catch (error) {
          if (error instanceof MethodError) return errorJson(error.code, error.message, 400, extra);
          return errorJson('internal', 'Failed to run', 500, extra);
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

  let server: Bun.Server<WsData>;
  try {
    server = Bun.serve<WsData>(serveOptions);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to start gateway on ${hostname}:${opts.port ?? DEFAULT_PORT}: ${detail}`,
      { cause: error },
    );
  }

  const actualPort = server.port ?? opts.port ?? DEFAULT_PORT;

  if (team) startTeamPolling();

  // 心跳：WS 发 ping（客户端回 pong 或 {kind:'pong'}），SSE 发注释行
  const heartbeat = setInterval(() => {
    for (const ws of [...wsClients]) {
      if (!ws.data.alive) {
        ws.close(1001, 'heartbeat timeout');
        wsClients.delete(ws);
        continue;
      }
      ws.data.alive = false;
      sendFrame(ws, { v: 1, kind: 'ping', node_id: nodeId, ts: Date.now() });
    }
    for (const ctrl of [...sseClients]) {
      try {
        ctrl.enqueue(': ping\n\n');
      } catch {
        sseClients.delete(ctrl);
      }
    }
    for (const ctrl of [...teamClients.keys()]) {
      try {
        ctrl.enqueue(': ping\n\n');
      } catch {
        teamClients.delete(ctrl);
      }
    }
  }, heartbeatMs);
  (heartbeat as { unref?: () => void }).unref?.();

  // 清理过期的权限请求记录
  const permissionSweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, pending] of pendingPermissions) {
      if (now - pending.ts > PERMISSION_TTL_MS) pendingPermissions.delete(id);
    }
    for (const [id, pending] of pendingAsks) {
      if (now - pending.ts > PERMISSION_TTL_MS) pendingAsks.delete(id);
    }
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
    stop() {
      clearInterval(heartbeat);
      clearInterval(permissionSweeper);
      if (teamPollTimer) clearInterval(teamPollTimer);
      teamPollTimer = undefined;
      unsubscribe();
      active?.controller.abort();
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
      for (const ctrl of sseClients) {
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
      void server.stop(true);
    },
  };
}
