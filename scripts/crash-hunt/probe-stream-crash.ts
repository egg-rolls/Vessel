/**
 * 探针：把「Bun 在 Windows 上 fetch 流 + 下游取消就 segfault」收窄到**具体触发点**。
 *
 * 生产崩溃：`panic(main thread): Segmentation fault at address 0xFFFFFFFFFFFFFFFF`
 * → https://bun.report/1.3.9/ea1cf6cdbbiD+hooCytjvvDstq9bq+r9eq2q9e___A2DD
 * 本探针在 mode=proxy 下 10 秒内复现同一个地址、同一份 bun.report 指纹。
 *
 * 五种写法，跑同一条压法（多连接流式读几块就断），一次只跑一种：
 *
 * | mode | 形状 | 想回答 |
 * | --- | --- | --- |
 * | `raw`            | `fetch()` + `reader.cancel()`，完全不碰我们的代码 | Bun 自己会不会崩？|
 * | `raw-abort`      | `fetch()` + `AbortController.abort()` 网内 | 是 cancel 还是 abort 触发？|
 * | `handrolled`     | 手写 `ReadableStream(pull)` 包 fetch reader，再取消 | 手写泵是不是必要？|
 * | `passthrough`    | 直接 `new Response(upstream.body)`（不手写泵） | **有没有不崩的写法**？|
 * | `proxy`          | 真 `PlatformProxy.handleHttp`（生产同一条路） | 生产路径复现确认 |
 *
 * 用法：`bun scripts/crash-hunt/probe-stream-crash.ts --mode raw --seconds 30 --conns 6`
 * 退出码：0 = 跑完没崩；139（或 terminal 报告） = 崩了。
 */

import { PlatformProxy, parseProxyRoute } from '../../packages/serve/src/platform/proxy';
import { rssMb, sampleLine, startSampler } from './_sampler';

function argValue(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const mode = (process.argv[process.argv.indexOf('--mode') + 1] ?? 'proxy') as
  | 'raw'
  | 'raw-abort'
  | 'handrolled'
  | 'passthrough'
  | 'passthrough-signal'
  | 'proxy-shape'
  | 'pump'
  | 'pipe'
  | 'passthrough-abort'
  | 'pump-safe'
  | 'proxy';
const seconds = argValue('--seconds', 30);
const conns = argValue('--conns', 6);
const kb = argValue('--kb', 64);
/** 上游体是有限长（ ⇒ 总共 256KB 就 close）还是无限长；0 = 无限。 */
const finiteKb = argValue('--finite', 0);

const chunk = new Uint8Array(kb * 1024);
for (let index = 0; index < chunk.length; index += 1) chunk[index] = (index * 7 + 3) & 0xff;

const stats = {
  rounds: 0,
  chunks: 0,
  errors: 0,
  clientAborts: 0,
  pipedBytes: 0,
  inflightNow: (): number => 0,
};
let upstreamSent = 0;

/** 上游 node：无头流。 */
const upstream = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    if (!new URL(req.url).pathname.startsWith('/v1/stream')) {
      return new Response('nope', { status: 404 });
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Bun.sleep(2);
        if (finiteKb > 0 && upstreamSent >= finiteKb * 1024) {
          controller.close();
          return;
        }
        stats.chunks += 1;
        upstreamSent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
  },
});
const upstreamOrigin = `http://127.0.0.1:${upstream.port}`;
const directUrl = `${upstreamOrigin}/v1/stream`;

let targetUrl = directUrl;
let platform: ReturnType<typeof Bun.serve> | undefined;
let proxy: PlatformProxy | undefined;

