/**
 * `bun run dev:web`：Web 开发回路的一条命令入口（DX1/DX2，PLAN-0.18-dev-dx）。
 *
 * 1. 确保 gateway 在配置端口可用（复用外部进程，或 daemon 启动并记录 ownership）；
 * 2. 起一个只绑 127.0.0.1 的 dev relay：REST 注入 Authorization、WS 首帧替换 token；
 * 3. 起 Vite（5173），通过环境变量把 relay 地址 / secret 交给 Vite，token 不进入 Vite；
 * 4. Ctrl+C / SIGTERM / Vite 退出时幂等清理，只停本脚本启动的 gateway。
 *
 * 安全边界：token 只存在于本进程与 relay 内存；不打印、不写文件、不进 Vite env。
 *
 * @module vessel/scripts/dev-web
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_SERVE_OPTIONS, loadConfig } from '../packages/config/src/index';
import { resolveDataDir } from '../src/data-paths';
import { gatewayLogPath, startGatewayDaemon, tailLog } from '../src/gateway/daemon';
import { type GatewayPidRecord, isProcessAlive, readGatewayPidRecord } from '../src/gateway/pid';
import { resolveGatewayToken } from '../src/transport-factory';
import { DEV_RELAY_HEADER, injectTokenIntoAuthFrame, isAllowedDevOrigin } from './dev-web-lib';

/** relay 收尾时最多缓存的帧数（浏览器在 upstream open 前的首帧） */
const MAX_PENDING_FRAMES = 256;
/** 健康检查轮询间隔 */
const HEALTH_POLL_MS = 100;
/** 健康检查上限（启动后 / 复用时） */
const HEALTH_TIMEOUT_MS = 5_000;
/** Vite 固定端口（`--strictPort`，冲突时直接失败） */
const VITE_PORT = 5173;

/** 逐跳头：转发前移除，避免连接语义串线 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

interface RelaySocketData {
  /** 浏览器 WS URL 里的 since（为空表示从 0 开始） */
  since: string | null;
  upstream: WebSocket | null;
  upstreamOpen: boolean;
  pending: Array<string | Uint8Array>;
  closing: boolean;
}

interface RelayServer {
  url: string;
  stop: () => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** gateway 的 `/health`（公开，但受 Host/Origin 校验；不带 Origin 即可） */
async function probeHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown };
    return body.status === 'ok';
  } catch {
    return false;
  }
}

/** 有界轮询（不 shell sleep）；返回 false 表示超时 */
async function waitForHealth(port: number, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probeHealth(port)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(HEALTH_POLL_MS, remaining));
  }
}

/** 仅 `/v1/**` 与 `/health` 允许经 relay 访问 gateway */
function isGatewayPath(pathname: string): boolean {
  return pathname === '/v1' || pathname.startsWith('/v1/') || pathname === '/health';
}

function sinceQuery(since: string | null): string {
  return since !== null && /^\d+$/.test(since) ? `?since=${since}` : '';
}

