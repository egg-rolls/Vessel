/**
 * 0.58：平台代理 node 的**门面**（HTTP 转发 + WS 连接生命周期 + 统计）。
 *
 * 边界（一条都不许松）：
 * - 目标地址**只来自注册表**（`resolveNode`）；客户端给的 `node_id` 查不到就是 404，
 *   永远没有「客户端指定 host/port」这条路径 —— 否则代理立刻变成 SSRF 通道；
 * - 路径 / 方法 / RPC 方法都过 `proxy-config.ts` 的白名单（fail-closed）；
 * - 请求体、并发、超时、缓冲全都有上限；流式响应按流转发，绝不整体缓存；
 * - node token 只在本进程内拼进 `Authorization`，**不进任何响应体、不进日志**。
 *
 * @module @vessel-agent/serve/platform/proxy
 */

import { formatEventFields } from '../log-event.js';
import {
  checkProxyHttpPath,
  checkProxyMethod,
  checkProxyWsPath,
  checkRpcMethod,
  isHealthProbePath,
  type PlatformProxyLimits,
  PROXY_BASE_PATH,
  type ProxyRejection,
  type ProxyRoute,
  parseProxyRoute,
  resolveProxyLimits,
} from './proxy-config.js';
import {
  ProxyWsBridge,
  type ProxyWsBridgeOptions,
  type ProxyWsClient,
  type ProxyWsUpstream,
} from './proxy-ws.js';
import type { PlatformNodeDescriptor } from './types.js';

export type { PlatformProxyLimits, ProxyRoute };
export { PROXY_BASE_PATH, parseProxyRoute };

/** 失败类日志的节流窗口（毫秒）与条目上限。 */
const LOG_THROTTLE_MS = 5_000;
const LOG_THROTTLE_MAX_KEYS = 256;

/**
 * HTTP 流式转发的实现（0.58 崩溃加固）。
 *
 * - `passthrough`（**win32 缺省**）：把上游 `body` 原样交给 Bun 的原生泵
 *   （`new Response(upstream.body)`），并用 `req.signal → controller.abort()` 在客户端
 *   断开时取消上游 fetch；
 * - `pump`：手写 `ReadableStream` 包 `upstream.body.getReader()`（0.58 原实现）。
 *
 * 为什么换：Bun 1.3.9 win32-x64 上，`pump` 形状（手写泵 + 浏览器中途取消 + 上游流还活着）
 * 会 **稳定复现** gateway 那次崩溃——同一个地址 `0xFFFFFFFFFFFFFFFF`、同一份 bun.report
 * 指纹（`ea1cf6cdbb…`），0.4–1.5 s 内必崩。取证与最小触发见
 * `scripts/crash-hunt/probe-stream-crash.ts` 与 `docs/operations/BUN-WIN32-SEGFAULT.md`。
 *
 * 开关：`VESSEL_PROXY_HTTP_STREAM=passthrough|pump`（`1`/`native` 同 passthrough，
 * `0` 同 pump）。其它平台缺省仍是 `pump`：这条崩溃只在 Windows 上取证到，不在别处
 * 顺手改行为。
 */
export type HttpStreamMode = 'pump' | 'passthrough';

/**
 * `passthrough` 下「整份读完」的上界。
 *
 * 1 MiB：代理流量的大头是 `/v1/*` 的 JSON RPC（实测 p99 远小于这个数），而超过 1 MiB 的
 * 响应几乎都是流（事件流 / 下载），整份读会把「慢消费者」变成「平台内存」。
 */
const STREAM_BUFFER_MAX_BYTES = 1024 * 1024;

/** 本进程实际使用的流式转发实现。 */
export function httpStreamMode(): HttpStreamMode {
  const raw = (process.env.VESSEL_PROXY_HTTP_STREAM ?? '').trim().toLowerCase();
  if (raw === 'pump' || raw === '0') return 'pump';
  if (raw === 'passthrough' || raw === 'native' || raw === '1') return 'passthrough';
  return process.platform === 'win32' ? 'passthrough' : 'pump';
}

