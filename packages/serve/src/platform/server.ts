/**
 * 0.49 G1：Platform Gateway 独立监听。
 *
 * 单一 `Bun.serve`：静态宿主 + `/health` + `POST /platform/rpc`。
 * 路由表与 node 完全分离：`/v1/*`、`/plugins/*`、`/ws`、`/sse` 一律 404，不反代。
 *
 * @module @vessel-agent/serve/platform/server
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type AuthRequestContext, AuthService } from '../auth/index.js';
import {
  buildContentSecurityPolicy,
  corsHeaders,
  hostAllowed,
  normalizeAllowedOrigins,
  originAllowed,
  resolveRequestEdge,
} from '../gateway/auth.js';
import { serveStatic } from '../gateway/static.js';
import { formatEventFields } from '../log-event.js';
import { platformTokenMatches, platformUnauthorizedMessage, resolvePlatformAuth } from './auth.js';
import { platformListenGuard } from './listen-guard.js';
import { PlatformProxy } from './proxy.js';
import { PROXY_BASE_PATH, parseProxyRoute } from './proxy-config.js';
import type { ProxyWsClient } from './proxy-ws.js';
import { createPlatformRegistry } from './registry.js';
import { handlePlatformRpc } from './rpc.js';
import type {
  PlatformAuthOptions,
  PlatformGateway,
  PlatformGatewayOptions,
  WebAutoBuildState,
  WebDistProbe,
  WebDistProbeResult,
} from './types.js';

const PLATFORM_RPC_PATH = '/platform/rpc';
/** 0.57：静态构建戳 + 服务端现场判断（见 `buildJsonResponse`）。 */
const BUILD_JSON_PATH = '/build.json';
/** 0.57：产物变更推送（SSE）；`/build.json` 仍是唯一事实源。 */
const BUILD_EVENTS_PATH = '/web/build/events';
/** 长连接是资源：超过这个数直接 503，前端退回轮询。 */
const BUILD_EVENTS_MAX_CONNECTIONS = 32;
/** 判定节拍（与 probe 缓存 TTL 对齐：不存在更快的真相）。 */
const BUILD_EVENTS_TICK_MS = 5_000;
/** 每 N 个节拍发一帧注释保活（25s），防中间层掐断空闲连接。 */
const BUILD_EVENTS_PING_TICKS = 5;
/** 告诉浏览器断线后多久重连（毫秒）。 */
const BUILD_EVENTS_RETRY_MS = 5_000;
/** 现场判断要遍历源码树；多个标签页同时轮询不必各走一遍。 */
const BUILD_PROBE_TTL_MS = 5_000;

/**
 * 0.58：平台入口的 WS 连接数据。目前只有一种：node 事件流代理。
 *
 * Bun 的 `websocket` handler 需要单一 `data` 类型；用 `kind` 判别便于将来加第二条通道
 * （例如 hub 代理）时不用改类型。
 */
interface PlatformWsData {
  kind: 'node-proxy';
  bridge: import('./proxy-ws.js').ProxyWsBridge;
}

/** node 独占路径：平台入口一律 404（不代理、不转发）。 */
function isNodeOnlyPath(path: string): boolean {
  return (
    path === '/v1' ||
    path.startsWith('/v1/') ||
    path === '/plugins' ||
    path.startsWith('/plugins/') ||
    path === '/ws' ||
    path.startsWith('/ws/') ||
    path === '/sse' ||
    path.startsWith('/sse/')
  );
}

/**
 * 平台自己拥有的路径前缀：不参与 SPA 兜底。
 *
 * 0.58 修的是既有 bug：`/health` 曾经排在静态兜底之后，于是返回 `index.html`（200 HTML），
 * `gateway status` 因此对平台实例恒显示「身份未确认」。判据用前缀而不是逐个端点：
 * 兜底只该服务**前端路由**（`/sessions/xxx` 这种），任何平台路径拿到 HTML 都是错的。
 */
const RESERVED_PLATFORM_PREFIXES: readonly string[] = [
  '/platform/',
  `${PROXY_BASE_PATH}/`,
  '/auth/',
  '/web/',
  '/health',
  '/build.json',
];

function isReservedPlatformPath(path: string): boolean {
  return RESERVED_PLATFORM_PREFIXES.some((prefix) => {
    if (path === prefix) return true;
    return path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
  });
}

/**
 * 现场判断的缓存：TTL + 同一判定函数的并发请求共用一次遍历。
 *
 * 为什么缓存：`inspectWebDist` 会 stat 源码树里的每个文件（上限 5000），而
 * `/build.json` 是**每个标签页每 10 秒**拉一次的。5 秒 TTL 让一次重建之后
 * 的 `stale: false` 最迟 5 秒可见，同时把遍历频率压到与标签页数量无关。
 *
 * 判定失败 = 「未知」：返回 undefined，不缓存（下次重试）；调用方只省掉实时字段，
 * 静态构建戳照发 —— 前端按「无法判断」处理，不误报过期。
 */
