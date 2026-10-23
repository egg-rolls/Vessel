/**
 * `/v1/hub/node-control` 的 WS 状态机（S5.1，node 拨号 hub）。
 *
 * hub 是 acceptor：首帧 `auth`（node token）在 5s 内到达，校验 token 记录与
 * `hub_id` / `node_id` / `tenant_id` 绑定；随后由 hub 发 `hello`，节点推
 * `snapshot` / `pointer`，hub 只发 `hello` / `ping`（心跳）。
 *
 * - 身份只信 token 记录；`auth` 帧里的字段只用于与记录比对。
 * - 同一 pairing 只保留一条活动连接：新连接接管，旧连接的 close 不再改写状态。
 * - 快照接受策略来自 `snapshot-policy.ts`（每个连接一份）；**runtime 负责持久化**
 *   最终 `(incarnation, revision)`，重连后由 runtime 种子化。
 * - 只处理 6 种元数据帧，**不**解析 RunEvent / 消息正文 / 工具参数。
 *
 * server.ts 拥有 `Bun.serve`，这里只做逐连接状态机：
 * `open()` 返回连接对象，server 在 open / message / close / pong 时回调。
 *
 * @module vessel/hub/inbound-control
 */

import type { Logger } from '@vessel-agent/core';
import {
  buildHubHelloFrame,
  buildHubPingFrame,
  decodeHubFrame,
  parseHubAuthFrame,
  parseHubPointerFrame,
  parseHubPongFrame,
  parseHubSnapshotFrame,
} from '@vessel-agent/serve';
import { createHubSnapshotPolicy, type HubSnapshotPolicy } from './snapshot-policy.js';
import {
  type HubNodeInboundDeps,
  type HubNodePointer,
  type HubNodeSnapshot,
  type HubNodeStatus,
  pairingIdFor,
} from './types.js';