/** 逐跳头（RFC 7230 §6.1）：转发任一侧都必须剔除。 */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * 请求侧额外剔除的头。
 *
 * - `host`：由 fetch 按目标 URL 生成（node 的 Host 校验看到的是平台，而不是浏览器伪造值）；
 * - `authorization` / `cookie` / `x-vessel-proxy-secret`：防混淆代理 —— 浏览器带来的任何
 *   凭据一律丢弃，`Authorization` 由平台覆写成 node token；
 * - `x-forwarded-*` / `x-vessel-*`：平台内部信号不外泄给 node；
 * - `sec-websocket-*`：这条通道不接受 Upgrade。
 */
const STRIP_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-vessel-proxy-secret',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
]);

/**
 * 响应侧额外剔除的头。
 *
 * `set-cookie` 默认剥掉：在平台域下种 node cookie 等于把 node 的会话搬到平台域，
 * 而且 node 端用不到 cookie 语义（凭据是 Bearer）。
 */
const STRIP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'set-cookie',
  'set-cookie2',
  // 3xx 的 location 会指导浏览器跳出平台 origin（既是信息泄漏也是绕过代理的路径）。
  'location',
]);

/** 代理门面的依赖；组合根注入，代理自己不认识配置文件。 */
export interface PlatformProxyDeps {
  /** 按 `node_id` 查注册表；**唯一**的目标地址来源（探测与否由注册表决定）。 */
  resolveNode: (nodeId: string) => PlatformNodeDescriptor | undefined;
  /** 该 node 的生效 token；只在本进程内使用。undefined = 该 node 回环匿名。 */
  resolveToken: (nodeId: string) => string | undefined;
  /** 能力开关：false = 平台不提供 `/nodes/*`（老直连路径照旧）。 */
  enabled?: boolean | undefined;
  limits?: Partial<PlatformProxyLimits> | undefined;
  /** 记账出口；缺省 `console.warn`（与 node 侧 `gateway.ws.closed` 同通道）。 */
  log?: ((fields: Record<string, unknown>) => void) | undefined;
  /** 可注入 fetch（探针用）；缺省全局 fetch。 */
  fetchImpl?: typeof fetch | undefined;
  /** 可注入 WS 客户端工厂（探针用）。 */
  connectWs?: ((url: string, headers: Record<string, string>) => ProxyWsUpstream) | undefined;
  now?: (() => number) | undefined;
}

/** 代理运行期统计（只读快照；`/platform/health.get` 与排障用）。 */
export interface PlatformProxyStats {
  http_requests: number;
  http_failures: number;
  http_inflight: number;
  ws_opened: number;
  ws_active: number;
  ws_rejected: number;
  ws_pending_bytes: number;
  /** 走原生直通的流式响应条数（`passthrough` 模式下的累计值）。 */
  http_passthrough_streams: number;
  /** 本进程的流式转发实现（`pump` / `passthrough`）：排障第一眼看这一项。 */
  http_stream_mode: HttpStreamMode;
}

/** WS 升级的裁决结果：要么给出桥接器，要么给一个可直接返回的响应。 */
export type ProxyUpgradeDecision =
  | { ok: true; bridge: ProxyWsBridge }
  | { ok: false; response: Response };

function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function rejectionResponse(rejection: ProxyRejection): Response {
  return jsonError(rejection.code, rejection.message, rejection.status);
}

/** 单次请求体超过上限：调用方按 413 回。 */
class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * 按流读请求体，边读边计数（不整体缓冲）。
 *
 * 为什么不用 `req.arrayBuffer()` 一把梭：`Content-Length` 可以缺省（chunked），
 * 也可以撒谎。上限必须在**读的时候**生效，否则一个 10 GB 的 chunked 体就能把平台读爆。
 */
async function readBodyLimited(req: Request, limit: number): Promise<Uint8Array | undefined> {
  const body = req.body;
  if (body === null) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return undefined;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** 从 `{v,id,method,...}` 信封里取方法名（只为白名单判定，不改写请求体）。 */
function readRpcMethod(body: Uint8Array): unknown {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return (parsed as Record<string, unknown>).method;
  } catch {
    return undefined;
  }
}

/**
 * 代理门面。
 *
 * 生命周期：`PlatformProxy` 由 `startPlatformGateway` 创建一次，随 server 一起停。
 * WS 连接由 Bun 的 `websocket` handler 转进来（`begin` / `message` / `close` / `pong`）。
 */
