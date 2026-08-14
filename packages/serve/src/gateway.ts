/**
 * Gateway — 本地 HTTP/WS 服务网关
 * @module @vessel/serve
 *
 * 把 runtime 的 EventStream 暴露为 SSE + WebSocket 广播，并提供 /health /sessions /run 控制端点。
 * 是 EventStream 的消费者（与 TUI 的 StreamRenderer 同构），不经过 PluginHost、不修改 core。
 *
 * 借鉴 Hermes tui_gateway（Transport 分层 + 事件广播器）与 Claude-Code Direct-Connect（WS 承载
 * 下行事件）。SSE 供 EventSource 只读订阅，WS 供浏览器长连接，REST 供控制台查询与投递。
 */

import { randomUUID } from 'node:crypto';
import type { AgentRuntime, EventStream, RunEvent, SessionBackend } from '@vessel/core';

type ServerWebSocket = import('bun').ServerWebSocket<undefined>;

/** 网关启动选项 */
export interface GatewayOptions {
  /** 事件流（必填）——广播源 */
  events: EventStream;
  /** 会话后端（可选）——/sessions 端点数据源 */
  session?: SessionBackend;
  /** 运行时（可选）——/run 入站控制端点 */
  runtime?: AgentRuntime;
  /** 监听端口（默认 8642，对齐 Hermes api_server） */
  port?: number;
  /** 访问令牌（默认随机生成）——本地控制台鉴权 */
  token?: string;
}

/** 网关实例 */
export interface Gateway {
  port: number;
  url: string;
  token: string;
  stop(): void;
}

const DEFAULT_PORT = 8642;

/** 宽松 CORS（本地 Web 控制台跨端口访问） */
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

/** 构造 JSON 响应 */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

/** 启动本地服务网关 */
export function startGateway(opts: GatewayOptions): Gateway {
  const port = opts.port ?? DEFAULT_PORT;
  const token = opts.token ?? randomUUID();
  const { events, session, runtime } = opts;

  // 两类 transport 客户端：SSE（HTTP 流）与 WS（升级连接）。二者都是 EventStream 消费者。
  const sseClients = new Set<ReadableStreamDefaultController<unknown>>();
  const wsClients = new Set<ServerWebSocket>();

  // 单一订阅：EventStream → 广播到所有 transport
  const unsubscribe = events.subscribe((event: RunEvent) => {
    const wsFrame = `${JSON.stringify(event)}\n`;
    const sseFrame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try {
        client.enqueue(sseFrame);
      } catch {
        sseClients.delete(client);
      }
    }
    for (const ws of wsClients) {
      try {
        ws.send(wsFrame);
      } catch {
        wsClients.delete(ws);
      }
    }
  });

  /** 鉴权：/health 开放，其余端点要求 ?token= 或 Authorization: Bearer */
  const authorized = (req: Request): boolean => {
    const url = new URL(req.url);
    if (url.searchParams.get('token') === token) return true;
    return req.headers.get('authorization') === `Bearer ${token}`;
  };

  // ── 入站控制：串行化 run（单 runtime + 单 context 不支持并发 run）──
  let runQueue: Promise<unknown> = Promise.resolve();
  const enqueueRun = (rt: AgentRuntime, input: string, sessionId?: string): Promise<string> => {
    const run = runQueue.then(() => rt.run(input, sessionId));
    runQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const server = Bun.serve({
    port,
    websocket: {
      open(ws) {
        wsClients.add(ws);
        // 回放历史事件，客户端自建时间线
        for (const event of events.getHistory()) {
          ws.send(`${JSON.stringify(event)}\n`);
        }
      },
      close(ws) {
        wsClients.delete(ws);
      },
      message() {
        // 预留：WS 双向控制（run / interrupt）。首版只做广播，入站控制走 POST /run。
      },
    },
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;

      // CORS 预检
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      // 健康检查（开放，供探针/浏览器直连验证）
      if (path === '/health') {
        return json({ status: 'ok', clients: sseClients.size + wsClients.size });
      }

      if (!authorized(req)) {
        return json({ error: 'unauthorized' }, 401);
      }

      // SSE：EventStream → text/event-stream（含历史回放）
      if (path === '/events') {
        let controller: ReadableStreamDefaultController<unknown> | undefined;
        const body = new ReadableStream({
          start(ctrl) {
            controller = ctrl;
            sseClients.add(ctrl);
            for (const event of events.getHistory()) {
              ctrl.enqueue(`data: ${JSON.stringify(event)}\n\n`);
            }
          },
          cancel() {
            if (controller) sseClients.delete(controller);
          },
        });
        return new Response(body, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...corsHeaders(),
          },
        });
      }

      // WS：升级连接，事件以 newline-delimited JSON 广播
      if (path === '/ws') {
        if (!srv.upgrade(req)) {
          return json({ error: 'websocket upgrade failed' }, 400);
        }
        return;
      }

      // 会话列表（照搬 Hermes list_sessions_rich，供控制台渲染会话侧栏）
      if (path === '/sessions' && req.method === 'GET') {
        if (!session) return json({ error: 'no session backend configured' }, 400);
        return json({ sessions: await session.listRich() });
      }

      // 入站控制：投递 prompt，串行执行，结果经事件流广播 + 同步返回
      if (path === '/run' && req.method === 'POST') {
        if (!runtime) return json({ error: 'no runtime configured' }, 400);
        let body: { input?: string; session_id?: string } = {};
        try {
          body = (await req.json()) as { input?: string; session_id?: string };
        } catch {
          // 非法 JSON → 落在下方 input 校验
        }
        if (typeof body.input !== 'string' || body.input.length === 0) {
          return json({ error: 'input is required' }, 400);
        }
        const output = await enqueueRun(runtime, body.input, body.session_id);
        return json({ output });
      }

      return json({ error: 'not found' }, 404);
    },
  });

  const actualPort = server.port ?? port;

  return {
    port: actualPort,
    url: `http://localhost:${actualPort}`,
    token,
    stop() {
      unsubscribe();
      server.stop();
    },
  };
}