/** 未配置时的心跳 / 超时默认值。 */
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_PING_INTERVAL_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** 连接所需的最小 WS 形状（Bun `ServerWebSocket` 结构兼容）。 */
export interface HubNodeInboundWs {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** 单条入站连接的内部状态；server 只把它当作不透明句柄保存。 */
export interface HubNodeInboundConnection {
  readonly ws: HubNodeInboundWs;
  authed: boolean;
  closed: boolean;
  pairingId?: string;
  nodeId?: string;
  tenantId?: string;
  tokenId?: string;
  policy?: HubSnapshotPolicy;
  authTimer?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  lastFrameAt: number;
}

/** `/v1/hub/node-control` 的状态机。 */
export interface HubNodeInbound {
  /** WS open：创建连接并启动首帧 auth 超时。 */
  open(ws: HubNodeInboundWs): HubNodeInboundConnection;
  /** WS message：auth / snapshot / pointer / pong。 */
  message(conn: HubNodeInboundConnection, raw: string | Buffer | Uint8Array): void;
  /** WS close：自然断开；仅当仍是该 pairing 的当前连接时上报 unreachable。 */
  close(conn: HubNodeInboundConnection): void;
  /** WS 协议层 pong：仅刷新存活时间。 */
  pong(conn: HubNodeInboundConnection): void;
  /** 关闭某 pairing 的活动连接；不发状态回调（用于 remove / 吊销）。 */
  closeByPairing(pairingId: string): number;
  /** 关闭持有该 token_id 的连接；不发状态回调（用于吊销）。 */
  closeByTokenId(tokenId: string): number;
  /** 关闭全部连接并清理定时器（server stop）。 */
  stop(): void;
}

interface CloseStatus {
  status: HubNodeStatus;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 创建 hub 入站状态机；依赖由 runtime / server 注入。 */
export function createHubNodeInbound(deps: HubNodeInboundDeps): HubNodeInbound {
  const authTimeoutMs = deps.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const pingIntervalMs = deps.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const clock = deps.now ?? Date.now;
  const logger: Logger | undefined = deps.logger;
  const connections = new Map<string, HubNodeInboundConnection>();
  let stopped = false;

  function notifyStatus(pairingId: string, status: HubNodeStatus, error?: string): void {
    try {
      deps.hooks.onStatus(pairingId, status, error);
    } catch (caught) {
      logger?.warn('hub.inbound.status_hook_failed', {
        pairing_id: pairingId,
        status,
        error: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  function notifySnapshot(pairingId: string, snapshot: HubNodeSnapshot): void {
    try {
      deps.hooks.onSnapshot(pairingId, snapshot);
    } catch (caught) {
      logger?.warn('hub.inbound.snapshot_hook_failed', {
        pairing_id: pairingId,
        error: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  function notifyPointer(pointer: HubNodePointer): void {
    try {
      deps.hooks.onPointer(pointer);
    } catch (caught) {
      logger?.warn('hub.inbound.pointer_hook_failed', {
        error: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  function notifyAuthenticated(conn: HubNodeInboundConnection): void {
    if (
      conn.pairingId === undefined ||
      conn.nodeId === undefined ||
      conn.tenantId === undefined ||
      conn.tokenId === undefined
    ) {
      return;
    }
    try {
      deps.hooks.onAuthenticated?.({
        pairing_id: conn.pairingId,
        node_id: conn.nodeId,
        tenant_id: conn.tenantId,
        node_token_id: conn.tokenId,
      });
    } catch (caught) {
      logger?.warn('hub.inbound.auth_hook_failed', {
        pairing_id: conn.pairingId,
        error: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  /** 清理定时器 / Map 条目；不发任何回调。 */
  function finish(conn: HubNodeInboundConnection): void {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.authTimer !== undefined) {
      clearTimeout(conn.authTimer);
      conn.authTimer = undefined;
    }
    if (conn.heartbeat !== undefined) {
      clearInterval(conn.heartbeat);
      conn.heartbeat = undefined;
    }
    if (conn.pairingId !== undefined && connections.get(conn.pairingId) === conn) {
      connections.delete(conn.pairingId);
    }
  }

  function sendFrame(conn: HubNodeInboundConnection, frame: unknown): void {
    if (conn.closed) return;
    try {
      conn.ws.send(JSON.stringify(frame));
    } catch {
      finish(conn);
    }
  }

  function closeWith(
    conn: HubNodeInboundConnection,
    code: number,
    reason: string,
    status?: CloseStatus,
  ): void {
    const pairingId = conn.pairingId;
    const wasOpen = !conn.closed;
    finish(conn);
    try {
      conn.ws.close(code, reason);
    } catch {
      // best-effort
    }
    if (wasOpen && status !== undefined && pairingId !== undefined) {
      notifyStatus(pairingId, status.status, status.error);
    }
  }

  /** 新连接接管：关闭同 pairing 的旧连接，且不让旧 close 覆盖新状态。 */
  function takeover(conn: HubNodeInboundConnection, pairingId: string): void {
    const previous = connections.get(pairingId);
    if (previous !== undefined && previous !== conn) {
      finish(previous);
      try {
        previous.ws.close(1001, 'replaced by newer connection');
      } catch {
        // best-effort
      }
    }
    connections.set(pairingId, conn);
  }

  function startHeartbeat(conn: HubNodeInboundConnection): void {
    conn.heartbeat = setInterval(() => {
      if (conn.closed) return;
      const now = clock();
      // 30s（默认）内没有任何帧 → 判定断线；先于本轮 ping 判定。
      if (now - conn.lastFrameAt >= idleTimeoutMs) {
        closeWith(conn, 1001, 'heartbeat timeout', {
          status: 'unreachable',
          error: 'disconnected',
        });
        return;
      }
      sendFrame(conn, buildHubPingFrame({ dialer: 'node', ts: now }));
    }, pingIntervalMs);
    (conn.heartbeat as { unref?: () => void }).unref?.();
  }

  function authenticate(conn: HubNodeInboundConnection, value: unknown): void {
    const parsed = parseHubAuthFrame(value, 'node');
    if (!parsed.ok) {
      // 方向 / 协议版本错配 → 4400；缺 token / 缺身份 → 4401。
      if (parsed.reason === 'unsupported') closeWith(conn, 4400, 'incompatible');
      else closeWith(conn, 4401, 'unauthorized');
      return;
    }
    const frame = parsed.frame;

    // 本 hub 只接受自己的 token；记录本身是唯一身份来源。
    if (frame.hub_id !== deps.hubId) {
      closeWith(conn, 4401, 'unauthorized');
      return;
    }
    const record = deps.credentials.authenticate(frame.token);
    if (record === null || record.scope !== 'node' || record.revoked_at !== undefined) {
      closeWith(conn, 4401, 'unauthorized');
      return;
    }

    const nodeId = record.node_id;
    const tenantId = record.tenant_id;
    const pairingId = record.pairing_id;
    const identityMatches =
      record.hub_id === deps.hubId &&
      record.hub_id === frame.hub_id &&
      record.node_id === frame.node_id &&
      record.tenant_id === frame.tenant_id &&
      pairingId === pairingIdFor(nodeId, tenantId);
    if (!identityMatches) {
      closeWith(conn, 4401, 'unauthorized');
      return;
    }

    conn.authed = true;
    conn.nodeId = nodeId;
    conn.tenantId = tenantId;
    conn.pairingId = pairingId;
    conn.tokenId = record.token_id;
    conn.policy = createHubSnapshotPolicy();
    conn.lastFrameAt = clock();
    if (conn.authTimer !== undefined) {
      clearTimeout(conn.authTimer);
      conn.authTimer = undefined;
    }

    takeover(conn, pairingId);
    notifyAuthenticated(conn);
    sendFrame(
      conn,
      buildHubHelloFrame({
        dialer: 'node',
        hubId: deps.hubId,
        nodeId,
        tenantId,
      }),
    );
    notifyStatus(pairingId, 'healthy');
    startHeartbeat(conn);
  }

  function handleAuthedFrame(conn: HubNodeInboundConnection, value: unknown): void {
    if (!isRecord(value)) {
      closeWith(conn, 4400, 'invalid frame');
      return;
    }
    // tenant / node 绑定已在 auth 时由 token 记录确定；snapshot / pointer 帧
    // 通常不携带 tenant_id。若帧里带了，则必须与 token 记录一致。
    const identity = {
      hub_id: deps.hubId,
      node_id: conn.nodeId,
      ...(value.tenant_id !== undefined ? { tenant_id: conn.tenantId } : {}),
    };
    const kind = value.kind;

    if (kind === 'snapshot') {
      const parsed = parseHubSnapshotFrame(value, identity, 'node');
      if (!parsed.ok) {
        if (parsed.reason === 'identity_mismatch') {
          closeWith(conn, 4401, 'identity mismatch', {
            status: 'identity_mismatch',
            error: 'identity mismatch',
          });
        } else if (parsed.reason === 'unsupported') {
          closeWith(conn, 4400, 'incompatible');
        }
        // 单帧不合法：丢弃，不断开。
        return;
      }
      // 每个连接一份策略：只接受递增 revision，incarnation 变化强制接受。
      // 最终 `(incarnation, revision)` 由 runtime 持久化，重连后由它种子化。
      const policy = conn.policy ?? createHubSnapshotPolicy();
      conn.policy = policy;
      if (!policy.accept(parsed.frame.incarnation, parsed.frame.revision)) return;
      if (conn.pairingId !== undefined) notifySnapshot(conn.pairingId, parsed.frame);
      return;
    }

    if (kind === 'pointer') {
      const parsed = parseHubPointerFrame(value, identity, 'node');
      if (!parsed.ok) {
        if (parsed.reason === 'identity_mismatch') {
          closeWith(conn, 4401, 'identity mismatch', {
            status: 'identity_mismatch',
            error: 'identity mismatch',
          });
        } else if (parsed.reason === 'unsupported') {
          closeWith(conn, 4400, 'incompatible');
        }
        return;
      }
      notifyPointer(parsed.frame);
      return;
    }

    if (kind === 'pong') {
      const parsed = parseHubPongFrame(value, 'node');
      if (!parsed.ok && parsed.reason === 'unsupported') closeWith(conn, 4400, 'incompatible');
      return;
    }

    // 其它帧（含 acceptor 才发的 ping / hello）一律忽略。
  }

  return {
    open(ws: HubNodeInboundWs): HubNodeInboundConnection {
      const conn: HubNodeInboundConnection = {
        ws,
        authed: false,
        closed: false,
        lastFrameAt: clock(),
      };
      if (stopped) {
        conn.closed = true;
        try {
          ws.close(1001, 'server stopping');
        } catch {
          // best-effort
        }
        return conn;
      }
      conn.authTimer = setTimeout(() => {
        if (!conn.authed) closeWith(conn, 4401, 'auth timeout');
      }, authTimeoutMs);
      (conn.authTimer as { unref?: () => void }).unref?.();
      return conn;
    },

    message(conn, raw) {
      if (conn.closed) return;
      conn.lastFrameAt = clock();
      const value = decodeHubFrame(raw);
      if (value === null) {
        closeWith(conn, 4400, 'invalid frame');
        return;
      }
      if (!conn.authed) {
        authenticate(conn, value);
        return;
      }
      handleAuthedFrame(conn, value);
    },

    close(conn) {
      if (conn.closed) return;
      const pairingId = conn.pairingId;
      finish(conn);
      if (pairingId !== undefined) notifyStatus(pairingId, 'unreachable', 'disconnected');
    },

    pong(conn) {
      if (!conn.closed) conn.lastFrameAt = clock();
    },

    closeByPairing(pairingId: string): number {
      const conn = connections.get(pairingId);
      if (conn === undefined) return 0;
      finish(conn);
      try {
        conn.ws.close(4401, 'pairing removed');
      } catch {
        // best-effort
      }
      return 1;
    },

    closeByTokenId(tokenId: string): number {
      let closed = 0;
      for (const conn of [...connections.values()]) {
        if (conn.tokenId !== tokenId) continue;
        finish(conn);
        try {
          conn.ws.close(4401, 'token revoked');
        } catch {
          // best-effort
        }
        closed += 1;
      }
      return closed;
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const conn of [...connections.values()]) {
        finish(conn);
        try {
          conn.ws.close(1001, 'server stopping');
        } catch {
          // best-effort
        }
      }
      connections.clear();
    },
  };
}