export class PlatformProxy {
  private readonly deps: PlatformProxyDeps;
  private readonly limits: PlatformProxyLimits;
  private readonly log: (fields: Record<string, unknown>) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly bridges = new Set<ProxyWsBridge>();
  /** 失败日志节流状态：key → 上次输出时间与合并掉的次数。 */
  private readonly failureLog = new Map<string, { at: number; suppressed: number }>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private inflight = 0;
  private wsOpened = 0;
  private wsRejected = 0;
  private httpRequests = 0;
  private httpFailures = 0;
  private wsPendingBytes = 0;
  private transparentStreams = 0;
  private closed = false;

  constructor(deps: PlatformProxyDeps) {
    this.deps = deps;
    this.limits = resolveProxyLimits(deps.limits);
    this.log =
      deps.log ??
      ((fields) => {
        // 0.58：单行 key=value（见 `log-event.ts`）；VESSEL_LOG_JSON=1 时退单行 JSON。
        console.warn(formatEventFields(fields));
      });
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  get enabled(): boolean {
    return this.deps.enabled !== false;
  }

  stats(): PlatformProxyStats {
    return {
      http_requests: this.httpRequests,
      http_failures: this.httpFailures,
      http_inflight: this.inflight,
      ws_opened: this.wsOpened,
      ws_active: this.bridges.size,
      ws_rejected: this.wsRejected,
      ws_pending_bytes: this.wsPendingBytes,
      http_passthrough_streams: this.transparentStreams,
      http_stream_mode: httpStreamMode(),
    };
  }

  /**
   * 普通 HTTP 转发。
   *
   * 鉴权由调用方（平台入口）完成：到这个方法为止，「谁能访问代理」已经是平台会话语义。
   */
  async handleHttp(req: Request, route: ProxyRoute, url: URL): Promise<Response> {
    if (!this.enabled) {
      return jsonError(
        'proxy_disabled',
        'proxy_disabled: 这个部署关闭了 gateway.proxy_nodes（浏览器应直连 node）。',
        404,
      );
    }
    const node = this.deps.resolveNode(route.nodeId);
    if (node === undefined) {
      return jsonError(
        'node_not_found',
        `node_not_found: 注册表里没有 node "${route.nodeId}"（代理只认注册表，不接受客户端指定地址）。`,
        404,
      );
    }
    const methodRejection = checkProxyMethod(req.method);
    if (methodRejection !== null) return rejectionResponse(methodRejection);
    const pathRejection = checkProxyHttpPath(route.rest);
    if (pathRejection !== null) return rejectionResponse(pathRejection);

    const upstreamUrl = this.buildUpstreamUrl(node, route.rest, url.search);
    if (upstreamUrl === null) {
      return jsonError('proxy_bad_path', 'proxy_bad_path: 路径无法安全拼接', 400);
    }

    if (this.inflight >= this.limits.maxConcurrentRequests) {
      this.httpFailures += 1;
      return new Response(
        JSON.stringify({
          error: {
            code: 'proxy_busy',
            message:
              `proxy_busy: 平台代理并发已达上限（${this.limits.maxConcurrentRequests}），` +
              '请稍后重试；这不是 node 的问题。',
          },
        }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Retry-After': '1',
            'X-Content-Type-Options': 'nosniff',
          },
        },
      );
    }

    this.inflight += 1;
    this.httpRequests += 1;
    let slotHeld = true;
    const releaseSlot = (): void => {
      if (!slotHeld) return;
      slotHeld = false;
      this.inflight -= 1;
    };

    try {
      const headers = this.upstreamRequestHeaders(req, node.nodeId);
      let body: Uint8Array | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // 先看 Content-Length（有就早退，不必读），再按实际字节数兜底。
        const declared = Number(req.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > this.limits.maxBodyBytes) {
          releaseSlot();
          this.httpFailures += 1;
          return jsonError(
            'payload_too_large',
            `payload_too_large: 请求体超过 ${this.limits.maxBodyBytes} 字节上限。`,
            413,
          );
        }
        try {
          body = await readBodyLimited(req, this.limits.maxBodyBytes);
        } catch (error) {
          releaseSlot();
          this.httpFailures += 1;
          if (error instanceof BodyTooLargeError) {
            return jsonError(
              'payload_too_large',
              `payload_too_large: 请求体超过 ${error.limit} 字节上限。`,
              413,
            );
          }
          return jsonError('invalid_request', 'invalid_request: 无法读取请求体', 400);
        }
        // RPC 方法白名单：判定方法名，不改写请求体（不做协议翻译）。
        if (route.rest === '/v1/rpc' && body !== undefined) {
          const method = readRpcMethod(body);
          const denial = checkRpcMethod(method);
          if (denial !== null) {
            releaseSlot();
            this.httpFailures += 1;
            this.logThrottled(
              `rpc_http|${node.nodeId}|${typeof method === 'string' ? method : ''}`,
              {
                event: 'gateway.proxy.rpc_denied',
                node_id: node.nodeId,
                node_name: node.name,
                method: typeof method === 'string' ? method : null,
                code: denial.code,
              },
            );
            return jsonError(denial.code, denial.message, denial.status);
          }
        }
      }

      // 响应头超时：流式响应在头到达后不再受这个定时器约束（否则 SSE 必被 30s 掐断）。
      const streamMode = httpStreamMode();
      //
      // 0.57：**健康探测单独一条短超时**。`/health` 借 30s 的 RPC 超时是错的——node 没起来
      // 时每个探活请求都白等 30s，用户看到的就是「页面卡住，然后 node_unreachable」。
      // 探活要快失败、快重试（1.5s 缺省），RPC 保持 30s（它本来就可能跑很久）。
      const timeoutMs = isHealthProbePath(route.rest)
        ? this.limits.probeTimeoutMs
        : this.limits.requestTimeoutMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      /**
       * 客户端断开 → 取消上游 fetch。
       *
       * 只在 `passthrough` 下挂：那时 body 归 Bun 的原生泵，我们没有 `cancel()` 可写，
       * 唯一能收口上游的地方就是这条 signal。`pump` 下由流的 `cancel()` 负责 —— 两条路
       * 都不能「没人管」，否则一条被放弃的上游流会一直产生数据（实测：无限流 + 客户端
       * 反复放弃 ⇒ 约 30 轮之后所有新请求挂住）。
       */
      const abortUpstream = (): void => controller.abort();
      if (streamMode === 'passthrough') {
        req.signal.addEventListener('abort', abortUpstream, { once: true });
      }
      let upstream: Response;
      try {
        upstream = await this.fetchImpl(upstreamUrl, {
          method: req.method,
          headers,
          ...(body !== undefined ? { body } : {}),
          // 不跟随重定向：3xx 若被跟随，代理就成了「跳到任意地址」的跳板（SSRF）。
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        req.signal.removeEventListener('abort', abortUpstream);
        releaseSlot();
        this.httpFailures += 1;
        const aborted = error instanceof Error && error.name === 'AbortError';
        this.logThrottled(`${aborted ? 'timeout' : 'unreachable'}|${node.nodeId}|${route.rest}`, {
          event: aborted ? 'gateway.proxy.node_timeout' : 'gateway.proxy.node_unreachable',
          node_id: node.nodeId,
          node_name: node.name,
          path: route.rest,
          timeout_ms: timeoutMs,
        });
        return aborted
          ? jsonError(
              'node_timeout',
              `node_timeout: node ${node.nodeId} 在 ${timeoutMs}ms 内没有回响应头。`,
              504,
            )
          : jsonError(
              'node_unreachable',
              `node_unreachable: 平台无法连接 node ${node.nodeId}（注册表地址）。`,
              502,
            );
      }
      clearTimeout(timer);

      const responseHeaders = this.downstreamResponseHeaders(upstream);

      // HEAD / 204 / 304 没有正文：直接返回，不等流。
      if (req.method === 'HEAD' || upstream.body === null) {
        req.signal.removeEventListener('abort', abortUpstream);
        releaseSlot();
        return new Response(upstream.body, {
          status: upstream.status,
          ...(upstream.statusText !== '' ? { statusText: upstream.statusText } : {}),
          headers: responseHeaders,
        });
      }

      // ── passthrough（win32 缺省）：先尽量「整份读完」，剩下的一律交给原生泵 ──────
      //
      // 为什么不手写泵：见 `httpStreamMode()` 的注释。
      //
      // 两步：
      // 1. **声明了长度且 ≤ 1 MiB**（代理流量的大头：`/v1/*` 的 JSON RPC）→ 整份读成
      //    字节再返回。这条路没有「流」也就没有取消竞态，且顺手把「原生泵会不计背压地
      //    把上游读空」这件事挡在门外（实测放弃一条无限流时，原生泵会多读约 126 块）。
      // 2. 其余（SSE、chunked、大响应）→ `new Response(upstream.body)`：body 归 Bun 的
      //    原生泵，客户端断开由 `req.signal → controller.abort()` 收口上游。
      //
      // 槽位统一在这里归还：原生泵接管 body 之后我们既没有 `cancel()` 也没有「流结束」
      // 的钩子，继续占着槽位只会让 `maxConcurrentRequests` 变成一条永远不归还的泄漏。
      if (streamMode === 'passthrough') {
        const contentType = upstream.headers.get('content-type') ?? '';
        const declared = Number(upstream.headers.get('content-length') ?? Number.NaN);
        const bufferable =
          !contentType.includes('text/event-stream') &&
          Number.isFinite(declared) &&
          declared >= 0 &&
          declared <= STREAM_BUFFER_MAX_BYTES;
        if (bufferable) {
          try {
            const whole = new Uint8Array(await upstream.arrayBuffer());
            releaseSlot();
            req.signal.removeEventListener('abort', abortUpstream);
            return new Response(whole, {
              status: upstream.status,
              ...(upstream.statusText !== '' ? { statusText: upstream.statusText } : {}),
              headers: responseHeaders,
            });
          } catch {
            // 读失败（连接被掐 / 上游半路死）：退回 502，别把它伪装成「空 200」。
            releaseSlot();
            req.signal.removeEventListener('abort', abortUpstream);
            this.httpFailures += 1;
            this.logThrottled(`body|${node.nodeId}|${route.rest}`, {
              event: 'gateway.proxy.node_body_failed',
              node_id: node.nodeId,
              node_name: node.name,
              path: route.rest,
            });
            return jsonError(
              'node_stream_failed',
              `node_stream_failed: node ${node.nodeId} 的响应体读到一半断了。`,
              502,
            );
          }
        }
        releaseSlot();
        this.transparentStreams += 1;
        return new Response(upstream.body, {
          status: upstream.status,
          ...(upstream.statusText !== '' ? { statusText: upstream.statusText } : {}),
          headers: responseHeaders,
        });
      }
      req.signal.removeEventListener('abort', abortUpstream);

      // ── pump：手写泵（非 Windows 缺省；`VESSEL_PROXY_HTTP_STREAM=pump` 可回退） ──
      // 流式转发：一次只 enqueue 一块，槽位在流结束 / 取消时归还 —— 流不会被整体缓存。
      const reader = upstream.body.getReader();
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
        status: upstream.status,
        ...(upstream.statusText !== '' ? { statusText: upstream.statusText } : {}),
        headers: responseHeaders,
      });
    } catch (error) {
      releaseSlot();
      this.httpFailures += 1;
      this.logThrottled(`failed|${node.nodeId}|${route.rest}`, {
        event: 'gateway.proxy.failed',
        node_id: node.nodeId,
        node_name: node.name,
        path: route.rest,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return jsonError('internal', 'internal: 代理转发失败（细节见平台日志）', 500);
    }
  }

  /**
   * WS 升级裁决。返回 `ok:true` 时调用方必须 `srv.upgrade(req, { data })` 并把
   * `bridge` 放进 `ws.data`；返回 `ok:false` 时直接把 `response` 发回去。
   */
  upgrade(
    route: ProxyRoute,
    url: URL,
    auth: { preAuthenticated: boolean; verifyPlatformToken: (token: string) => boolean },
  ): ProxyUpgradeDecision {
    if (!this.enabled) {
      return {
        ok: false,
        response: jsonError(
          'proxy_disabled',
          'proxy_disabled: 这个部署关闭了 gateway.proxy_nodes（浏览器应直连 node）。',
          404,
        ),
      };
    }
    const node = this.deps.resolveNode(route.nodeId);
    if (node === undefined) {
      return {
        ok: false,
        response: jsonError(
          'node_not_found',
          `node_not_found: 注册表里没有 node "${route.nodeId}"。`,
          404,
        ),
      };
    }
    const pathRejection = checkProxyWsPath(route.rest);
    if (pathRejection !== null) return { ok: false, response: rejectionResponse(pathRejection) };
    if (this.bridges.size >= this.limits.wsMaxConnections) {
      this.wsRejected += 1;
      return {
        ok: false,
        response: new Response(
          JSON.stringify({
            error: {
              code: 'proxy_busy',
              message:
                `proxy_busy: 代理 WS 连接已达上限（${this.limits.wsMaxConnections}），` +
                '关掉多余的标签页后重试。',
            },
          }),
          {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              'Retry-After': '5',
              'X-Content-Type-Options': 'nosniff',
            },
          },
        ),
      };
    }

    const wsUrl = this.buildUpstreamWsUrl(node, route.rest, url.search);
    if (wsUrl === null) {
      return {
        ok: false,
        response: jsonError('proxy_bad_path', 'proxy_bad_path: WS 路径无法安全拼接', 400),
      };
    }

    const sinceParam = Number(url.searchParams.get('since') ?? '0');
    const since = Number.isInteger(sinceParam) && sinceParam > 0 ? sinceParam : 0;

    const options: ProxyWsBridgeOptions = {
      nodeId: node.nodeId,
      nodeName: node.name,
      wsUrl,
      token: this.deps.resolveToken(node.nodeId),
      preAuthenticated: auth.preAuthenticated,
      since,
      verifyPlatformToken: auth.verifyPlatformToken,
      frameDenied: (frame) => {
        if (frame.kind !== 'req') return null;
        const denial = checkRpcMethod(frame.method);
        if (denial === null) return null;
        // 记账：被拒的 WS 方法也必须有痕迹（否则「点了没反应」永远查不出来）。
        this.logThrottled(
          `rpc_ws|${node.nodeId}|${typeof frame.method === 'string' ? frame.method : ''}`,
          {
            event: 'gateway.proxy.rpc_denied',
            node_id: node.nodeId,
            node_name: node.name,
            method: typeof frame.method === 'string' ? frame.method : null,
            via: 'ws',
            code: denial.code,
          },
        );
        return denial.message;
      },
      limits: this.limits,
      reserveBytes: (bytes) => this.reserveBytes(bytes),
      releaseBytes: (bytes) => this.releaseBytes(bytes),
      log: (fields) => this.log(fields),
      ...(this.deps.connectWs !== undefined ? { connect: this.deps.connectWs } : {}),
      ...(this.deps.now !== undefined ? { now: this.deps.now } : {}),
    };

    const bridge = new ProxyWsBridge(options);
    this.bridges.add(bridge);
    this.wsOpened += 1;
    this.armHeartbeat();
    return { ok: true, bridge };
  }

