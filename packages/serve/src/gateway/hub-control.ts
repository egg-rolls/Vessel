/**
 * `/v1/hub/control`（S5 / `vessel.hub/1`）：节点向 hub 暴露目录投影的 WS。
 *
 * - 只在注入 `hubControl` 时可用；否则 404。
 * - token 只走首帧（不接受 `?token=`）；首帧 5s 超时。
 * - 首帧要求 `scope` 为 `view` / `admin`（legacy admin 无 scope 也允许），
 *   且 `principal.hub_id` 必须存在并与首帧 `hub_id` 一致（防 A hub 复用 B hub）。
 * - 连接独立订阅 `hubControl.subscribe`，**不**进入 `wsClients`，因此永不接收
 *   RunEvent / content / session_id；只发 hello / snapshot / pointer / ping。
 * - 目录变化 250ms debounce；revision 每次 snapshot +1。
 * - 心跳 15s ping；连续 30s 无 pong 关闭。
 *
 * @module @vessel-agent/serve
 */

import { ClientBackpressure } from '../backpressure.js';
import type { HubControlLike, HubNodeSnapshotInput } from '../hub-control.js';
import {
  buildHubHelloFrame,
  buildHubPingFrame,
  buildHubPointerFrame,
  buildHubSnapshotFrame,
} from '../hub-frames.js';
import {
  type HubHelloFrame,
  type HubPointerFrame,
  type HubSnapshotFrame,
  isHubDialer,
  isHubProtocol,
} from '../hub-protocol.js';
import { type GatewayAuthLike, resolvePrincipal } from '../tenant.js';

/** 端点路径。 */
export const HUB_CONTROL_PATH = '/v1/hub/control';

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_PING_INTERVAL_MS = 15_000;
/** 目录变化合并窗口。 */
const DIRECTORY_DEBOUNCE_MS = 250;
const WS_BACKPRESSURE_HIGH = 2 * 1024 * 1024;
const WS_BACKPRESSURE_LOW = 512 * 1024;

/** 单条 hub control 连接的可变状态（挂在 `ws.data.hubControl` 上）。 */
export interface HubControlConnectionState {
  authed: boolean;
  alive: boolean;
  closed: boolean;
  /** 单调递增；hello 发当前值，每次 snapshot +1。 */
  revision: number;
  tenantId: string;
  hubId?: string;
  /** 吊销时按该 id 关闭连接。 */
  tokenId?: string;
  authTimer?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  debounce?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
  /** 串行化 snapshot，避免并发请求导致 revision 乱序。 */
  snapshotChain: Promise<void>;
}

