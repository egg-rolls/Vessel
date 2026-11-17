/**
 * 压力路径 D：**平台代理 HTTP 流式转发 + 下游中途取消**。
 *
 * 0.54 的网关崩在「跑了一小时四十分、5697 次 fetch」这种形状上，而代理里最像「原生 + 并发
 * + 生命周期交错」的一段不是 WS，是 `proxy.ts` 的流式分支：
 *
 *   fetch(node) → upstream.body.getReader() → 手写 ReadableStream(pull/cancel) → Response
 *
 * 这段每一环都跨原生：fetch 的 body 泵、ReadableStream 的 pull 回调、Bun.serve 往下游写。
 * 而**下游中途放弃**（浏览器标签页关掉 / 用户点取消 / 客户端超时）会让 `cancel()` 与正在
 * 飞的 `pull()` 交错 —— 这正是「偶发、只在真实负载下出现」的崩溃最典型的形状。
 *
 * 本脚本按生产同一条路径压：真 `PlatformProxy.handleHttp`，真上游流，客户端读几块就中断，
 * 两种中断方式交替（AbortController / reader.cancel），多连接并发。
 *
 * 用法：
 *   bun scripts/crash-hunt/stress-d-http-stream.ts [--seconds 300] [--conns 8] [--kb 64]
 *
 * 隔离：只监听 127.0.0.1 随机端口，不碰 8642 / 8644。
 */

import { PlatformProxy, parseProxyRoute } from '../../packages/serve/src/platform/proxy';
import { rssMb, sampleLine, startSampler } from './_sampler';

function argValue(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const seconds = argValue('--seconds', 300);
const conns = argValue('--conns', 8);
const kb = argValue('--kb', 64);

const chunkBytes = kb * 1024;
const chunk = new Uint8Array(chunkBytes);
for (let index = 0; index < chunkBytes; index += 1) chunk[index] = (index * 7 + 3) & 0xff;

const stats = { streams: 0, chunks: 0, aborts: 0, cancels: 0, errors: 0, bytes: 0 };

/** 上游 node：无头流（每 2ms 一块，直到被取消）。 */
const upstream = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/v1/stream')) return new Response('nope', { status: 404 });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Bun.sleep(2);
        stats.chunks += 1;
        stats.bytes += chunkBytes;
        controller.enqueue(chunk);
      },
      cancel() {
        // 下游断了：上游这条流被取消（生产里就是 node 侧停止产生事件）。
      },
    });
    return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
  },
});
const upstreamOrigin = `http://127.0.0.1:${upstream.port}`;

const proxy = new PlatformProxy({
  resolveNode: () => ({ nodeId: 'stream-node', name: 'stream-node', apiUrl: upstreamOrigin }),
  resolveToken: () => undefined,
  limits: {},
  log: (fields) => {
    const event = String(fields.event ?? '');
    if (event.includes('unreachable') || event.includes('failed') || event.includes('timeout')) {
      stats.errors += 1;
      console.log(`# proxy log: ${event}`);
    }
  },
});

const platform = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    const route = parseProxyRoute(url.pathname);
    if (route === null) return new Response('not found', { status: 404 });
    return proxy.handleHttp(req, route, url);
  },
});
const streamUrl = `http://127.0.0.1:${platform.port}/nodes/stream-node/v1/stream`;

console.log('# path: D (proxy HTTP stream + downstream abort)');
console.log(
  `# upstream=${upstreamOrigin} platform=${streamUrl} conns=${conns} chunk=${kb}KB duration=${seconds}s`,
);

const stopSampler = startSampler(() => ({
  streams: stats.streams,
  aborts: stats.aborts,
  cancels: stats.cancels,
  inflight: proxy.stats().http_inflight,
  err: stats.errors,
}));

const rssAtStart = rssMb();
const startedAt = Date.now();
const deadline = startedAt + seconds * 1000;

/** 一趟：读到 3~6 块就断，两种断法交替。 */
async function oneRound(mode: 'abort' | 'cancel'): Promise<void> {
  const controller = new AbortController();
  try {
    const response = await fetch(streamUrl, { signal: controller.signal });
    const body = response.body;
    if (body === null) return;
    const reader = body.getReader();
    const want = 3 + (stats.streams % 4);
    for (let index = 0; index < want; index += 1) {
      const { done } = await reader.read();
      if (done) break;
    }
    if (mode === 'abort') {
      controller.abort();
      stats.aborts += 1;
    } else {
      await reader.cancel('client gone');
      stats.cancels += 1;
    }
    stats.streams += 1;
  } catch (error) {
    // 中断本身会让在飞的 read 抛 AbortError：这是**预期**，不算失败。
    const name = error instanceof Error ? error.name : 'unknown';
    if (name !== 'AbortError') {
      stats.errors += 1;
      if (stats.errors <= 3) console.log(`# round error (${mode}): ${String(error)}`);
    }
  }
}

const workers: Array<Promise<void>> = [];
for (let index = 0; index < conns; index += 1) {
  const mode = index % 2 === 0 ? 'abort' : 'cancel';
  workers.push(
    (async () => {
      while (Date.now() < deadline) {
        await oneRound(mode);
      }
    })(),
  );
}
await Promise.all(workers);
stopSampler();

const minutes = (Date.now() - startedAt) / 60000;
console.log(
  `# streams=${stats.streams} chunks_from_upstream=${stats.chunks} aborts=${stats.aborts} ` +
    `cancels=${stats.cancels} errors=${stats.errors} ` +
    `(~${(stats.streams / (minutes * 60)).toFixed(0)} streams/s, upstream ${(stats.bytes / 1048576).toFixed(0)}MB)`,
);
console.log(`# proxy stats: ${JSON.stringify(proxy.stats())}`);
console.log(`# rss: start=${rssAtStart.toFixed(1)}MB end=${rssMb().toFixed(1)}MB`);
console.log(sampleLine(Date.now() - startedAt, { phase: 'done', streams: stats.streams }));

const ok = stats.streams > 0 && stats.errors === 0;
console.log(ok ? '# RESULT: ok' : '# RESULT: FAILED');
proxy.dispose();
upstream.stop(true);
platform.stop(true);
process.exit(ok ? 0 : 1);