  /** Bun `websocket.open`：浏览器侧连接已建立。 */
  wsOpen(bridge: ProxyWsBridge, client: ProxyWsClient): void {
    bridge.begin(client);
  }

  wsMessage(bridge: ProxyWsBridge, data: unknown): void {
    bridge.message(data);
  }

  wsPong(bridge: ProxyWsBridge): void {
    bridge.pong();
  }

  wsClose(bridge: ProxyWsBridge, code: number, reason: string): void {
    bridge.clientClose(code, reason);
    this.bridges.delete(bridge);
  }

  /** 停服：断开全部代理连接（`who: 'platform'`，`reason: server stopping`）。 */
  closeAll(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    for (const bridge of [...this.bridges]) {
      bridge.shutdown();
    }
    this.bridges.clear();
  }

  /** 测试 / 探针用的显式拆除（与 `closeAll` 同义，语义更明确）。 */
  dispose(): void {
    this.closeAll();
  }

  private armHeartbeat(): void {
    if (this.heartbeat !== undefined) return;
    this.heartbeat = setInterval(() => {
      const now = (this.deps.now ?? Date.now)();
      for (const bridge of [...this.bridges]) {
        if (bridge.isClosed) {
          this.bridges.delete(bridge);
          continue;
        }
        bridge.heartbeat(now);
        if (bridge.isClosed) this.bridges.delete(bridge);
      }
    }, this.limits.wsHeartbeatIntervalMs);
    (this.heartbeat as { unref?: () => void }).unref?.();
  }