/** hub control 连接的最小 WS 形状（Bun `ServerWebSocket` 结构兼容）。 */
export interface HubControlWs {
  data: {
    hubControl?: HubControlConnectionState;
  };
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Bun server 的 upgrade 面（避免把 Bun 类型带进模块）。 */
export interface HubControlUpgradeServer {
  upgrade(req: Request, options?: { data?: unknown }): boolean;
}

export interface HubControlRouteDeps {
  /** 缺省 = 端点 404。 */
  hubControl?: HubControlLike;
  auth?: GatewayAuthLike;
  legacyToken: string;
  nodeId: string;
  incarnation: string;
  defaultTenantId: string;
  authTimeoutMs?: number;
  pingIntervalMs?: number;
}

/** `handle()` 的返回值：`undefined` = 路径不匹配；`'upgraded'` = 已升级。 */
export type HubControlRouteResult = Response | 'upgraded' | undefined;

export interface HubControlRoute {
  handle(
    req: Request,
    url: URL,
    srv: HubControlUpgradeServer,
    extra: Record<string, string>,
  ): HubControlRouteResult;
  open(ws: HubControlWs): void;
  message(ws: HubControlWs, raw: string | Buffer): void;
  close(ws: HubControlWs): void;
  pong(ws: HubControlWs): void;
  /** 关闭全部连接并退订（gateway stop 调用）。 */
  stop(): void;
  /** 关闭持有该 token_id 的 hub control 连接；返回关闭数。 */
  closeByTokenId(tokenId: string): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function jsonResponse(status: number, body: unknown, extra: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

function errorResponse(
  code: string,
  message: string,
  status: number,
  extra: Record<string, string>,
): Response {
  return jsonResponse(status, { error: { code, message } }, extra);
}

/** 创建 `/v1/hub/control` 路由。 */
export function createHubControlRoute(deps: HubControlRouteDeps): HubControlRoute {
  const authTimeoutMs = deps.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const pingIntervalMs = deps.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const clients = new Set<HubControlWs>();
  /** 进程内单调；跨连接共享，重连后的首帧 snapshot 必须大于 hub 已见 revision。 */
  let nextRevision = 0;

  function sendFrame(ws: HubControlWs, frame: unknown): boolean {
    const state = ws.data.hubControl;
    if (!state || state.closed) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      finish(ws);
      return false;
    }
  }

  function helloFrame(state: HubControlConnectionState): HubHelloFrame {
    return buildHubHelloFrame({
      dialer: 'hub',
      hubId: state.hubId ?? '',
      nodeId: deps.nodeId,
      incarnation: deps.incarnation,
      revision: state.revision,
      tenantId: state.tenantId,
    });
  }

  /** 只白名单构造 snapshot；provider 附带的字段一律不透传。 */
  function snapshotFrame(
    input: HubNodeSnapshotInput,
    state: HubControlConnectionState,
  ): HubSnapshotFrame {
    return buildHubSnapshotFrame(input, {
      dialer: 'hub',
      nodeId: deps.nodeId,
      hubId: state.hubId ?? '',
      incarnation: deps.incarnation,
      revision: state.revision,
      observedAt: Date.now(),
    });
  }

  /** 只白名单构造 pointer；未知 reason / 空 team_id 丢弃。 */
  function pointerFrame(pointer: unknown, hubId: string): HubPointerFrame | null {
    return buildHubPointerFrame(pointer, {
      dialer: 'hub',
      nodeId: deps.nodeId,
      hubId,
      now: Date.now(),
    });
  }

  function sendPointer(ws: HubControlWs, state: HubControlConnectionState, raw: unknown): void {
    const frame = pointerFrame(raw, state.hubId ?? '');
    if (frame === null) return;
    sendFrame(ws, frame);
  }

  function requestSnapshot(ws: HubControlWs, state: HubControlConnectionState): void {
    state.snapshotChain = state.snapshotChain
      .then(async () => {
        if (state.closed || !state.authed || deps.hubControl === undefined) return;
        let input: HubNodeSnapshotInput;
        try {
          input = await deps.hubControl.snapshot(state.tenantId);
        } catch {
          return;
        }
        if (state.closed || !state.authed) return;
        nextRevision += 1;
        state.revision = nextRevision;
        sendFrame(ws, snapshotFrame(input, state));
      })
      .catch(() => undefined);
  }

  function scheduleSnapshot(ws: HubControlWs, state: HubControlConnectionState): void {
    if (state.debounce !== undefined) clearTimeout(state.debounce);
    state.debounce = setTimeout(() => {
      state.debounce = undefined;
      requestSnapshot(ws, state);
    }, DIRECTORY_DEBOUNCE_MS);
    (state.debounce as { unref?: () => void }).unref?.();
  }

  function startHeartbeat(ws: HubControlWs, state: HubControlConnectionState): void {
    state.heartbeat = setInterval(() => {
      if (state.closed) return;
      if (!state.alive) {
        finish(ws);
        try {
          ws.close(1001, 'heartbeat timeout');
        } catch {
          // best-effort
        }
        return;
      }
      state.alive = false;
      sendFrame(ws, buildHubPingFrame({ dialer: 'hub', ts: Date.now() }));
    }, pingIntervalMs);
    (state.heartbeat as { unref?: () => void }).unref?.();
  }

  function finish(ws: HubControlWs): void {
    const state = ws.data.hubControl;
    if (!state || state.closed) return;
    state.closed = true;
    if (state.authTimer !== undefined) {
      clearTimeout(state.authTimer);
      state.authTimer = undefined;
    }
    if (state.heartbeat !== undefined) {
      clearInterval(state.heartbeat);
      state.heartbeat = undefined;
    }
    if (state.debounce !== undefined) {
      clearTimeout(state.debounce);
      state.debounce = undefined;
    }
    const unsubscribe = state.unsubscribe;
    state.unsubscribe = undefined;
    if (unsubscribe !== undefined) {
      try {
        unsubscribe();
      } catch {
        // 退订失败不影响关闭
      }
    }
    clients.delete(ws);
  }

  function closeWith(ws: HubControlWs, code: number, reason: string): void {
    finish(ws);
    try {
      ws.close(code, reason);
    } catch {
      // best-effort
    }
  }

  function authenticate(
    ws: HubControlWs,
    state: HubControlConnectionState,
    frame: Record<string, unknown>,
  ): void {
    if (frame.v !== 1 || !isHubProtocol(frame.protocol) || !isHubDialer(frame.dialer)) {
      closeWith(ws, 4400, 'unsupported protocol');
      return;
    }
    // S5 只实现 hub 拨号 node；node 拨号是 S5.1。
    if (frame.dialer !== 'hub') {
      closeWith(ws, 4400, 'unsupported dialer');
      return;
    }
    const token = frame.token;
    const hubId = frame.hub_id;
    if (!nonEmptyString(token) || !nonEmptyString(hubId)) {
      closeWith(ws, 4401, 'unauthorized');
      return;
    }

    const principal = resolvePrincipal(deps.auth, token, deps.legacyToken);
    if (principal === null) {
      closeWith(ws, 4401, 'unauthorized');
      return;
    }
    const scope = principal.scope;
    const scopeAllowed =
      scope === 'view' || scope === 'admin' || (scope === undefined && principal.role === 'admin');
    if (!scopeAllowed) {
      closeWith(ws, 4403, 'forbidden scope');
      return;
    }
    // hub_id 绑定：缺失或不一致都拒绝，防止 A hub 的 token 被 B hub 复用。
    if (!nonEmptyString(principal.hub_id) || principal.hub_id !== hubId) {
      closeWith(ws, 4401, 'hub mismatch');
      return;
    }

    state.authed = true;
    state.hubId = hubId;
    state.tokenId = principal.token_id;
    state.tenantId = principal.tenant_id === '*' ? deps.defaultTenantId : principal.tenant_id;
    if (state.authTimer !== undefined) {
      clearTimeout(state.authTimer);
      state.authTimer = undefined;
    }

    const hubControl = deps.hubControl;
    if (hubControl === undefined) {
      closeWith(ws, 1011, 'hub control unavailable');
      return;
    }
    try {
      state.unsubscribe = hubControl.subscribe(state.tenantId, (change) => {
        if (state.closed) return;
        if (Array.isArray(change.pointers)) {
          for (const pointer of change.pointers) sendPointer(ws, state, pointer);
        }
        if (change.directoryChanged === true) scheduleSnapshot(ws, state);
      });
    } catch {
      closeWith(ws, 1011, 'subscribe failed');
      return;
    }

    startHeartbeat(ws, state);
    sendFrame(ws, helloFrame(state));
    // 首次 snapshot 立即发；后续由 debounce 触发。
    requestSnapshot(ws, state);
  }

  function handleMessage(ws: HubControlWs, raw: string | Buffer): void {
    const state = ws.data.hubControl;
    if (!state || state.closed) return;
    // 任何帧都视为存活信号；心跳按两轮（30s）判定。
    state.alive = true;

    let frame: unknown;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      closeWith(ws, 4400, 'invalid frame');
      return;
    }
    if (!isRecord(frame)) {
      closeWith(ws, 4400, 'invalid frame');
      return;
    }

    if (!state.authed) {
      if (frame.kind !== 'auth') {
        closeWith(ws, 4401, 'auth required');
        return;
      }
      authenticate(ws, state, frame);
      return;
    }

    if (frame.v !== 1 || !isHubProtocol(frame.protocol) || !isHubDialer(frame.dialer)) {
      closeWith(ws, 4400, 'unsupported protocol');
      return;
    }
    if (frame.kind === 'pong') return;
    // 其余元数据帧（客户端不应发送）忽略，不解析正文。
  }

