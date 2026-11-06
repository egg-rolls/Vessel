/**
 * 插件 HTTP 反向代理（CONTRACT-0.48 §3）。
 *
 * 只转发已经在路由表里的请求；所有安全边界由宿主执行：
 * - 剥离客户端 `Authorization` / `Cookie` / `X-Vessel-*` / `X-Forwarded-*`；
 * - `Host` 改写为插件回环地址，只注入内部 token + tenant；
 * - 请求 / 响应 body、总超时、流式 idle、并发连接上限；
 * - 响应头 allowlist，禁止 `Set-Cookie` 与 CORS 头。
 *
 * @module @vessel-agent/serve/plugin-host
 */

import { type ProtocolErrorCode, protocolError } from '../protocol.js';
import type { PluginHttpRoute, PluginHttpTarget } from './http.js';

export interface PluginHttpProxyOptions {
  request: Request;
  /** 原始请求 URL（保留 path + query）。 */
  url: URL;
  route: PluginHttpRoute;
  target: PluginHttpTarget;
  tenantId: string;
  /** gateway 已算好的同源 CORS 头；插件响应不得自带 CORS。 */
  cors?: Record<string, string>;
}

const DROP_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

const RESPONSE_HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  'content-type',
  'content-language',
  'content-disposition',
  'cache-control',
  'etag',
  'last-modified',
  'vary',
  'accept-ranges',
  'content-range',
  'www-authenticate',
  'retry-after',
]);

class ProxyFailure extends Error {
  readonly status: number;
  readonly code: ProtocolErrorCode;

  constructor(status: number, code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = 'ProxyFailure';
    this.status = status;
    this.code = code;
  }
}

function errorResponse(
  status: number,
  code: ProtocolErrorCode,
  message: string,
  cors: Record<string, string> | undefined,
): Response {
  return new Response(JSON.stringify({ error: protocolError(code, message) }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(cors ?? {}),
    },
  });
}

function failureResponse(error: unknown, cors: Record<string, string> | undefined): Response {
  if (error instanceof ProxyFailure) {
    return errorResponse(error.status, error.code, error.message, cors);
  }
  return errorResponse(502, 'internal', 'Plugin HTTP upstream failed.', cors);
}

/** 最小读取面：兼容 Bun fetch 与 node:stream/web 的 reader 声明。 */
interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

