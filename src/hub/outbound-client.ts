/**
 * Node → Hub 出站控制客户端（S5.1 / `vessel.hub/1`）。
 *
 * - 节点主动拨号 `${hubUrl}/v1/hub/node-control`（`dialer: 'node'`）；
 * - open 后首帧 `auth`（node token + hub/node/tenant 身份 + 进程 incarnation）；
 * - 等 `hello`（10s）：校验 `hub_id` / `node_id` 与方向；成功后发首个 `snapshot`；
 * - 订阅 `HubControlLike`：目录变化 250ms debounce 快照；指针立即转发；
 * - 收到 `ping` 回 `pong`；任何帧重置 30s idle；断线 1s→30s 退避 + 抖动；
 * - 4401 / 401 → `unauthorized` 停止重连；4400 / 400 → `incompatible` 停止重连；
 * - 只处理 `vessel.hub/1` 的六种元数据帧，绝不解析 RunEvent / 正文。
 *
 * @module vessel/hub/outbound-client
 */

import type { Logger } from '@vessel-agent/core';
import {
  buildHubAuthFrame,
  buildHubPointerFrame,
  buildHubPongFrame,
  buildHubSnapshotFrame,
  HUB_NODE_CONTROL_PATH,
  type HubControlChange,
  type HubControlLike,
  parseHubHelloFrame,
  parseHubPingFrame,
} from '@vessel-agent/serve';
import type { WebSocketFactory, WebSocketLike } from '../rpc/index.js';
import type { HubNodeOutboundStatus } from './node-state.js';
import type { HubNodeState } from './types.js';

/** 模块级进程代际：进程重启即变化；不写入 state。 */
const PROCESS_INCARNATION = crypto.randomUUID().replace(/-/g, '').slice(0, 12);

const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DIRECTORY_DEBOUNCE_MS = 250;
const WS_CLOSE_UNAUTHORIZED = 4401;
const WS_CLOSE_INCOMPATIBLE = 4400;

export interface HubNodeOutboundOptions {
  /** join 写入的 `hub-node.json`；只用其 `ca_file` 兜底。 */
  state: HubNodeState;
  /** hub 签发的 node token（明文，仅内存）；永不打印。 */
  token: string;
  hubControl: HubControlLike;
  hubId: string;
  nodeId: string;
  tenantId: string;
  /** hub 基址 origin（http/https，无路径）。 */
  hubUrl: string;
  /** CA 路径；缺省回退 `state.ca_file`。 */
  caFile?: string;
  /** 测试注入；缺省使用全局 WebSocket。 */
  wsFactory?: WebSocketFactory;
  /** 读取 ca_file 的实现；缺省 Bun.file。 */
  readCaFile?: (path: string) => Promise<string>;
  now?: () => number;
  logger?: Logger;
  /** 每次状态变化回调；`error` 是稳定错误码，不含正文。 */
  onStatus?: (status: HubNodeOutboundStatus, error?: string) => void;
  /** hello 成功后回调（wiring 用来记录 hello_at）。 */
  onHello?: () => void;
  /** 等待 hello 的上限（默认 10000ms）。 */
  helloTimeoutMs?: number;
  /** 静默上限（默认 30000ms）。 */
  idleTimeoutMs?: number;
  /** 退避参数（默认 1000 / 30000）。 */
  reconnect?: { initialMs?: number; maxMs?: number };
}

export interface HubNodeOutboundClient {
  /** 幂等关闭；取消订阅、清定时器、断开连接，不再重连。 */
  close(): void;
  status(): HubNodeOutboundStatus;
  /** 最近一次成功 hello 的时间（`now()` 时钟）。 */
  lastHelloAt(): number | undefined;
  /** 当前退避尝试次数（收到 hello 后归零）。 */
  attempt(): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return undefined;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function closeCode(event: unknown): number | undefined {
  if (isRecord(event) && typeof event.code === 'number') return event.code;
  return undefined;
}

/** http(s) origin → ws(s) + node-control 路径。 */
function nodeControlUrl(hubUrl: string): string {
  const base = hubUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
  return `${base}${HUB_NODE_CONTROL_PATH}`;
}

/** 创建并立即启动出站客户端。 */
export function createHubNodeOutboundClient(
  options: HubNodeOutboundOptions,
): HubNodeOutboundClient {
  const { hubControl, hubId, nodeId, tenantId, logger } = options;
  const clock = options.now ?? Date.now;
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const initialMs = options.reconnect?.initialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
  const maxMs = options.reconnect?.maxMs ?? DEFAULT_RECONNECT_MAX_MS;
  const caFile = options.caFile ?? options.state.ca_file;
  const readCaFile = options.readCaFile ?? ((path: string) => Bun.file(path).text());
  const wsFactory: WebSocketFactory =
    options.wsFactory ??
    ((url, tls) => new WebSocket(url, (tls ? { tls } : {}) as never) as unknown as WebSocketLike);
  const url = nodeControlUrl(options.hubUrl);

  let closed = false;
  /** 致命状态（unauthorized / incompatible）：不再重连。 */
  let halted = false;
  let starting = false;
  let socket: WebSocketLike | undefined;
  /** hello 已通过、可以发 snapshot / pointer 的连接。 */
  let readySocket: WebSocketLike | undefined;
  let status: HubNodeOutboundStatus = 'connecting';
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let directoryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let helloAt: number | undefined;
  let revision = 0;
  let unsubscribe: (() => void) | undefined;
  let snapshotQueue: Promise<void> = Promise.resolve();

  function setStatus(next: HubNodeOutboundStatus, error?: string): void {
    if (status === next) return;
    status = next;
    try {
      options.onStatus?.(next, error);
    } catch (failure) {
      logger?.warn('hub.node.status_listener_failed', {
        error: failure instanceof Error ? failure.message : String(failure),
      });
    }
  }

  function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): undefined {
    if (timer !== undefined) clearTimeout(timer);
    return undefined;
  }