  return {
    handle(req, url, srv, extra) {
      if (url.pathname !== HUB_CONTROL_PATH) return undefined;
      if (deps.hubControl === undefined) {
        return errorResponse('not_found', `Not found: ${url.pathname}`, 404, extra);
      }
      if ((req.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
        return errorResponse('invalid_request', 'WebSocket upgrade required', 400, extra);
      }
      // ADR-053：token 只走首帧，不接受 URL/query。
      if (url.searchParams.has('token')) {
        return errorResponse(
          'invalid_request',
          'WebSocket auth must use the first auth frame; token in query is not supported',
          400,
          extra,
        );
      }

      const state: HubControlConnectionState = {
        authed: false,
        alive: true,
        closed: false,
        revision: nextRevision,
        tenantId: deps.defaultTenantId,
        snapshotChain: Promise.resolve(),
      };
      const upgraded = srv.upgrade(req, {
        data: {
          authed: false,
          since: 0,
          alive: true,
          backpressure: new ClientBackpressure({
            high: WS_BACKPRESSURE_HIGH,
            low: WS_BACKPRESSURE_LOW,
          }),
          tenantId: deps.defaultTenantId,
          allTenants: false,
          hubControl: state,
        },
      });
      if (!upgraded) {
        return errorResponse('invalid_request', 'WebSocket upgrade failed', 400, extra);
      }
      return 'upgraded';
    },

    open(ws) {
      const state = ws.data.hubControl;
      if (!state || state.closed) return;
      clients.add(ws);
      state.authTimer = setTimeout(() => {
        if (!state.authed) closeWith(ws, 4401, 'auth timeout');
      }, authTimeoutMs);
      (state.authTimer as { unref?: () => void }).unref?.();
    },

    message(ws, raw) {
      handleMessage(ws, raw);
    },

    close(ws) {
      finish(ws);
    },

    pong(ws) {
      const state = ws.data.hubControl;
      if (state) state.alive = true;
    },

    stop() {
      for (const ws of [...clients]) {
        finish(ws);
        try {
          ws.close(1001, 'server stopping');
        } catch {
          // best-effort
        }
      }
      clients.clear();
    },

    closeByTokenId(tokenId: string): number {
      let closed = 0;
      for (const ws of [...clients]) {
        if (ws.data.hubControl?.tokenId !== tokenId) continue;
        finish(ws);
        try {
          ws.close(4401, 'token revoked');
        } catch {
          // best-effort
        }
        closed += 1;
      }
      return closed;
    },
  };
}