if (
  mode === 'proxy' ||
  mode === 'passthrough' ||
  mode === 'passthrough-signal' ||
  mode === 'proxy-shape' ||
  mode === 'pump' ||
  mode === 'pipe' ||
  mode === 'passthrough-abort' ||
  mode === 'pump-safe'
) {
  if (mode === 'proxy') {
    proxy = new PlatformProxy({
      resolveNode: () => ({ nodeId: 'stream-node', name: 'stream-node', apiUrl: upstreamOrigin }),
      resolveToken: () => undefined,
      limits: {},
      log: () => undefined,
    });
    const activeProxy = proxy;
    platform = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const route = parseProxyRoute(url.pathname);
        if (route === null) return new Response('not found', { status: 404 });
        return activeProxy.handleHttp(req, route, url);
      },
    });
  } else if (mode === 'passthrough') {
    // passthrough：平台直接 `new Response(upstream.body)`，不手写泵、内层 fetch 不带 signal。
    platform = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (!url.pathname.startsWith('/nodes/stream-node/v1/stream')) {
          return new Response('not found', { status: 404 });
        }
        const upstreamResponse = await fetch(directUrl);
        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          headers: { 'content-type': 'application/octet-stream' },
        });
      },
    });
  } else if (mode === 'passthrough-signal') {
    // 唯一差别：内层 fetch 带一个 AbortSignal（永不 abort，只是「挂着」）。
    platform = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (!url.pathname.startsWith('/nodes/stream-node/v1/stream')) {
          return new Response('not found', { status: 404 });
        }
        const controller = new AbortController();
        const upstreamResponse = await fetch(directUrl, {
          redirect: 'manual',
          signal: controller.signal,
        });
        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          headers: { 'content-type': 'application/octet-stream' },
        });
      },
    });
  } else if (mode === 'passthrough-abort') {
    // 候选写法 2：原生直通（`new Response(upstream.body)`，不手写泵）**加上**
    // `req.signal` → 内层 AbortController：客户端一断，上游 fetch 立刻被取消，
    // 所以原生泵不会留下一条永远在产生数据的上游流。
    platform = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (!url.pathname.startsWith('/nodes/stream-node/v1/stream')) {
          return new Response('not found', { status: 404 });
        }
        const controller = new AbortController();
        req.signal.addEventListener('abort', () => {
          stats.clientAborts += 1;
          controller.abort();
        });
        const upstreamResponse = await fetch(directUrl, {
          redirect: 'manual',
          signal: controller.signal,
        });
        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          headers: { 'content-type': 'application/octet-stream' },
        });
      },
    });
  } else if (mode === 'pipe') {
    // 候选写法 3：`pipeThrough(new TransformStream)` —— 记账靠 transform 计数 + flush 释放，
    // 取消靠 `req.signal`。既不手写 ReadableStream，也不完全放弃可观测。
    platform = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (!url.pathname.startsWith('/nodes/stream-node/v1/stream')) {
          return new Response('not found', { status: 404 });
        }
        const upstreamResponse = await fetch(directUrl);
        const body = upstreamResponse.body;
        if (body === null) return new Response(body, { status: upstreamResponse.status });
        const counted = body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(value, controller) {
              stats.pipedBytes += value.byteLength;
              controller.enqueue(value);
            },
            flush() {
              // 生产里这里就是 releaseSlot()
            },
          }),
        );
        return new Response(counted, {
          status: upstreamResponse.status,
          headers: { 'content-type': 'application/octet-stream' },
        });
      },
    });
  } else if (mode === 'pump' || mode === 'pump-safe') {
    // 只测「手写泵」这一件事：内层不带 signal、不做槽位记账。
    // `pump-safe` 多一条：cancel 之后再回来的 `reader.read()` 一律不进 controller
    // （即「取消之后不许碰 controller」这条规则，Bun 1.3.9 原生层守不守）。
    const safe = mode === 'pump-safe';
    platform = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (!url.pathname.startsWith('/nodes/stream-node/v1/stream')) {
          return new Response('not found', { status: 404 });
        }
        const upstreamResponse = await fetch(directUrl);
        const body = upstreamResponse.body;
        if (body === null) return new Response(body, { status: upstreamResponse.status });
        const reader = body.getReader();
        let cancelled = false;
        const bodyStream = new ReadableStream<Uint8Array>({
          async pull(streamController) {
            if (safe && cancelled) return;
            try {
              const { done, value } = await reader.read();
              if (safe && cancelled) return;
              if (done) {
                streamController.close();
                return;
              }
              if (value !== undefined) streamController.enqueue(value);
            } catch (error) {
              if (safe && cancelled) return;
              streamController.error(error);
            }
          },
          cancel(reason) {
            cancelled = true;
            void reader.cancel(reason).catch(() => undefined);
          },
        });
        return new Response(bodyStream, {
          status: upstreamResponse.status,
          headers: { 'content-type': 'application/octet-stream' },
        });
      },
    });
  } else {
    // proxy-shape：`handleHttp` 流式分支的**逐行复制**（手写泵 + 槽位记账 + 内层 signal），
    // 但去掉 registry / 头处理 —— 用来判「是不是代理里的某一行」。
    let inflight = 0;
    // 记账在本探针里不参与判定，但让它可读（否则就是一段没人验证的死代码）：
    stats.inflightNow = () => inflight;
    platform = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (!url.pathname.startsWith('/nodes/stream-node/v1/stream')) {
          return new Response('not found', { status: 404 });
        }
        inflight += 1;
        let slotHeld = true;
        const releaseSlot = (): void => {
          if (!slotHeld) return;
          slotHeld = false;
          inflight -= 1;
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        (timer as { unref?: () => void }).unref?.();
        let upstreamResponse: Response;
        try {
          upstreamResponse = await fetch(directUrl, {
            method: req.method,
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch {
          clearTimeout(timer);
          releaseSlot();
          return new Response('boom', { status: 502 });
        }
        clearTimeout(timer);
        const body = upstreamResponse.body;
        if (body === null) {
          releaseSlot();
          return new Response(body, { status: upstreamResponse.status });
        }
        const reader = body.getReader();
        const bodyStream = new ReadableStream<Uint8Array>({
          async pull(streamController) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                releaseSlot();
                streamController.close();
                return;
              }
              if (value !== undefined) streamController.enqueue(value);
            } catch (error) {
              releaseSlot();
              streamController.error(error);
            }
          },
          cancel(reason) {
            releaseSlot();
            void reader.cancel(reason).catch(() => undefined);
          },
        });
        return new Response(bodyStream, {
          status: upstreamResponse.status,
          headers: { 'content-type': 'application/octet-stream' },
        });
      },
    });
  }
  targetUrl = `http://127.0.0.1:${platform.port}/nodes/stream-node/v1/stream`;
}