  /**
   * 失败类日志的节流（同一 `key` 每 `LOG_THROTTLE_MS` 最多一行，其余计数合并）。
   *
   * 为什么需要：node 挂掉时每个标签页每秒都在重试，一次事故能打几十 KB 日志
   * （0.58 验收实测：一次 70 并发超时用例打了 5 KB）。日志是排障工具，被刷爆之后
   * 就没人看了。合并行里带 `suppressed` —— 丢的是重复，不是事实。
   */
  private logThrottled(key: string, fields: Record<string, unknown>): void {
    const now = Date.now();
    const previous = this.failureLog.get(key);
    if (previous !== undefined && now - previous.at < LOG_THROTTLE_MS) {
      previous.suppressed += 1;
      return;
    }
    // 无界 Map 是隐患：条目数只随 (node, 事件, 方法) 组合增长，但也要有上限。
    if (this.failureLog.size > LOG_THROTTLE_MAX_KEYS) this.failureLog.clear();
    this.failureLog.set(key, { at: now, suppressed: 0 });
    this.log({
      ...fields,
      ...(previous !== undefined && previous.suppressed > 0
        ? { suppressed: previous.suppressed }
        : {}),
    });
  }

  private reserveBytes(bytes: number): boolean {
    if (this.wsPendingBytes + bytes > this.limits.wsPendingBudgetBytes) return false;
    this.wsPendingBytes += bytes;
    return true;
  }
  private releaseBytes(bytes: number): void {
    this.wsPendingBytes = Math.max(0, this.wsPendingBytes - bytes);
  }