function createWebDistProbeCache(): (
  probe: WebDistProbe,
) => Promise<WebDistProbeResult | undefined> {
  const cache = new WeakMap<WebDistProbe, { at: number; result: WebDistProbeResult }>();
  const inFlight = new WeakMap<WebDistProbe, Promise<WebDistProbeResult | undefined>>();
  return (probe) => {
    const cached = cache.get(probe);
    if (cached !== undefined && Date.now() - cached.at < BUILD_PROBE_TTL_MS) {
      return Promise.resolve(cached.result);
    }
    const pending = inFlight.get(probe);
    if (pending !== undefined) return pending;
    const task = (async (): Promise<WebDistProbeResult | undefined> => {
      try {
        const result = await probe();
        cache.set(probe, { at: Date.now(), result });
        return result;
      } catch {
        return undefined;
      } finally {
        inFlight.delete(probe);
      }
    })();
    inFlight.set(probe, task);
    return task;
  };
}

/**
 * `/build.json` 的响应体：磁盘上的构建戳**原样保留**，再叠加服务端现场判断的
 * `stale` / `newestSource` / `building`。
 *
 * 为什么必须现场算：产物过期（dist 比源码旧）时，浏览器里那份 bundle 与磁盘上的
 * `build.json` 来自**同一次构建**，前端比对 `builtAt` 永远一致 —— 只有服务端把
 * 「我知道 dist 落后于源码」说出来，顶部提示才可能响。
 *
 * `building`（0.58）：后台重建**此刻**是否在跑。少了这一项，提示条会在构建进行中
 * 让用户「刷新以加载新版本」—— 而刷新那一刻磁盘上还是旧产物，是句废话。
 *
 * 返回 null = 没有可用的构建戳（文件缺失 / 读坏 / JSON 非对象）：HTTP 端点交给静态
 * 兜底，保住旧行为；任何读盘失败都**不 500**（页面不能被一个诊断文件打挂）。
 */
async function buildJsonPayload(
  staticDir: string,
  probe: WebDistProbe | undefined,
  probeCached: (probe: WebDistProbe) => Promise<WebDistProbeResult | undefined>,
  buildInFlight: (() => boolean) | undefined,
  buildAuto: (() => WebAutoBuildState) | undefined,
): Promise<Record<string, unknown> | null> {
  let base: Record<string, unknown>;
  try {
    const file = Bun.file(resolve(staticDir, 'build.json'));
    if (!(await file.exists())) return null;
    const raw: unknown = await file.json();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    base = { ...(raw as Record<string, unknown>) };
  } catch {
    return null;
  }
  // 构建状态**不走缓存**：缓存里那份可能是构建开始前的快照，会让提示条在构建结束
  // 之后继续说「正在构建」。
  const building = buildInFlight?.() === true;
  const live = probe === undefined ? undefined : await probeCached(probe);
  const body: Record<string, unknown> = { ...base, building };
  // 0.59：`autobuild` 同理不进缓存 —— 三连失败之后必须**立刻**能说「不会再有动作了」。
  const auto = buildAuto?.();
  if (auto !== undefined) body.autobuild = auto;
  if (live !== undefined) {
    body.stale = live.stale;
    if (live.newestSource !== undefined) {
      body.newestSource = {
        path: live.newestSource.path,
        mtime: new Date(live.newestSource.mtimeMs).toISOString(),
      };
    }
  }
  return body;
}

/** `/build.json` 的 HTTP 响应（`no-store`；HEAD 只要头）。 */
async function buildJsonResponse(
  staticDir: string,
  method: string,
  probe: WebDistProbe | undefined,
  probeCached: (probe: WebDistProbe) => Promise<WebDistProbeResult | undefined>,
  buildInFlight: (() => boolean) | undefined,
  buildAuto: (() => WebAutoBuildState) | undefined,
): Promise<Response | null> {
  const body = await buildJsonPayload(staticDir, probe, probeCached, buildInFlight, buildAuto);
  if (body === null) return null;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json;charset=utf-8',
    // 这个文件就是用来感知变化的：命中缓存等于没查（静态兜底那条是 immutable 一年）。
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  // HEAD 只要头：Bun 不会替我们吞掉 body。
  if (method === 'HEAD') return new Response(null, { headers });
  return new Response(JSON.stringify(body, null, 2), { headers });
}

/**
 * 0.57：产物变更的**推送**通道（`GET /web/build/events`，SSE）。
 *
 * 为什么要有：轮询 `/build.json` 是「每个标签页每 10 秒一次」—— 一天 8,640 次请求、
 * 最多 10 秒的感知延迟，而且日志与唤醒都被这些空请求泡着。推送只保留一条空闲长
 * 连接，产物一变就是毫秒级送达；`/build.json` 仍是唯一事实源（这里推的就是它的
 * 同一份 payload），SSE 断了前端退回轮询，不会因为推送挂掉而瞎。
 *
 * 有界：最多 {@link BUILD_EVENTS_MAX_CONNECTIONS} 条长连接，超了直接 503 让调用方
 * 退回轮询；不接受请求体、不产生业务状态。判定由**一个**节拍器驱动（与 probe 缓存
 * TTL 对齐），所以连接数再多，遍历源码树的频率也不变。
 */