console.log(
  `# probe mode=${mode} conns=${conns} chunk=${kb}KB finite=${finiteKb > 0 ? `${finiteKb}KB` : 'inf'} seconds=${seconds}`,
);
console.log(`# target=${targetUrl} upstream=${directUrl}`);

const stopSampler = startSampler(() => ({ rounds: stats.rounds, err: stats.errors }));
const rssAtStart = rssMb();
const startedAt = Date.now();
const deadline = startedAt + seconds * 1000;

/** 手写泵：与生产 proxy.ts 的流式分支同形（pull 里 reader.read() → enqueue）。 */
function handRolledBody(upstreamBody: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value !== undefined) controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
    },
  });
}

async function oneRound(index: number): Promise<void> {
  const controller = new AbortController();
  const useAbort = mode === 'raw-abort' || index % 2 === 0;
  try {
    let response: Response;
    if (mode === 'handrolled') {
      response = await fetch(targetUrl, { signal: controller.signal });
      const upstreamBody = response.body;
      if (upstreamBody === null) return;
      response = new Response(handRolledBody(upstreamBody), { status: response.status });
    } else {
      response = await fetch(targetUrl, { signal: controller.signal });
    }
    const body = response.body;
    if (body === null) return;
    const reader = body.getReader();
    const want = 3 + (index % 4);
    for (let step = 0; step < want; step += 1) {
      const { done } = await reader.read();
      if (done) break;
    }
    if (useAbort) {
      controller.abort();
    } else {
      await reader.cancel('client gone');
    }
    stats.rounds += 1;
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown';
    // 中断自己会让在飞的 read 抛 AbortError / InvalidStateError：预期，不算失败。
    if (name !== 'AbortError' && !String(error).includes('cancel')) {
      stats.errors += 1;
      if (stats.errors <= 3) console.log(`# round error: ${String(error)}`);
    }
  }
}

const workers: Array<Promise<void>> = [];
for (let index = 0; index < conns; index += 1) {
  workers.push(
    (async () => {
      let round = index;
      while (Date.now() < deadline) {
        await oneRound(round);
        round += 1;
      }
    })(),
  );
}
await Promise.all(workers);
stopSampler();

const elapsed = Date.now() - startedAt;
console.log(
  `# survived: rounds=${stats.rounds} chunks=${stats.chunks} errors=${stats.errors} ` +
    `clientAborts=${stats.clientAborts} inflight=${stats.inflightNow()} ` +
    `in ${(elapsed / 1000).toFixed(1)}s (~${(stats.rounds / (elapsed / 1000)).toFixed(1)}/s)`,
);
console.log(`# rss: start=${rssAtStart.toFixed(1)}MB end=${rssMb().toFixed(1)}MB`);
console.log(sampleLine(elapsed, { phase: 'done', mode }));
console.log(`# RESULT: ${mode} survived`);
proxy?.dispose();
upstream.stop(true);
platform?.stop(true);
process.exit(0);