  /** 注册表地址 + node 侧路径；拼完再**验一遍 origin**（纵深防御，防拼接异常）。 */
  private buildUpstreamUrl(
    node: PlatformNodeDescriptor,
    rest: string,
    search: string,
  ): string | null {
    let base: URL;
    try {
      base = new URL(node.apiUrl);
    } catch {
      return null;
    }
    let target: URL;
    try {
      target = new URL(`${rest}${search}`, `${base.origin}/`);
    } catch {
      return null;
    }
    // 客户端路径永远不能改变 authority；一旦变了就是 SSRF 尝试，直接失败。
    if (target.origin !== base.origin) return null;
    return target.toString();
  }

  private buildUpstreamWsUrl(
    node: PlatformNodeDescriptor,
    rest: string,
    search: string,
  ): string | null {
    const httpUrl = this.buildUpstreamUrl(node, rest, search);
    if (httpUrl === null) return null;
    return httpUrl.startsWith('https://')
      ? `wss://${httpUrl.slice('https://'.length)}`
      : `ws://${httpUrl.slice('http://'.length)}`;
  }

  /**
   * 请求头：逐跳头 / 浏览器凭据一律剔除，`Authorization` 覆写为 node token。
   * token 缺失（node 回环匿名）时不带 Authorization —— 由 node 自己的鉴权决定。
   */
  private upstreamRequestHeaders(req: Request, nodeId: string): Headers {
    const headers = new Headers();
    for (const [name, value] of req.headers) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower)) continue;
      if (STRIP_REQUEST_HEADERS.has(lower)) continue;
      if (lower.startsWith('x-forwarded-') || lower.startsWith('x-vessel-')) continue;
      if (lower === 'accept-encoding') continue;
      headers.set(lower, value);
    }
    const token = this.deps.resolveToken(nodeId);
    if (typeof token === 'string' && token !== '') {
      headers.set('authorization', `Bearer ${token}`);
    }
    // 平台是这条请求的客户端：让 node 侧日志能区分「经代理」与「直连」。
    headers.set('x-vessel-via', 'platform-proxy');
    return headers;
  }

  /** 响应头：剔除逐跳头与 `set-cookie` / `location`。 */
  private downstreamResponseHeaders(upstream: Response): Headers {
    const headers = new Headers();
    for (const [name, value] of upstream.headers) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower)) continue;
      if (STRIP_RESPONSE_HEADERS.has(lower)) continue;
      headers.set(lower, value);
    }
    // 代理层身份（不含任何凭据）：浏览器 / 排障能看出这一跳是平台给的。
    headers.set('x-vessel-via', 'platform-proxy');
    return headers;
  }
}