interface BuildEventStream {
  /** 打开一条流；超过上限返回 null（调用方回 503）。 */
  open(): Promise<Response | null>;
  /** 停服：断开全部连接并停掉节拍器。 */
  close(): void;
}

function createBuildEventStream(options: {
  staticDir: string;
  probe: WebDistProbe | undefined;
  probeCached: (probe: WebDistProbe) => Promise<WebDistProbeResult | undefined>;
  /** 后台重建是否在进行（见 `PlatformGatewayOptions.webBuildInFlight`）。 */
  buildInFlight: (() => boolean) | undefined;
  /** 0.59：运行期自动重建的现场状态（见 `PlatformGatewayOptions.webBuildAuto`）。 */
  buildAuto: (() => WebAutoBuildState) | undefined;
}): BuildEventStream {
  const encoder = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let ticker: ReturnType<typeof setInterval> | undefined;
  let lastBody: string | undefined;

  const write = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: string): void => {
    try {
      controller.enqueue(encoder.encode(chunk));
    } catch {
      // 客户端已经走了（反代断开 / 浏览器关闭）：悄悄摘掉，不抛给节拍器。
      clients.delete(controller);
    }
  };

  const broadcast = (chunk: string): void => {
    for (const controller of [...clients]) write(controller, chunk);
  };

  const bodyNow = async (): Promise<string | undefined> => {
    const payload = await buildJsonPayload(
      options.staticDir,
      options.probe,
      options.probeCached,
      options.buildInFlight,
      options.buildAuto,
    );
    return payload === null ? undefined : JSON.stringify(payload);
  };

  const startTicker = (): void => {
    if (ticker !== undefined) return;
    let ticks = 0;
    ticker = setInterval(() => {
      void (async () => {
        ticks += 1;
        // 保活：中间层（反代 / 浏览器）会把长时间没有字节的流掐掉，注释帧零语义。
        if (ticks % BUILD_EVENTS_PING_TICKS === 0) broadcast(': ping\n\n');
        if (clients.size === 0) {
          // 没人听了就停表：空转的遍历没有意义，下一条连接会重新拉起。
          if (ticker !== undefined) {
            clearInterval(ticker);
            ticker = undefined;
          }
          return;
        }
        const body = await bodyNow();
        if (body === undefined || body === lastBody) return;
        lastBody = body;
        broadcast(`data: ${body}\n\n`);
      })();
    }, BUILD_EVENTS_TICK_MS);
    ticker.unref?.();
  };

  return {
    async open(): Promise<Response | null> {
      if (clients.size >= BUILD_EVENTS_MAX_CONNECTIONS) return null;
      const initial = await bodyNow();
      let self: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          self = controller;
          clients.add(controller);
          startTicker();
          // 首帧立刻给：连上就有当前真相，不必等下一次变化。
          write(controller, `retry: ${BUILD_EVENTS_RETRY_MS}\n\n`);
          if (initial !== undefined) {
            // 只记第一次：别让后连上的客户端把它「回拨」成旧快照，否则同一份
            // 内容会被重复推给所有人。
            if (lastBody === undefined) lastBody = initial;
            write(controller, `data: ${initial}\n\n`);
          }
        },
        cancel: () => {
          // 客户端断开（浏览器关闭 / 反代断流）：只摘掉自己，不惊动其它连接。
          if (self !== undefined) clients.delete(self);
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          Connection: 'keep-alive',
          // nginx 默认会缓冲上游响应：SSE 必须显式关掉，否则事件攒到连接结束才到。
          'X-Accel-Buffering': 'no',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    },
    close(): void {
      if (ticker !== undefined) {
        clearInterval(ticker);
        ticker = undefined;
      }
      for (const controller of [...clients]) {
        try {
          controller.close();
        } catch {
          // 已经关掉的就不用再关。
        }
      }
      clients.clear();
    },
  };
}

/**
 * 0.55 P0：401 文案必须能直接照做 —— 分清「缺反代密钥」与「缺平台 token」。
 * 仍然只用 CONTRACT §7 的 `platform_unauthorized` 错误码（Web 端据此弹「需要 token」）。
 * 0.55 拍板项 2：文案与 `rpc.ts` 的凭据端点共用（见 `auth.ts`），避免两处口径漂移。
 */
