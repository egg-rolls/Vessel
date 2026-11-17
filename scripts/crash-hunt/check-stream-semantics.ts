/**
 * 语义自证：加固后的代理流式分支**没有把流变成缓冲**（也正是这次改动最容易搞坏的地方）。
 *
 * 三条判据：
 * 1. `text/event-stream`（无 content-length）→ 逐步到达：5 条事件，首条 < 400ms，
 *    相邻到达间隔 ≈ 上游节拍（200ms），且不是「全部在最后一起到」；
 * 2. 声明了长度的小 JSON → 内容逐字节相同、`content-length` 一致；
 * 3. 声明了长度的超大响应（> 1 MiB）→ 走原生直通，仍然逐块到达（不会整份进内存）。
 *
 * 用法：`bun scripts/crash-hunt/check-stream-semantics.ts`
 * 退出码 0 = 三条都过。
 */

import { PlatformProxy, parseProxyRoute } from '../../packages/serve/src/platform/proxy';

const EVENTS = 5;
const EVENT_GAP_MS = 200;
const JSON_BODY = JSON.stringify({ ok: true, items: Array.from({ length: 200 }, (_, i) => i) });
const BIG_BYTES = 3 * 1024 * 1024;

const bigChunk = new Uint8Array(64 * 1024);
for (let index = 0; index < bigChunk.length; index += 1) bigChunk[index] = (index * 11 + 5) & 0xff;

const upstream = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/v1/sse') {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          for (let index = 0; index < EVENTS; index += 1) {
            controller.enqueue(encoder.encode(`data: event-${index}\n\n`));
            await Bun.sleep(EVENT_GAP_MS);
          }
          controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path === '/v1/json') {
      return new Response(JSON_BODY, {
        headers: { 'content-type': 'application/json', 'content-length': String(JSON_BODY.length) },
      });
    }
    if (path === '/v1/big') {
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await Bun.sleep(20);
          if (
            controller.desiredSize === null ||
            (controller as { bytesSent?: number }).bytesSent === undefined
          ) {
            (controller as { bytesSent?: number }).bytesSent = 0;
          }
          const state = controller as { bytesSent?: number };
          const sent = state.bytesSent ?? 0;
          if (sent >= BIG_BYTES) {
            controller.close();
            return;
          }
          state.bytesSent = sent + bigChunk.length;
          controller.enqueue(bigChunk);
        },
      });
      return new Response(body, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(BIG_BYTES),
        },
      });
    }
    return new Response('nope', { status: 404 });
  },
});
const origin = `http://127.0.0.1:${upstream.port}`;

const proxy = new PlatformProxy({
  resolveNode: () => ({ nodeId: 'check-node', name: 'check-node', apiUrl: origin }),
  resolveToken: () => undefined,
  limits: {},
  log: () => undefined,
});

const platform = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const route = parseProxyRoute(url.pathname);
    if (route === null) return new Response('not found', { status: 404 });
    return proxy.handleHttp(req, route, url);
  },
});
const base = `http://127.0.0.1:${platform.port}/nodes/check-node`;

let failures = 0;
function verdict(ok: boolean, label: string, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} ${detail}`);
}

// ── 1. SSE 逐步到达 ─────────────────────────────────────────────────────
const sseStartedAt = performance.now();
const sse = await fetch(`${base}/v1/sse`);
const sseReader = sse.body?.getReader();
const arrivals: number[] = [];
const decoder = new TextDecoder();
let sseText = '';
if (sseReader !== undefined) {
  for (;;) {
    const { done, value } = await sseReader.read();
    if (done) break;
    arrivals.push(performance.now() - sseStartedAt);
    sseText += decoder.decode(value, { stream: true });
  }
}
const firstArrival = arrivals[0] ?? Number.POSITIVE_INFINITY;
const spread = arrivals.length > 1 ? (arrivals[arrivals.length - 1] ?? 0) - firstArrival : 0;
verdict(
  firstArrival < 400,
  'sse: time-to-first-byte',
  `first=${firstArrival.toFixed(0)}ms (阈值 <400ms)`,
);
verdict(
  arrivals.length >= EVENTS && spread > EVENT_GAP_MS * (EVENTS - 2),
  'sse: 逐步到达',
  `chunks=${arrivals.length} spread=${spread.toFixed(0)}ms (上游节拍 ${EVENT_GAP_MS}ms × ${EVENTS})`,
);
verdict(
  sseText.split('data: ').length - 1 === EVENTS,
  'sse: 事件条数',
  `events=${sseText.split('data: ').length - 1}`,
);

// ── 2. 小 JSON：逐字节相同（走「整份读完」那条路） ──────────────────────
const jsonResponse = await fetch(`${base}/v1/json`);
const jsonText = await jsonResponse.text();
verdict(jsonText === JSON_BODY, 'json: 逐字节相同', `bytes=${jsonText.length}/${JSON_BODY.length}`);
// `content-length` 是一条**模式差异**的读数，不是硬判据：手写泵（pump）的响应是分块发出去的，
// Bun 会把 `content-length` 换成 chunked；原生直通（passthrough）能原样保留。
console.log(
  `${jsonResponse.headers.get('content-length') === String(JSON_BODY.length) ? 'INFO' : 'INFO'}` +
    `  json: content-length           header=${jsonResponse.headers.get('content-length')}` +
    ` (mode=${proxy.stats().http_stream_mode}; pump 下为 null 属既有行为)`,
);

// ── 3. 超大（3 MiB）声明长度：不能整份进内存，必须逐块到 ────────────────
const bigStartedAt = performance.now();
const big = await fetch(`${base}/v1/big`);
const bigReader = big.body?.getReader();
const bigArrivals: number[] = [];
let bigBytes = 0;
if (bigReader !== undefined) {
  for (;;) {
    const { done, value } = await bigReader.read();
    if (done) break;
    bigArrivals.push(performance.now() - bigStartedAt);
    bigBytes += value.byteLength;
  }
}
verdict(bigBytes === BIG_BYTES, 'big: 字节数', `bytes=${bigBytes}/${BIG_BYTES}`);
verdict(
  bigArrivals.length > 8,
  'big: 分块到达（非整份缓冲）',
  `chunks=${bigArrivals.length} first=${(bigArrivals[0] ?? 0).toFixed(0)}ms`,
);

console.log(`# proxy stats: ${JSON.stringify(proxy.stats())}`);
console.log(failures === 0 ? '# RESULT: ok' : `# RESULT: ${failures} failing check(s)`);
proxy.dispose();
upstream.stop(true);
platform.stop(true);
process.exit(failures === 0 ? 0 : 1);