  function clearConnectionTimers(): void {
    helloTimer = clearTimer(helloTimer);
    idleTimer = clearTimer(idleTimer);
  }

  function halt(next: HubNodeOutboundStatus, error?: string): void {
    halted = true;
    setStatus(next, error);
    const current = socket;
    socket = undefined;
    readySocket = undefined;
    clearConnectionTimers();
    if (current) {
      try {
        current.close();
      } catch {
        // best-effort
      }
    }
  }

  function scheduleReconnect(): void {
    if (closed || halted || reconnectTimer !== undefined) return;
    const capped = Math.min(maxMs, initialMs * 2 ** Math.min(attempt, 16));
    const delay = Math.round(capped * (0.8 + Math.random() * 0.4));
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      startConnect();
    }, delay);
    (reconnectTimer as { unref?: () => void }).unref?.();
  }

  function dropAndReconnect(current: WebSocketLike, error: string): void {
    if (socket !== current) return;
    socket = undefined;
    readySocket = undefined;
    clearConnectionTimers();
    try {
      current.close();
    } catch {
      // best-effort
    }
    if (closed || halted) return;
    setStatus('unreachable', error);
    scheduleReconnect();
  }

  function resetIdleTimer(current: WebSocketLike): void {
    idleTimer = clearTimer(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (closed || halted || socket !== current) return;
      logger?.debug?.('hub.node.idle_timeout', { node_id: nodeId });
      dropAndReconnect(current, 'idle_timeout');
    }, idleTimeoutMs);
    (idleTimer as { unref?: () => void }).unref?.();
  }

  function send(current: WebSocketLike, frame: unknown): void {
    try {
      current.send(JSON.stringify(frame));
    } catch {
      dropAndReconnect(current, 'send_failed');
    }
  }

  async function deliverSnapshot(current: WebSocketLike): Promise<void> {
    if (closed || halted || socket !== current || readySocket !== current) return;
    let input: Awaited<ReturnType<HubControlLike['snapshot']>>;
    try {
      input = await hubControl.snapshot(tenantId);
    } catch (error) {
      logger?.warn('hub.node.snapshot_failed', {
        node_id: nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (closed || halted || socket !== current || readySocket !== current) return;
    revision += 1;
    send(
      current,
      buildHubSnapshotFrame(input, {
        dialer: 'node',
        nodeId,
        hubId,
        incarnation: PROCESS_INCARNATION,
        revision,
        observedAt: clock(),
      }),
    );
  }

  /** 串行化快照，避免并发 `snapshot()` 的返回顺序打乱 revision 发送顺序。 */
  function requestSnapshot(current: WebSocketLike): void {
    snapshotQueue = snapshotQueue
      .then(() => deliverSnapshot(current))
      .catch(() => {
        // deliverSnapshot 内部已处理错误；这里只保持队列可继续。
      });
  }

  function handleChange(change: HubControlChange): void {
    if (closed || halted) return;
    if (Array.isArray(change.pointers)) {
      const current = socket;
      if (current !== undefined && readySocket === current) {
        for (const pointer of change.pointers) {
          const frame = buildHubPointerFrame(pointer, {
            dialer: 'node',
            nodeId,
            hubId,
            now: clock(),
          });
          if (frame !== null) send(current, frame);
        }
      }
    }
    if (change.directoryChanged === true) {
      directoryTimer = clearTimer(directoryTimer);
      directoryTimer = setTimeout(() => {
        directoryTimer = undefined;
        if (closed || halted) return;
        const current = socket;
        if (current !== undefined && readySocket === current) requestSnapshot(current);
      }, DIRECTORY_DEBOUNCE_MS);
      (directoryTimer as { unref?: () => void }).unref?.();
    }
  }

  function ensureSubscribed(): void {
    if (unsubscribe !== undefined) return;
    try {
      unsubscribe = hubControl.subscribe(tenantId, handleChange);
    } catch (error) {
      logger?.warn('hub.node.subscribe_failed', {
        node_id: nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function handleHello(current: WebSocketLike, frame: Record<string, unknown>): void {
    helloTimer = clearTimer(helloTimer);
    const parsed = parseHubHelloFrame(frame, { hub_id: hubId, node_id: nodeId }, 'node');
    if (!parsed.ok) {
      const reason = parsed.reason === 'identity_mismatch' ? 'identity_mismatch' : 'invalid_hello';
      logger?.warn('hub.node.hello_rejected', { node_id: nodeId, reason });
      halt('incompatible', reason);
      return;
    }
    attempt = 0;
    readySocket = current;
    helloAt = clock();
    setStatus('healthy');
    try {
      options.onHello?.();
    } catch (error) {
      logger?.warn('hub.node.hello_listener_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    ensureSubscribed();
    requestSnapshot(current);
  }

  function handlePing(current: WebSocketLike, frame: Record<string, unknown>): void {
    const parsed = parseHubPingFrame(frame, 'node');
    if (!parsed.ok) return;
    send(current, buildHubPongFrame({ dialer: 'node' }));
  }

  function handleFrame(current: WebSocketLike, data: unknown): void {
    if (closed || halted || socket !== current) return;
    const text = textOf(data);
    if (text === undefined) return;
    const frame = safeParse(text);
    if (!isRecord(frame)) return;
    // 任何帧都算存活；只按 kind 分派，绝不解析正文。
    resetIdleTimer(current);
    switch (frame.kind) {
      case 'hello':
        handleHello(current, frame);
        return;
      case 'ping':
        handlePing(current, frame);
        return;
      case 'pong':
        return;
      default:
        // snapshot / pointer / auth 不应由 hub acceptor 发来；忽略。
        return;
    }
  }

  function open(current: WebSocketLike): void {
    current.addEventListener('open', () => {
      if (closed || halted || socket !== current) return;
      send(
        current,
        buildHubAuthFrame({
          dialer: 'node',
          token: options.token,
          hubId,
          nodeId,
          tenantId,
          incarnation: PROCESS_INCARNATION,
        }),
      );
      helloTimer = setTimeout(() => {
        helloTimer = undefined;
        if (closed || halted || socket !== current) return;
        logger?.warn('hub.node.hello_timeout', { node_id: nodeId });
        dropAndReconnect(current, 'hello_timeout');
      }, helloTimeoutMs);
      (helloTimer as { unref?: () => void }).unref?.();
      resetIdleTimer(current);
    });

    current.addEventListener('message', (event: { data: unknown }) => {
      handleFrame(current, event.data);
    });

    current.addEventListener('close', (event?: unknown) => {
      // 陈旧 close：新连接已经接管，不能把 healthy 覆盖成 unreachable。
      if (socket !== current) return;
      socket = undefined;
      readySocket = undefined;
      clearConnectionTimers();
      if (closed || halted) return;
      const code = closeCode(event);
      if (code === WS_CLOSE_UNAUTHORIZED || code === 401) {
        halt('unauthorized', 'unauthorized');
        return;
      }
      if (code === WS_CLOSE_INCOMPATIBLE || code === 400) {
        halt('incompatible', 'incompatible');
        return;
      }
      setStatus('unreachable', 'disconnected');
      scheduleReconnect();
    });

    current.addEventListener('error', () => {
      dropAndReconnect(current, 'connection_error');
    });
  }

  function startConnect(): void {
    if (closed || halted || socket !== undefined || starting) return;

    if (caFile === undefined) {
      let current: WebSocketLike;
      try {
        current = wsFactory(url);
      } catch (error) {
        logger?.warn('hub.node.connect_failed', {
          node_id: nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
        setStatus('unreachable', 'connect_failed');
        scheduleReconnect();
        return;
      }
      socket = current;
      open(current);
      return;
    }

    starting = true;
    void (async () => {
      let ca: string;
      try {
        ca = await readCaFile(caFile);
      } catch (error) {
        starting = false;
        logger?.warn('hub.node.ca_read_failed', {
          node_id: nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
        setStatus('unreachable', 'ca_read_failed');
        scheduleReconnect();
        return;
      }
      starting = false;
      if (closed || halted || socket !== undefined) return;
      let current: WebSocketLike;
      try {
        current = wsFactory(url, { ca });
      } catch (error) {
        logger?.warn('hub.node.connect_failed', {
          node_id: nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
        setStatus('unreachable', 'connect_failed');
        scheduleReconnect();
        return;
      }
      socket = current;
      open(current);
    })();
  }

  startConnect();

  return {
    close(): void {
      if (closed) return;
      closed = true;
      reconnectTimer = clearTimer(reconnectTimer);
      directoryTimer = clearTimer(directoryTimer);
      clearConnectionTimers();
      const current = socket;
      socket = undefined;
      readySocket = undefined;
      if (unsubscribe !== undefined) {
        try {
          unsubscribe();
        } catch {
          // best-effort
        }
        unsubscribe = undefined;
      }
      if (current) {
        try {
          current.close();
        } catch {
          // best-effort
        }
      }
    },
    status(): HubNodeOutboundStatus {
      return status;
    },
    lastHelloAt(): number | undefined {
      return helloAt;
    },
    attempt(): number {
      return attempt;
    },
  };
}