function json(data: unknown, status: number, extra: Record<string, string>): Response {
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

function errorJson(
  code: string,
  message: string,
  status: number,
  extra: Record<string, string>,
): Response {
  return json({ error: { code, message } }, status, extra);
}

/** 0.56：没有任何 auth 配置时的等价物 —— 空后端 = 行为退回 0.55。 */
const DISABLED_AUTH: PlatformAuthOptions = {
  publicOrigin: null,
  publicOrigins: [],
  allowedHosts: [],
  backends: [],
  session: { idleMinutes: 30, absoluteHours: 12 },
};

/** 配置了登录后端、但请求来自公网（或经反代）且没有会话。 */
function sessionRequiredMessage(): string {
  return (
    'session_required: 这个部署启用了 WebUI 登录（auth.backends），经公网/反代的请求必须' +
    '先登录。请打开站点根路径，用登录页（口令 + TOTP，或 GitHub）获取会话 cookie 后再调用；' +
    '本机直连（127.0.0.1）仍可用 Bearer token 或回环匿名。'
  );
}

/** 会话 cookie 在，但缺少或错误的 CSRF 同步令牌。 */
function csrfRejectedMessage(reason: 'csrf_missing' | 'csrf_failed'): string {
  return (
    (reason === 'csrf_missing' ? 'csrf_missing' : 'csrf_failed') +
    ': 变更类请求必须带 X-Vessel-CSRF 头（值取自 GET /auth/status 的 csrfToken）。' +
    '缺它或值不匹配都会被拒 —— 这是防 CSRF 的同步令牌，不是登录凭据。'
  );
}

/**
 * 校验单个 `auth.public_origin` / `auth.public_origins[i]`：只接受
 * `scheme://host[:port]`，不接受路径/查询/凭据。
 *
 * 来源是 `redirect_uri` 的**唯一**来源（不许从请求头推导），配错就是登录后 404，
 * 所以在启动时 fail-fast，而不是等用户点登录才发现。
 */
function normalizePublicOrigin(
  raw: string | null | undefined,
  label = 'auth.publicOrigin',
): string | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${label} "${trimmed}" is not an absolute URL (expected https://host).`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${label} "${trimmed}" must be http(s).`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${label} "${trimmed}" must not carry credentials.`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`${label} "${trimmed}" must be scheme://host[:port] only.`);
  }
  return url.origin;
}

/**
 * 0.60：合并 `auth.public_origins`（并列白名单）与 `auth.public_origin`（单来源，兼容）。
 *
 * 顺序稳定（`public_origin` 在前、列表按配置顺序跟上）并去重。两条同时出现不是错误：
 * `public_origin` 的语义就是「只有一个元素的 `public_origins`」，合并只是把这句话写实。
 */
export function resolvePlatformPublicOrigins(input: {
  publicOrigin?: string | null | undefined;
  publicOrigins?: readonly string[] | undefined;
}): string[] {
  const merged: string[] = [];
  const push = (origin: string | null): void => {
    if (origin === null || merged.includes(origin)) return;
    merged.push(origin);
  };
  push(normalizePublicOrigin(input.publicOrigin));
  const list = input.publicOrigins ?? [];
  list.forEach((entry, index) => {
    push(normalizePublicOrigin(entry, `auth.publicOrigins[${String(index)}]`));
  });
  return merged;
}

/**
 * 启动平台监听。`staticDir/index.html` 缺失时 fail-fast（P10），错误信息带解析后路径。
 */
