/**
 * 压力路径 B：**平台代理 WS 桥的大帧双向流**。
 *
 * 拓扑（三层全是真 WS，全在本进程内起实例，只用回环随机端口）：
 *
 *   N 个 WebSocket 客户端  →  平台 WS（Bun.serve, /nodes/:id/ws/...）
 *                          →  ProxyWsBridge（packages/serve/src/platform/proxy-ws.ts 真身）
 *                          →  上游 node WS（Bun.serve，回显 1 MB 二进制帧）
 *
 * 压的就是 0.58 的三条判据：每连接两个有界队列、`getBufferedAmount()` 水位、心跳/背压。
 * 同时每 2 s 让上游发一帧应用层 `ping` —— 平台代答 pong 的那条路（356ff616）也在热路径上。
 *
 * 用法：
 *   bun scripts/crash-hunt/stress-b-ws-proxy.ts [--seconds 300] [--conns 12] [--frame-kb 1024]
 *
 * 隔离：只监听 127.0.0.1 随机端口，不碰 8642 / 8644。
 */

import type { ProxyRoute } from '../../packages/serve/src/platform/proxy';
import { PlatformProxy, parseProxyRoute } from '../../packages/serve/src/platform/proxy';
import type { ProxyWsBridge } from '../../packages/serve/src/platform/proxy-ws';
import { rssMb, sampleLine, startSampler } from './_sampler';

function argValue(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const seconds = argValue('--seconds', 300);
const connCount = argValue('--conns', 12);
const frameKB = argValue('--frame-kb', 1024);
const frameBytes = frameKB * 1024;

const stats = { echoes: 0, sentBytes: 0, receivedBytes: 0, pings: 0, errors: 0, closed: 0 };

// ── 上游 node：回显二进制帧 + 每 2s 推一帧应用层 ping ────────────────────
const upstream = Bun.serve<{ connId: number }, never>({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req, server) {
    if (server.upgrade(req, { data: { connId: connCount } })) return undefined;
    return new Response('not a ws', { status: 400 });
  },
  websocket: {
    open(ws) {
      const timer = setInterval(() => {
        try {
          ws.send(JSON.stringify({ v: 1, kind: 'ping', ts: Date.now() }));
          stats.pings += 1;
        } catch {
          stats.errors += 1;
        }
      }, 2000);
      (timer as { unref?: () => void }).unref?.();
      ws.data = { connId: 0 };
      void timer;
    },
    message(ws, data) {
      if (typeof data === 'string') return;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      // 回显：原样发回，让「上行大帧 + 下行大帧」同时在飞。
      ws.sendBinary(bytes);
      stats.echoes += 1;
    },
  },
});
const upstreamOrigin = `http://127.0.0.1:${upstream.port}`;

// ── 平台代理（真身） ────────────────────────────────────────────────────
const proxy = new PlatformProxy({
  resolveNode: () => ({ nodeId: 'stress-node', name: 'stress-node', apiUrl: upstreamOrigin }),
  resolveToken: () => undefined,
  limits: {},
  log: (fields) => {
    const event = String(fields.event ?? '');
    if (event.includes('unreachable') || event.includes('failed') || event.includes('timeout')) {
      stats.errors += 1;
    }
  },
});

/** 每条平台侧连接：服务端 WS（浏览器那一端）↔ 桥。 */
const platform = Bun.serve<{ bridge: ProxyWsBridge }, never>({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    const route: ProxyRoute | null = parseProxyRoute(url.pathname);
    if (route === null) {
      console.log(`# upgrade refused: unparsable proxy path ${url.pathname}`);
      return new Response('not found', { status: 404 });
    }
    const decision = proxy.upgrade(route, url, {
      preAuthenticated: true,
      verifyPlatformToken: () => true,
    });
    if (!decision.ok) {
      console.log(`# upgrade refused: ${decision.response.status} ${url.pathname}`);
      return decision.response;
    }
    if (server.upgrade(req, { data: { bridge: decision.bridge } })) return undefined;
    return new Response('upgrade failed', { status: 500 });
  },
  websocket: {
    open(ws) {
      proxy.wsOpen(ws.data.bridge, ws);
    },
    message(ws, data) {
      proxy.wsMessage(ws.data.bridge, data);
    },
    close(ws, code, reason) {
      proxy.wsClose(ws.data.bridge, code, reason);
      stats.closed += 1;
    },
    pong(ws) {
      proxy.wsPong(ws.data.bridge);
    },
  },
});
const platformWsUrl = `ws://127.0.0.1:${platform.port}/nodes/stress-node/v1/events`;

