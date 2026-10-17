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
import { extname, resolve, sep } from 'node:path';
import type {
  AgentRuntime,
  ContextManager,
  EventStream,
  PluginHost,
  RunEvent,
  SessionBackend,
  ToolDefinition,
} from '@vessel/core';
import { type EventGap, type SeqEvent, SeqEventBuffer } from './event-buffer.js';
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

/** 网关启动选项 */
export interface GatewayOptions {
  /** 事件流（必填）——广播源 */
  events: EventStream;
  /** 会话后端（可选）——/v1/sessions 数据源 */
  session?: SessionBackend;
  /** 运行时（可选）——运行控制端点 */
  runtime?: AgentRuntime;
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
}

/** 网关实例 */
export interface Gateway {
  port: number;
  url: string;
  token: string;
  nodeId: string;
  protocol: ProtocolInfo;
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

const PROTOCOL: ProtocolInfo = {
  name: 'vessel.gateway',
  version: PROTOCOL_VERSION,
  min: PROTOCOL_VERSION,
  features: ['events.replay', 'permissions', 'tools', 'static', 'runs.async'],
};

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
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]') return true;
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
  const token = opts.token ?? generateToken();
  const nodeId = randomUUID();
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
    endpoint: `http://${hostname}:${actualPort}`,
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
      event: item.event,
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
      protocol: PROTOCOL,
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

  const server = Bun.serve<WsData>({
    port: opts.port ?? DEFAULT_PORT,
    hostname,
    // 0 = 禁用空闲超时（已用 Bun 1.3.9 实测：SSE 12s 不中断）。
    // 事件流/WS 都是长连接；心跳仍负责穿透代理与检测死客户端。
    idleTimeout: opts.idleTimeout ?? 0,
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

      // 健康检查（开放，供探针/浏览器直连验证）
      if (path === '/health' || path === '/v1/health') {
        const base = {
          status: 'ok',
          clients: sseClients.size + wsClients.size,
          latest_seq: buffer.latestSeq,
        };
        if (path === '/health') return json(base, 200, extra);
        return json(
          { ...base, protocol: PROTOCOL, node: nodeInfo(), started_at: startedAt },
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
  });

  const actualPort = server.port ?? opts.port ?? DEFAULT_PORT;

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
    url: `http://${hostname}:${actualPort}`,
    token,
    nodeId,
    protocol: PROTOCOL,
    stop() {
      clearInterval(heartbeat);
      clearInterval(permissionSweeper);
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
      void server.stop(true);
    },
  };
}