function sendFrame(
  target: { send(data: string | Uint8Array | ArrayBuffer): unknown },
  data: unknown,
): void {
  if (typeof data === 'string') {
    target.send(data);
  } else if (data instanceof ArrayBuffer) {
    target.send(data);
  } else if (ArrayBuffer.isView(data)) {
    target.send(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
}

/** 转发 close 码；1005/1006/1015 不允许出现在 close() 参数里 */
function closeFrame(
  target: { close(code?: number, reason?: string): void },
  code: number,
  reason: string,
): void {
  try {
    if (code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 && code !== 1015) {
      target.close(code, reason);
    } else {
      target.close();
    }
  } catch {
    try {
      target.close();
    } catch {
      // 对端已关闭
    }
  }
}

/** REST/SSE 转发：删客户端 Origin/Host/hop-by-hop，覆盖 Authorization，流式回传响应 */
async function proxyHttp(
  request: Request,
  url: URL,
  gatewayOrigin: string,
  token: string | undefined,
): Promise<Response> {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (
      lower === 'origin' ||
      lower === 'host' ||
      lower === 'authorization' ||
      lower === DEV_RELAY_HEADER ||
      HOP_BY_HOP_HEADERS.has(lower)
    ) {
      continue;
    }
    headers.set(name, value);
  }
  if (token !== undefined && token !== '') headers.set('authorization', `Bearer ${token}`);

  const init: RequestInit = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

  let upstream: Response;
  try {
    upstream = await fetch(`${gatewayOrigin}${url.pathname}${url.search}`, init);
  } catch {
    return new Response('dev relay: gateway unreachable\n', { status: 502 });
  }

  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/**
 * 仅回环的 dev relay。
 * - HTTP/SSE：`/v1/**`、`/health` → gateway，注入真实 token；
 * - WS：`/v1/events`、`/ws` → gateway `/v1/events`，首帧 auth 只替换 token；
 * - 所有请求必须带随机 secret 头，否则 401（浏览器无法直接访问 relay）。
 */
function startRelay(options: {
  gatewayPort: number;
  token: string | undefined;
  secret: string;
}): RelayServer {
  const gatewayOrigin = `http://127.0.0.1:${options.gatewayPort}`;
  const gatewayWsUrl = `ws://127.0.0.1:${options.gatewayPort}/v1/events`;
  const authToken = options.token ?? '';

  const server = Bun.serve<RelaySocketData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, bunServer) {
      if (request.headers.get(DEV_RELAY_HEADER) !== options.secret) {
        return new Response('dev relay: unauthorized\n', { status: 401 });
      }
      // 只允许 Vite 页面（或非浏览器客户端）使用代理；任意网页不得借用 token。
      if (!isAllowedDevOrigin(request.headers.get('origin'))) {
        return new Response('dev relay: forbidden origin\n', { status: 403 });
      }
      const url = new URL(request.url);

      if (url.pathname === '/v1/events' || url.pathname === '/ws') {
        if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
          return new Response('dev relay: websocket upgrade required\n', { status: 400 });
        }
        const data: RelaySocketData = {
          since: url.searchParams.get('since'),
          upstream: null,
          upstreamOpen: false,
          pending: [],
          closing: false,
        };
        if (bunServer.upgrade(request, { data })) return undefined;
        return new Response('dev relay: websocket upgrade failed\n', { status: 400 });
      }

      if (!isGatewayPath(url.pathname)) {
        return new Response('dev relay: not found\n', { status: 404 });
      }
      return proxyHttp(request, url, gatewayOrigin, options.token);
    },
    websocket: {
      open(ws) {
        const data = ws.data;
        const upstream = new WebSocket(`${gatewayWsUrl}${sinceQuery(data.since)}`);
        data.upstream = upstream;

        upstream.addEventListener('open', () => {
          data.upstreamOpen = true;
          const pending = data.pending;
          data.pending = [];
          for (const frame of pending) sendFrame(upstream, frame);
        });
        upstream.addEventListener('message', (event) => {
          if (ws.readyState === WebSocket.OPEN) sendFrame(ws, event.data);
        });
        upstream.addEventListener('close', (event) => {
          data.upstreamOpen = false;
          if (data.closing) return;
          data.closing = true;
          closeFrame(ws, event.code, event.reason);
        });
        upstream.addEventListener('error', () => {
          if (data.closing) return;
          data.closing = true;
          closeFrame(ws, 1011, 'relay upstream error');
        });
      },
      message(ws, message) {
        const data = ws.data;
        // 只对文本 auth 帧做替换；其余帧（req/pong/二进制）逐字节透传。
        const frame =
          typeof message === 'string' ? injectTokenIntoAuthFrame(message, authToken) : message;
        if (data.upstreamOpen && data.upstream) {
          sendFrame(data.upstream, frame);
        } else if (data.pending.length < MAX_PENDING_FRAMES) {
          data.pending.push(frame);
        }
      },
      close(ws, code, reason) {
        ws.data.closing = true;
        const upstream = ws.data.upstream;
        if (upstream) closeFrame(upstream, code, reason);
      },
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

/** 读 PID 记录并按实际端口探活；用于“外部已在运行”的快路径 */
async function runningGateway(
  dataDir: string,
  configPort: number,
): Promise<{ record: GatewayPidRecord; port: number } | null> {
  const record = await readGatewayPidRecord(dataDir);
  if (!record || !isProcessAlive(record.pid)) return null;
  const port = record.port > 0 ? record.port : configPort;
  if (port <= 0) return null;
  return (await waitForHealth(port)) ? { record, port } : null;
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, '..');
  const loaded = await loadConfig();
  const config = loaded.config;
  const dataDir = resolveDataDir(config);
  const configPort = config.serve?.port ?? DEFAULT_SERVE_OPTIONS.port;
  const host = config.serve?.hostname ?? DEFAULT_SERVE_OPTIONS.hostname;

  const devToken = process.env.VESSEL_DEV_TOKEN?.trim();
  const token =
    devToken !== undefined && devToken !== '' ? devToken : resolveGatewayToken(config, process.env);

  let relay: RelayServer | undefined;
  let viteChild: ReturnType<typeof Bun.spawn> | undefined;
  let ownedPid: number | undefined;
  let cleanupPromise: Promise<never> | undefined;

  const cleanup = (code: number): Promise<never> => {
    cleanupPromise ??= (async () => {
      const child = viteChild;
      viteChild = undefined;
      if (child) {
        try {
          child.kill();
        } catch {
          // 已退出
        }
      }
      if (relay) {
        const server = relay;
        relay = undefined;
        await server.stop().catch(() => undefined);
      }
      // 只停本脚本启动的 gateway，且 PID 记录仍指向同一个进程。
      const pid = ownedPid;
      if (pid !== undefined) {
        const record = await readGatewayPidRecord(dataDir).catch(() => null);
        if (record && record.pid === pid) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // 已退出
          }
        }
      }
      process.exit(code);
    })();
    return cleanupPromise;
  };

  process.on('SIGINT', () => {
    void cleanup(0);
  });
  process.on('SIGTERM', () => {
    void cleanup(0);
  });

  try {
    // 1. gateway：复用健康的外部进程，否则启动 daemon。
    let gatewayPort = configPort;
    const existing = await runningGateway(dataDir, configPort);
    if (existing) {
      gatewayPort = existing.port;
      console.log(
        `[dev-web] gateway already running (pid ${existing.record.pid}) at http://127.0.0.1:${gatewayPort}`,
      );
    } else {
      const result = await startGatewayDaemon({
        dataDir,
        instance: 'default',
        port: configPort,
        host,
        execPath: process.execPath,
        entryPath: path.join(repoRoot, 'src/cli.ts'),
      });

      if (result.ok) {
        ownedPid = result.record.pid;
        gatewayPort = result.record.port > 0 ? result.record.port : configPort;
        if (!(await waitForHealth(gatewayPort))) {
          console.error(
            `[dev-web] gateway started (pid ${result.record.pid}) but /health did not become ready at http://127.0.0.1:${gatewayPort}`,
          );
          const tail = await tailLog(result.logPath);
          if (tail) console.error(tail);
          await cleanup(1);
        }
        console.log(
          `[dev-web] started gateway (pid ${result.record.pid}) at http://127.0.0.1:${gatewayPort}`,
        );
      } else if (result.error === 'already_running') {
        // 竞态：别人刚启动。按外部进程处理，不接管 ownership。
        const external = await readGatewayPidRecord(dataDir);
        gatewayPort = external && external.port > 0 ? external.port : configPort;
        if (!(await waitForHealth(gatewayPort))) {
          console.error(
            `[dev-web] gateway is already running but /health is not ready at http://127.0.0.1:${gatewayPort}`,
          );
          await cleanup(1);
        }
        console.log(
          `[dev-web] gateway already running (pid ${result.runningPid ?? external?.pid ?? 'unknown'}) at http://127.0.0.1:${gatewayPort}`,
        );
      } else {
        console.error(`[dev-web] failed to start gateway: ${result.message}`);
        const tail = await tailLog(gatewayLogPath(dataDir, 'default'));
        if (tail) console.error(tail);
        await cleanup(1);
      }
    }

    // 2. relay（随机 secret；只绑回环）。
    const secret = randomUUID();
    const relayServer = startRelay({ gatewayPort, token, secret });
    relay = relayServer;
    console.log('[dev-web] dev relay ready (HTTP + WebSocket auth injection enabled)');

    // 3. Vite（不带任何 token，只带 relay 地址 / secret）。
    const viteBin = path.join(repoRoot, 'apps/web', 'node_modules', 'vite', 'bin', 'vite.js');
    if (!existsSync(viteBin)) {
      console.error(`[dev-web] Vite is not installed at ${viteBin}`);
      console.error('[dev-web] run: cd apps/web && npm ci');
      await cleanup(1);
    }

    const viteEnv: Record<string, string | undefined> = { ...process.env };
    delete viteEnv.VESSEL_DEV_TOKEN;
    delete viteEnv.VESSEL_GATEWAY_TOKEN;
    delete viteEnv.VESSEL_CONNECT_TOKEN;
    viteEnv.VESSEL_DEV_RELAY_URL = relayServer.url;
    viteEnv.VESSEL_DEV_RELAY_SECRET = secret;
    viteEnv.VESSEL_GATEWAY_URL = `http://127.0.0.1:${gatewayPort}`;
    viteEnv.VITE_DEV_PROXY_AUTH = '1';

    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(
        ['node', viteBin, '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'],
        {
          cwd: path.join(repoRoot, 'apps/web'),
          env: viteEnv,
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        },
      );
    } catch (error) {
      console.error(
        `[dev-web] failed to start Vite: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error('[dev-web] ensure Node.js is installed and run: cd apps/web && npm ci');
      return cleanup(1);
    }
    viteChild = child;

    console.log(`[dev-web] Vite: http://127.0.0.1:${VITE_PORT}`);
    console.log(`[dev-web] gateway: http://127.0.0.1:${gatewayPort}`);
    console.log(
      '[dev-web] Ctrl+C stops Vite and the dev relay; only a gateway started here is stopped.',
    );

    const code = await child.exited;
    await cleanup(code);
  } catch (error) {
    // 启动中途失败（relay / Vite / 健康检查）也必须回收本脚本启动的 gateway。
    console.error(`[dev-web] ${error instanceof Error ? error.message : String(error)}`);
    await cleanup(1);
  }
}

// 必须 top-level await：无其他活动 handle 时，未 await 的 main() 可能在
// loadConfig() 的异步读取完成前让 Bun 正常退出（小配置下可复现）。
try {
  await main();
} catch (error) {
  console.error(`[dev-web] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
