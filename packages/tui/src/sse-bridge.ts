/**
 * SSE Bridge — EventStream → HTTP Server-Sent Events
 * @module @vessel/tui
 *
 * 消费 EventStream，将 RunEvent 序列化为 W3C SSE 格式推送给浏览器 GUI。
 * 不经过 PluginHost，不修改 core。和 StreamRenderer 同构——都是 EventStream 的消费者。
 *
 * 使用方式:
 *   import { startSseBridge } from '@vessel/tui';
 *   startSseBridge(events, 3333);
 *
 * 浏览器端:
 *   const es = new EventSource('http://localhost:3333/events');
 *   es.onmessage = (e) => { const event = JSON.parse(e.data); ... };
 */

import type { EventStream, RunEvent } from '@vessel/core';

/** SSE 服务实例 */
export interface SseBridge {
  port: number;
  clientCount: number;
  stop(): void;
}

/**
 * 启动 SSE 桥接服务器。
 * @param events 事件流
 * @param port HTTP 端口（默认 3333）
 */
export function startSseBridge(events: EventStream, port = 3333): SseBridge {
  const clients = new Set<ReadableStreamDefaultController>();

  // 订阅 EventStream → 广播到所有 SSE 客户端
  const unsubscribe = events.subscribe((event: RunEvent) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try {
        client.enqueue(line);
      } catch {
        clients.delete(client);
      }
    }
  });

  const server = Bun.serve({
    port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/events') {
        let controller: ReadableStreamDefaultController;
        const body = new ReadableStream({
          start(ctrl) {
            controller = ctrl;
            clients.add(ctrl);
            // 推送历史事件供客户端回放
            for (const event of events.getHistory()) {
              ctrl.enqueue(`data: ${JSON.stringify(event)}\n\n`);
            }
          },
          cancel() {
            clients.delete(controller);
          },
        });
        return new Response(body, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      // 健康检查 + 状态
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({ status: 'ok', clients: clients.size }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }

      return new Response('Vessel SSE Bridge', {
        headers: { 'Content-Type': 'text/plain' },
      });
    },
  });

  return {
    port: server.port,
    get clientCount() {
      return clients.size;
    },
    stop() {
      unsubscribe();
      server.stop();
    },
  };
}