export function startPlatformGateway(opts: PlatformGatewayOptions): PlatformGateway {
  // 0.55 P0：fail-closed。非回环监听 + 没有 platform token ⇒ 拒绝启动（不是警告）。
  const listenGuard = platformListenGuard({
    hostname: opts.hostname,
    port: opts.port,
    platformToken: opts.platformToken,
  });
  if (listenGuard !== null) throw new Error(listenGuard);

  const staticDir = resolve(opts.staticDir);
  const indexFile = resolve(staticDir, 'index.html');
  if (!existsSync(indexFile)) {
    throw new Error(
      `Platform gateway requires a built web UI: missing ${indexFile}. ` +
        'Build apps/web (npm run build) before starting the gateway.',
    );
  }

  const allowedOrigins = normalizeAllowedOrigins(opts.allowedOrigins);
  const nodeOrigins = normalizeAllowedOrigins(opts.nodeOrigins);
  const hubOrigins = normalizeAllowedOrigins(opts.hubOrigins);
  const registry = createPlatformRegistry(opts.nodes);
  const version = opts.version ?? 'unknown';
  const platformToken = opts.platformToken;
  const proxySecret = opts.proxySecret;

  // 0.56 登录基座。未配置 auth.backends 时后端列表为空 ⇒ AuthService 报
  // `enabled === false`，不拦任何人，行为与 0.55 逐字一致（不锁死回环）。
  const authOptions: PlatformAuthOptions = { ...DISABLED_AUTH, ...opts.auth };
  // 0.60：来源白名单（`public_origins` 并列 + `public_origin` 单来源，合并去重）。
  // 一个来源都没有 ⇒ 空列表 ⇒ 公网/Host 白名单不启用（与今天逐字一致）。
  const publicOrigins = resolvePlatformPublicOrigins(authOptions);
  const publicHosts = [...new Set(publicOrigins.map((origin) => new URL(origin).host))];
  // 公网 origin 同时是合法 CORS Origin：反代后面板仍是同源页面，但 Origin 头会
  // 是公网域名；把它们并入 allowlist 才能过 Origin 闸、拿到正确的 CORS 头，
  // 并让 CSP 的 `connect-src` 里出现每个来源的 `ws(s)://`。
  const httpAllowedOrigins =
    publicOrigins.length === 0
      ? allowedOrigins
      : normalizeAllowedOrigins([...allowedOrigins, ...publicOrigins]);
  const authService = new AuthService({
    ...authOptions,
    publicOrigin: publicOrigins[0] ?? null,
    publicOrigins,
    env: authOptions.env ?? (process.env as Record<string, string | undefined>),
    // 0.56 P2：`POST /auth/unlock` 要比对这个值（本机 + 平台 token 才能解锁登录限速）。
    // 只比较、不回显、不落盘。
    ...(platformToken !== undefined ? { platformToken } : {}),
    log: (message: string) => {
      // 只打非敏感事实：会话 id / csrf / token / secret / 口令 / TOTP 密钥 / 恢复码都不进这行。
      console.warn(`[platform-auth] ${message}`);
    },
  });
  const authCleanupTimer = setInterval(() => authService.cleanup(), 60_000);
  authCleanupTimer.unref?.();

  // 0.57：`/build.json` 的现场判断缓存（每个 server 一份，判定函数由组合根注入）。
  const probeWebDist = createWebDistProbeCache();
  // 0.58：`building` 的来源。**不进上面那份缓存**：构建一结束就必须说「结束了」。
  const buildInFlight = opts.webBuildInFlight;
  // 0.59：`autobuild`（运行期还会不会自己重建）同样不进缓存：三连失败要立刻可见。
  const buildAuto = opts.webBuildAuto;
  // 0.57：产物变更推送（SSE）。`/build.json` 仍是唯一事实源，这里只是加速通道。
  const buildEvents = createBuildEventStream({
    staticDir,
    probe: opts.webDist,
    probeCached: probeWebDist,
    buildInFlight,
    buildAuto,
  });

  /**
   * 0.58：代理门面。省略 `opts.proxy` = 关闭（组合根没接线时行为与 0.57 逐字一致）。
   *
   * 目标地址只从 `registry` 取（节点表的唯一真相源），凭据只从
   * `opts.resolveNodeCredential` 取（不缓存、不落盘、不进响应体）。
   */
  const proxy = new PlatformProxy({
    enabled: opts.proxy !== undefined && opts.proxy.enabled !== false,
    resolveNode: (nodeId) => registry.descriptor(nodeId),
    resolveToken: (nodeId) => {
      try {
        // 0.58：`resolveNodeCredential` 从此是**内部**函数：只被代理层调用。
        const credential = opts.resolveNodeCredential(nodeId);
        return credential.found ? credential.token : undefined;
      } catch {
        // 读不到凭据 = 该 node 走回环匿名；不把底层错误带进响应。
        return undefined;
      }
    },
    ...(opts.proxy?.limits !== undefined ? { limits: opts.proxy.limits } : {}),
    log: (fields) => {
      // 与 node 侧 `gateway.ws.closed` 同通道（单行 key=value，便于 grep/聚合）。
      console.warn(formatEventFields(fields));
    },
  });

  /**
   * 0.58 崩溃排查：**周期性资源采样**（`VESSEL_RESOURCE_SAMPLE_MS`，缺省 60000；0 = 关）。
   *
   * 为什么必须加：0.54 那次 `panic(main thread): Segmentation fault` 之后，能拿到的只有
   * Bun 自己的死后读数（RSS/Peak/Commit/Faults），**崩之前一条都没有** —— 于是「是持续
   * 泄漏还是瞬时踩空」这个问题永远答不了。一行 60 秒的成本可以忽略，缺的是有人记。
   *
   * 字段刻意选「一眼能判断形状」的那几个：
   * - `rss` / `heap`：持续单向上升 = 泄漏；窄带抖动 = 正常；
   * - `ws_active` / `ws_pending`：WS 桥的连接数与待发字节（背压是否在涨）；
   * - `http_inflight` / `passthrough`：代理 HTTP 的并发与本次加固后新增的直通计数；
   * - `mode`：代理流式转发实现（`pump` / `passthrough`）——下次崩了先看这一项，
   *   因为 `pump` 在本机（win32）有可复现的段错误（见 `proxy.ts#httpStreamMode`）。
   *
   * 这里**不报** crc32 实现：本进程（平台网关）不写时间线，把 core 拉进来只为打一行诊断
   * 不值得；时间线那条 crc32 的实况由 `scripts/crash-hunt/stress-a-blocks.ts` 的读数给出。
   */
  const resourceSampleMs = Number(process.env.VESSEL_RESOURCE_SAMPLE_MS ?? 60_000);
  if (Number.isFinite(resourceSampleMs) && resourceSampleMs > 0) {
    const resourceTimer = setInterval(() => {
      const usage = process.memoryUsage();
      const proxyStats = proxy.stats();
      console.warn(
        formatEventFields({
          event: 'gateway.resources',
          uptime_s: Math.round(process.uptime()),
          rss_mb: Math.round(usage.rss / 1048576),
          heap_mb: Math.round(usage.heapUsed / 1048576),
          http_requests: proxyStats.http_requests,
          http_failures: proxyStats.http_failures,
          http_inflight: proxyStats.http_inflight,
          passthrough: proxyStats.http_passthrough_streams,
          mode: proxyStats.http_stream_mode,
          ws_active: proxyStats.ws_active,
          ws_pending: proxyStats.ws_pending_bytes,
        }),
      );
    }, resourceSampleMs);
    resourceTimer.unref?.();
  }

  /**
   * 平台数据面闸（`/platform/rpc` 与 `/nodes/**` 的**同一套**权威判定）。
   *
   * 抽出来不是为了少写几行：两处一旦各写一套，代理就会成为「比 RPC 更松的那个入口」——
   * 那正是「不能变成新的穿通面」要防的事。
   */
  type DataGate = { ok: true } | { ok: false; response: Response };
  const dataGate = (
    req: Request,
    authCtx: AuthRequestContext,
    auth: ReturnType<typeof resolvePlatformAuth>,
    options: { mutating: boolean; localDirect: boolean },
    extra: Record<string, string>,
  ): DataGate => {
    // 1. Bearer token 成立 → 放行（令牌优先，不需要 CSRF）。
    if (auth.ok) return { ok: true };
    const gate = authService.authorize(req, authCtx, { mutating: options.mutating });
    // 2. 会话 cookie 在但 CSRF 缺失 / 不匹配 → 403（cookie 不是能力凭证）。
    if (!gate.ok && (gate.reason === 'csrf_missing' || gate.reason === 'csrf_failed')) {
      return {
        ok: false,
        response: errorJson('csrf_failed', csrfRejectedMessage(gate.reason), 403, extra),
      };
    }
    // 3. 配了登录后端且不是本机直连（公网/经反代）→ 401，让前端回登录页。
    if (!gate.ok && authService.enabled && !options.localDirect) {
      return {
        ok: false,
        response: errorJson('session_required', sessionRequiredMessage(), 401, extra),
      };
    }
    // 4. 非回环且未认证 → 401（旧行为）。
    if (!gate.ok && !auth.loopback) {
      return {
        ok: false,
        response: errorJson('platform_unauthorized', platformUnauthorizedMessage(auth), 401, extra),
      };
    }
    // 5. 本机直连（未配 token 的回环）→ 匿名放行（旧行为，防锁死）。
    return { ok: true };
  };

  /**
   * WS 首帧里的 token 校验：浏览器 WS 带不了 `Authorization` 头，所以平台 token
   * 允许走首帧（与 node 的 `{kind:'auth'}` 同形状）。**校验的是平台 token**，
   * 平台 token 永远不会被转发给 node。
   */
  const verifyPlatformToken = (provided: string): boolean => {
    if (platformToken === undefined || platformToken === '') {
      // 未配置平台 token：这条连接本来只可能是回环匿名（闸已放行）。
      return provided === '';
    }
    return provided !== '' && platformTokenMatches(provided, platformToken);
  };

  const server = Bun.serve<PlatformWsData>({
    port: opts.port,
    hostname: opts.hostname,
    // 0.57：SSE 是长连接，Bun 默认 10 秒空闲就掐掉（只发保活帧也会被掐）。与
    // node 侧 `/v1/events` / hub 同口径关掉空闲超时（`gateway.ts` 的 `idleTimeout: 0`），
    // 连接的生命周期交给 SSE 自己的保活帧与客户端重连。
    idleTimeout: 0,
    // 0.58：代理 WS 的**唯一**入口。心跳、背压、close 记账都在 `ProxyWsBridge`，
    // 这里只做分发（不在 handler 里加任何策略，避免两处判据漂移）。
    websocket: {
      data: {} as PlatformWsData,
      open(ws: Bun.ServerWebSocket<PlatformWsData>) {
        const { bridge } = ws.data;
        proxy.wsOpen(bridge, ws as unknown as ProxyWsClient);
      },
      message(ws: Bun.ServerWebSocket<PlatformWsData>, message: string | Buffer) {
        proxy.wsMessage(ws.data.bridge, message);
      },
      close(ws: Bun.ServerWebSocket<PlatformWsData>, code: number, reason: string) {
        proxy.wsClose(ws.data.bridge, code, reason);
      },
      pong(ws: Bun.ServerWebSocket<PlatformWsData>) {
        proxy.wsPong(ws.data.bridge);
      },
    },
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const address = srv.requestIP(req)?.address ?? null;

      // 0.56：先解析「受信边缘」。反代头（Host / X-Forwarded-Proto）只有在本请求
      // 来自受信代理时才被采信；否则一律用请求自身，伪造 Host 拿不到公网身份。
      const edge = resolveRequestEdge(req, {
        address,
        proxySecret,
        ...(authOptions.trustedProxies !== undefined
          ? { trustedProxies: authOptions.trustedProxies }
          : {}),
      });
      const extra = corsHeaders(req, httpAllowedOrigins);

      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: { Allow: 'GET, POST, OPTIONS', ...extra },
        });
      }

      // 平台侧错误码只用 CONTRACT §7 表内项：Host/Origin 拒绝统一为 `forbidden`。
      if (
        !hostAllowed(req, {
          listenHost: opts.hostname,
          publicHosts,
          additionalHosts: authOptions.allowedHosts,
          edge,
        })
      ) {
        return errorJson('forbidden', 'Host header is not allowed', 403, extra);
      }
      if (!originAllowed(req, httpAllowedOrigins)) {
        return errorJson('forbidden', 'Origin is not allowed', 403, extra);
      }

      const authCtx: AuthRequestContext = { edge, address };

      // 0.56：登录端点（/auth/*）**在**鉴权闸之前。配了 token 的部署里，
      // 浏览器必须能先打开登录页、走 OAuth 回来，才谈得上带 cookie 调 RPC。
      const authRoute = await authService.handle(req, url, authCtx);
      if (authRoute !== null) return authRoute;

      const auth = resolvePlatformAuth({
        req,
        address,
        platformToken,
        // 0.56：派生值不算「配置」——回环匿名必须保持（迁移安全）。
        explicitPlatformToken: opts.platformTokenConfigured ?? true,
        ...(proxySecret !== undefined ? { proxySecret } : {}),
      });

      if (isNodeOnlyPath(path)) {
        return errorJson('not_found', `Not found: ${path}`, 404, extra);
      }

      // ---- 精确端点（全部在静态兜底之前；顺序判据：精确端点 → 明确 404 → SPA 兜底）----

      // 0.55 口径不变：health 不放公网（回环或已认证才可读）。
      // 0.58 修 bug：这一块原本排在静态兜底之后，于是 `/health` 被 SPA 回退成
      // `index.html`（200 HTML），`gateway status` 对平台实例因此恒显示 unreachable。
      if (path === '/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return errorJson('not_found', `Not found: ${path}`, 404, extra);
        }
        if (!auth.loopback && !auth.ok) {
          return errorJson('platform_unauthorized', platformUnauthorizedMessage(auth), 401, extra);
        }
        // 平台健康：不含 node runtime 数据；`role` 供 CLI 确定性区分平台/node health。
        // `proxy` 是能力位（前端据此选择数据面），不含地址与凭据。
        return json(
          {
            status: 'ok',
            role: 'platform',
            version,
            proxy: { enabled: proxy.enabled, base_path: PROXY_BASE_PATH },
          },
          200,
          extra,
        );
      }

      // 0.57：`/build.json` 是**实时**响应（静态构建戳 + 服务端现场判断），必须自己
      // 处理：交给 serveStatic 会带着 `immutable` 一年缓存头原样吐出去。
      if (path === BUILD_JSON_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
        const buildResponse = await buildJsonResponse(
          staticDir,
          req.method,
          opts.webDist,
          probeWebDist,
          buildInFlight,
          buildAuto,
        );
        if (buildResponse !== null) {
          for (const [key, value] of Object.entries(extra)) {
            buildResponse.headers.set(key, value);
          }
          return buildResponse;
        }
      }

      // 0.57：产物变更推送。**必须在静态兜底之前** —— 它没有扩展名，serveStatic
      // 会把它当成 SPA 路由、返回 index.html。
      //
      // 鉴权：EventSource 带不了 Authorization 头，所以走**会话 cookie**（浏览器
      // 同源自动带上）或回环/Bearer。token 绝不进 URL（会落进反代与浏览器历史）。
      // 没配登录后端的部署（`authEnabled:false`）与 `/build.json` 保持同等开放：
      // 静态站点本身就是匿名可读的，这里没有比对静态文件更多的信息。
      if (path === BUILD_EVENTS_PATH) {
        if (req.method !== 'GET') {
          return errorJson('method_not_allowed', 'Only GET is allowed', 405, {
            ...extra,
            Allow: 'GET',
          });
        }
        const streamAllowed =
          !authService.enabled ||
          auth.loopback ||
          auth.ok ||
          authService.authorize(req, authCtx, { mutating: false }).ok;
        if (!streamAllowed) {
          return errorJson('platform_unauthorized', platformUnauthorizedMessage(auth), 401, extra);
        }
        const stream = await buildEvents.open();
        if (stream === null) {
          // 有界：长连接满了就让它退回轮询（前端按「推送不可用」处理）。
          return errorJson(
            'unavailable',
            `Too many build event streams (max ${BUILD_EVENTS_MAX_CONNECTIONS}); poll /build.json instead.`,
            503,
            { ...extra, 'Retry-After': '30' },
          );
        }
        for (const [key, value] of Object.entries(extra)) stream.headers.set(key, value);
        return stream;
      }

      if (path === PLATFORM_RPC_PATH) {
        if (req.method !== 'POST') {
          return errorJson('method_not_allowed', 'Only POST is allowed', 405, {
            ...extra,
            Allow: 'POST',
          });
        }
        // 鉴权矩阵见 `dataGate`（与 `/nodes/**` 共用同一套：代理不许比 RPC 更松）。
        const rpcGate = dataGate(
          req,
          authCtx,
          auth,
          { mutating: true, localDirect: edge.localDirect },
          extra,
        );
        if (!rpcGate.ok) return rpcGate.response;
        return handlePlatformRpc(
          req,
          {
            auth,
            registry,
            resolveNodeCredential: opts.resolveNodeCredential,
            version,
            proxy: { enabled: proxy.enabled, basePath: PROXY_BASE_PATH },
          },
          extra,
        );
      }

      // ---- 0.58：`/nodes/:nodeId/**` 代理（HTTP + WS 升级）----
      //
      // 目标只来自注册表；客户端只提供 node_id。鉴权走**平台会话语义**
      // （Bearer / 会话 cookie / 回环匿名），node token 永不出网关。
      if (path === PROXY_BASE_PATH || path.startsWith(`${PROXY_BASE_PATH}/`)) {
        const route = parseProxyRoute(path);
        if (route === null) {
          // 形状不对（含 `..` / `//host` / 非法 id）：明确 404，不回落成 SPA。
          return errorJson('not_found', `Not found: ${path}`, 404, extra);
        }
        if (!proxy.enabled) {
          return errorJson(
            'proxy_disabled',
            'proxy_disabled: 这个部署关闭了 gateway.proxy_nodes（浏览器应直连 node）。',
            404,
            extra,
          );
        }
        const isUpgrade = (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';
        // WS 升级不是变更类请求（握手时浏览器带不了 CSRF 头，带的是 cookie）。
        const proxyGate = dataGate(
          req,
          authCtx,
          auth,
          { mutating: false, localDirect: edge.localDirect },
          extra,
        );
        if (!isUpgrade && !proxyGate.ok) return proxyGate.response;
        if (isUpgrade) {
          if (req.method !== 'GET') {
            return errorJson('method_not_allowed', 'WebSocket upgrade must be GET', 405, {
              ...extra,
              Allow: 'GET',
            });
          }
          // 没有 cookie 也能升级的**唯一**情形：这个部署配了平台 token。
          //
          // 为什么必须留这条路：浏览器 WS 握手带不了 `Authorization` 头。远端用户
          // （没有 OAuth 会话、只有 `gateway.token`）在代理模式下全靠首帧
          // `{kind:'auth',token}` 证明身份 —— 直接 401 的话「HTTP 能用、WS 连不上」。
          // 代价有界：连接仍受 wsMaxConnections 限制，且首帧鉴权窗口 wsHandshakeTimeoutMs
          // （10s）内不通过就 4401 关闭。
          const deferredAuth = typeof platformToken === 'string' && platformToken !== '';
          if (!proxyGate.ok && !deferredAuth) return proxyGate.response;
          const upgrade = proxy.upgrade(route, url, {
            // 已在升级时通过平台鉴权（Bearer / 会话 cookie / 回环）⇒ 不必等首帧 token。
            preAuthenticated: proxyGate.ok,
            verifyPlatformToken,
          });
          if (!upgrade.ok) {
            for (const [key, value] of Object.entries(extra)) {
              upgrade.response.headers.set(key, value);
            }
            return upgrade.response;
          }
          const upgraded = srv.upgrade(req, {
            data: { kind: 'node-proxy' as const, bridge: upgrade.bridge },
          });
          if (!upgraded) {
            upgrade.bridge.failUpstream('upgrade_failed');
            return errorJson('invalid_request', 'WebSocket upgrade failed', 400, extra);
          }
          return undefined;
        }
        const proxied = await proxy.handleHttp(req, route, url);
        for (const [key, value] of Object.entries(extra)) proxied.headers.set(key, value);
        return proxied;
      }

      // 平台自有路径（`/auth/**`、`/web/**` 等）没命中精确端点 ⇒ 明确 404，
      // 绝不让 SPA 兜底把它们变成 index.html（那会让「路由写错」看起来像「页面正常」）。
      if (isReservedPlatformPath(path)) {
        return errorJson('not_found', `Not found: ${path}`, 404, extra);
      }

      // ---- 静态宿主（SPA 兜底）----
      // 静态宿主在闸之前：`index.html` 与 `/login` 是登录页本身，匿名也要拿得到
      // （否则「配了 token」⇒ 浏览器永远停在白屏）。数据面仍然要靠 RPC/代理鉴权。
      if (req.method === 'GET' || req.method === 'HEAD') {
        const staticResponse = await serveStatic(path, staticDir);
        if (staticResponse !== null) {
          const contentType = staticResponse.headers.get('content-type') ?? '';
          if (contentType.includes('text/html')) {
            staticResponse.headers.set(
              'Content-Security-Policy',
              buildContentSecurityPolicy(
                req,
                httpAllowedOrigins,
                {
                  frameSrc: nodeOrigins,
                  connectSrc: [...nodeOrigins, ...hubOrigins],
                },
                { host: edge.host, protocol: edge.protocol },
              ),
            );
          }
          for (const [key, value] of Object.entries(extra)) {
            staticResponse.headers.set(key, value);
          }
          return staticResponse;
        }
      }

      return errorJson('not_found', `Not found: ${path}`, 404, extra);
    },
  });

  return {
    // Bun 对 unix socket 返回 undefined；平台只走 TCP，回退到请求端口。
    port: server.port ?? opts.port,
    async stop(): Promise<void> {
      // 先断开 SSE 长连接：`server.stop(true)` 会等活跃连接，长连接不关就等不完。
      buildEvents.close();
      // 0.58：代理 WS 同理 —— 不让一条事件流把停服卡死；关闭时按 `who: 'platform'` 记账。
      proxy.closeAll();
      clearInterval(authCleanupTimer);
      await authService.flush();
      await server.stop(true);
    },
  };
}