/** 单次读取：受 idle 与总 deadline 双重约束。 */
async function readChunk(
  reader: ByteReader,
  idleTimeoutMs: number | null,
  deadline: number | null,
): Promise<{ done: boolean; value?: Uint8Array }> {
  let waitMs = Number.POSITIVE_INFINITY;
  if (idleTimeoutMs !== null) waitMs = Math.min(waitMs, idleTimeoutMs);
  if (deadline !== null) waitMs = Math.min(waitMs, deadline - Date.now());
  if (!Number.isFinite(waitMs)) return reader.read();
  if (waitMs <= 0) {
    void reader.cancel().catch(() => {});
    throw new ProxyFailure(504, 'timeout', 'Plugin HTTP request timed out.');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(new ProxyFailure(504, 'timeout', 'Plugin HTTP request timed out.'));
    }, waitMs);
  });
  try {
    return await Promise.race([reader.read(), timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 读完整 body；超过上限 → 413。 */
async function readLimitedBody(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number | null,
  idleTimeoutMs: number | null,
  deadline: number | null,
): Promise<Uint8Array | undefined> {
  if (stream === null) return undefined;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, idleTimeoutMs, deadline);
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (maxBytes !== null && total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new ProxyFailure(
          413,
          'payload_too_large',
          'Plugin HTTP body exceeds the size limit.',
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 超时 / 取消后仍有挂起的 read，锁由 cancel 收口
    }
  }
  if (chunks.length === 0) return new Uint8Array(0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function forwardRequestHeaders(
  request: Request,
  target: PluginHttpTarget,
  tenantId: string,
  body: Uint8Array | undefined,
): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith('x-vessel-') || lower.startsWith('x-forwarded-')) continue;
    headers.set(name, value);
  }
  const host = new URL(target.url).host;
  headers.set('host', host);
  headers.set('x-vessel-plugin-token', target.token);
  headers.set('x-vessel-tenant', tenantId);
  if (body !== undefined) headers.set('content-length', String(body.byteLength));
  return headers;
}

function responseHeaders(
  upstream: Response,
  cors: Record<string, string> | undefined,
  contentLength: number | undefined,
): Headers {
  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    // allowlist + 显式拒绝 Set-Cookie / CORS（上游即使伪造也不会透传）。
    if (!RESPONSE_HEADER_ALLOWLIST.has(lower)) continue;
    if (lower.startsWith('access-control-') || lower.startsWith('set-cookie')) continue;
    headers.set(name, value);
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  // Bun fetch 会解压 body；不转发上游 content-length / content-encoding。
  headers.delete('content-length');
  headers.delete('content-encoding');
  if (contentLength !== undefined) headers.set('Content-Length', String(contentLength));
  if (cors !== undefined) {
    for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  }
  return headers;
}

function streamBody(
  upstream: ReadableStream<Uint8Array>,
  idleTimeoutMs: number | null,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await readChunk(reader, idleTimeoutMs, null);
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * 反向代理一次已授权请求。
 *
 * 响应状态：413 body 超限；504 总超时 / idle；502 上游不可达。
 * `responseMode: 'stream'` 跳过响应体上限，只用 idle timeout 约束。
 */
export async function proxyPluginHttpRequest(options: PluginHttpProxyOptions): Promise<Response> {
  const { request, url, route, target, tenantId, cors } = options;
  const limits = route.limits;
  const deadline = limits.timeoutMs !== null ? Date.now() + limits.timeoutMs : null;
  const controller = new AbortController();
  const onClientAbort = (): void => controller.abort();
  request.signal.addEventListener('abort', onClientAbort, { once: true });
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  if (deadline !== null) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      request.signal.removeEventListener('abort', onClientAbort);
      return errorResponse(504, 'timeout', 'Plugin HTTP request timed out.', cors);
    }
    totalTimer = setTimeout(() => controller.abort(), remaining);
  }

  try {
    // 请求 body：先看 Content-Length，再按流式上限读取。
    const declaredLength = Number(request.headers.get('content-length') ?? '');
    if (
      limits.maxBodyBytes !== null &&
      Number.isFinite(declaredLength) &&
      declaredLength > limits.maxBodyBytes
    ) {
      throw new ProxyFailure(413, 'payload_too_large', 'Plugin HTTP body exceeds the size limit.');
    }
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await readLimitedBody(request.body, limits.maxBodyBytes, null, deadline);

    const headers = forwardRequestHeaders(request, target, tenantId, body);
    const upstreamUrl = `${target.url}${url.pathname}${url.search}`;

    // idle 计时从发出请求开始：等首字节（响应头）同样算“没有数据”。
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    const fetchPromise = fetch(upstreamUrl, {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
      redirect: 'manual',
    });
    const idleHeaderTimeout =
      limits.idleTimeoutMs === null
        ? undefined
        : new Promise<never>((_resolve, reject) => {
            headerTimer = setTimeout(() => {
              controller.abort();
              reject(new ProxyFailure(504, 'timeout', 'Plugin HTTP upstream went idle.'));
            }, limits.idleTimeoutMs as number);
          });

    let upstream: Response;
    try {
      upstream =
        idleHeaderTimeout === undefined
          ? await fetchPromise
          : await Promise.race([fetchPromise, idleHeaderTimeout]);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProxyFailure(504, 'timeout', 'Plugin HTTP request timed out.');
      }
      throw new ProxyFailure(
        502,
        'internal',
        `Plugin HTTP upstream is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (headerTimer !== undefined) clearTimeout(headerTimer);
    }

    const noBody = request.method === 'HEAD' || upstream.status === 204 || upstream.status === 304;

    if (route.responseMode === 'stream') {
      // stream 只受 idle timeout 约束；响应头已到，总超时不再适用。
      if (totalTimer !== undefined) clearTimeout(totalTimer);
      totalTimer = undefined;
      if (noBody || upstream.body === null) {
        return new Response(null, {
          status: upstream.status,
          headers: responseHeaders(upstream, cors, undefined),
        });
      }
      return new Response(streamBody(upstream.body, limits.idleTimeoutMs), {
        status: upstream.status,
        headers: responseHeaders(upstream, cors, undefined),
      });
    }

    const responseBody = noBody
      ? undefined
      : await readLimitedBody(
          upstream.body,
          limits.maxResponseBytes,
          limits.idleTimeoutMs,
          deadline,
        );
    return new Response(noBody ? null : (responseBody ?? new Uint8Array(0)), {
      status: upstream.status,
      headers: responseHeaders(upstream, cors, responseBody?.byteLength),
    });
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof ProxyFailure)) {
      return errorResponse(504, 'timeout', 'Plugin HTTP request timed out.', cors);
    }
    return failureResponse(error, cors);
  } finally {
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    request.signal.removeEventListener('abort', onClientAbort);
  }
}