console.log('# path: B (platform proxy WS bridge, big frames)');
console.log(
  `# upstream=${upstreamOrigin} platform=${platformWsUrl} conns=${connCount} frame=${frameKB}KB duration=${seconds}s`,
);

const stopSampler = startSampler(() => {
  const proxyStats = proxy.stats();
  return {
    echoes: stats.echoes,
    pings: stats.pings,
    ws_active: proxyStats.ws_active,
    ws_pending: proxyStats.ws_pending_bytes,
    http_inflight: proxyStats.http_inflight,
    err: stats.errors,
  };
});

const payload = new Uint8Array(frameBytes);
for (let index = 0; index < frameBytes; index += 1) payload[index] = (index * 131 + 17) & 0xff;

const rssAtStart = rssMb();
const deadline = Date.now() + seconds * 1000;
const sockets: WebSocket[] = [];

/** 每条连接：收到一帧回显再发下一帧 —— 保证「每条连接常驻一个 1MB 帧在飞」。 */
function drive(socket: WebSocket): void {
  socket.addEventListener('message', (event) => {
    const data = event.data;
    if (typeof data !== 'string') {
      stats.receivedBytes += data instanceof ArrayBuffer ? data.byteLength : frameBytes;
    }
    if (Date.now() >= deadline) return;
    if (socket.bufferedAmount > 2 * frameBytes) return;
    socket.send(payload);
    stats.sentBytes += frameBytes;
  });
  socket.addEventListener('close', (event) => {
    stats.closed += 1;
    console.log(`# client closed: code=${event.code} reason=${event.reason ?? ''}`);
  });
  socket.addEventListener('error', () => {
    stats.errors += 1;
    console.log('# client error');
  });
}

for (let index = 0; index < connCount; index += 1) {
  const socket = new WebSocket(platformWsUrl);
  sockets.push(socket);
  socket.addEventListener('open', () => {
    socket.send(payload);
    stats.sentBytes += frameBytes;
    drive(socket);
  });
}

const startedAt = Date.now();
while (Date.now() < deadline) {
  await Bun.sleep(1000);
}

for (const socket of sockets) {
  try {
    socket.close(1001, 'stress done');
  } catch {
    stats.errors += 1;
  }
}
await Bun.sleep(500);
stopSampler();

const minutes = (Date.now() - startedAt) / 60000;
console.log(
  `# echoes=${stats.echoes} pings=${stats.pings} sent=${(stats.sentBytes / 1048576).toFixed(0)}MB ` +
    `received=${(stats.receivedBytes / 1048576).toFixed(0)}MB rate=${(stats.echoes / (minutes * 60)).toFixed(0)}frames/s`,
);
console.log(`# rss: start=${rssAtStart.toFixed(1)}MB end=${rssMb().toFixed(1)}MB`);
console.log(
  `# proxy stats: ${JSON.stringify(proxy.stats())} errors=${stats.errors} closes=${stats.closed}`,
);
console.log(sampleLine(Date.now() - startedAt, { phase: 'done', echoes: stats.echoes }));

const ok = stats.echoes > 0 && stats.errors === 0;
console.log(ok ? '# RESULT: ok' : '# RESULT: FAILED');
proxy.dispose();
upstream.stop(true);
platform.stop(true);
process.exit(ok ? 0 : 1);
