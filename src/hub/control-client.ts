/**
 * Hub → Node control 客户端（S5 / `vessel.hub/1`）。
 *
 * - 连接 `${record.url}/v1/hub/control`，open 后首帧 auth；
 * - 处理 `hello` / `snapshot` / `pointer` / `ping`，回 `pong`；
 * - 新旧判定按 `(incarnation, revision)`：hello 的 incarnation 变化时无条件
 *   接受下一个 snapshot 并重置 revision 比较；否则只接受更大的 revision；
 * - 身份校验：hello / snapshot 的 `node_id` 必须等于记录值、`hub_id` 必须
 *   等于本地 hub；不一致 → `identity_mismatch` 并断开，不更新目录；
 * - 401/4401 → `unauthorized`；4400 / 协议不符 → `incompatible`；
 * - 网络失败或静默 30s → `unreachable`，指数退避 1s→30s（0.8–1.2 jitter）；
 * - 只接受元数据帧；不解析 / 不保存任何 RunEvent 或正文。
 *
 * @module vessel/hub/control-client
 */

import type { Logger } from '@vessel-agent/core';
import {
  HUB_PROTOCOL,
  type HubAgentMeta,
  type HubTeamMeta,
  isHubProtocol,
  parseHubAgentMeta,
  parseHubPointerReason,
  parseHubTeamMeta,
} from '@vessel-agent/serve';
import type { WebSocketFactory, WebSocketLike } from '../rpc/index.js';
import type { HubNodeRecord, HubNodeStatus } from './types.js';

/** 状态子集：control 客户端自己会报告的状态。 */
export type HubControlStatus = Extract<
  HubNodeStatus,
  'healthy' | 'unreachable' | 'incompatible' | 'unauthorized' | 'identity_mismatch'
>;

/** 已接受的 snapshot（元数据；与 `HubSnapshotFrame` 字段对齐）。 */
export interface HubControlSnapshot {
  node_id: string;
  hub_id: string;
  incarnation: string;
  revision: number;
  observed_at: number;
  truncated: boolean;
  counts: { teams: number; agents: number; live_agents: number };
  teams: HubTeamMeta[];
  agents: HubAgentMeta[];
}

/** 指针（元数据；不携带正文）。 */
export interface HubControlPointer {
  node_id: string;
  hub_id: string;
  team_id: string;
  request_id?: string;
  reason: NonNullable<ReturnType<typeof parseHubPointerReason>>;
  ts: number;
}

export interface HubControlClientOptions {
  record: HubNodeRecord;
  viewToken: string;
  hubId: string;
  /** 测试注入；缺省使用全局 WebSocket。 */
  wsFactory?: WebSocketFactory;
  now?: () => number;
  onSnapshot?: (snapshot: HubControlSnapshot) => void;
  onPointer?: (pointer: HubControlPointer) => void;
  onStatus?: (status: HubControlStatus) => void;
  logger?: Logger;
  /** 等待 hello 的上限（默认 10000ms） */
  helloTimeoutMs?: number;
  /** 静默上限（默认 30000ms） */
  idleTimeoutMs?: number;
  /** 退避参数（默认 1000 / 30000） */
  reconnect?: { initialMs?: number; maxMs?: number };
  /** 读取 ca_file 的实现；缺省 Bun.file。 */
  readCaFile?: (path: string) => Promise<string>;
}

export interface HubControlClient {
  /** 幂等关闭；不再重连。 */
  close(): void;
  status(): HubNodeStatus;
  /** 最近一次收到帧的时间（`now()` 时钟）；未收到为 undefined。 */
  lastSeen(): number | undefined;
  /** 当前退避尝试次数（收到 hello 后归零）。 */
  attempt(): number;
}

const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_WS_CLOSE_UNAUTHORIZED = 4401;
const DEFAULT_WS_CLOSE_INCOMPATIBLE = 4400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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

function parseCounts(value: unknown): HubControlSnapshot['counts'] | undefined {
  if (!isRecord(value)) return undefined;
  const teams = value.teams;
  const agents = value.agents;
  const live = value.live_agents;
  if (!isFiniteNumber(teams) || !isFiniteNumber(agents) || !isFiniteNumber(live)) {
    return undefined;
  }
  if (teams < 0 || agents < 0 || live < 0) return undefined;
  return {
    teams: Math.floor(teams),
    agents: Math.floor(agents),
    live_agents: Math.floor(live),
  };
}

function controlUrl(url: string): string {
  return `${url.replace(/^http/, 'ws')}/v1/hub/control`;
}

/** 创建并立即启动 control 客户端。 */
export function createHubControlClient(options: HubControlClientOptions): HubControlClient {
  const { record, viewToken, hubId, logger } = options;
  const clock = options.now ?? Date.now;
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const initialMs = options.reconnect?.initialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
  const maxMs = options.reconnect?.maxMs ?? DEFAULT_RECONNECT_MAX_MS;
  const readCaFile = options.readCaFile ?? ((path: string) => Bun.file(path).text());
  const wsFactory: WebSocketFactory =
    options.wsFactory ??
    ((url, tls) => new WebSocket(url, (tls ? { tls } : {}) as never) as unknown as WebSocketLike);

  let closed = false;
  /** 致命状态（unauthorized / incompatible / identity_mismatch）：不再重连。 */
  let halted = false;
  let socket: WebSocketLike | undefined;
  let status: HubNodeStatus = 'connecting';
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let lastSeenAt: number | undefined;
  let starting = false;

  let currentIncarnation = record.incarnation;
  let lastRevision = record.revision ?? -1;
  let forceAcceptNext = false;

  function setStatus(next: HubControlStatus): void {
    if (status === next) return;
    status = next;
    try {
      options.onStatus?.(next);
    } catch (error) {
      logger?.warn('hub.control.status_listener_failed', {
        error: error instanceof Error ? error.message : String(error),
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

  function halt(next: HubControlStatus): void {
    halted = true;
    setStatus(next);
    const current = socket;
    socket = undefined;
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

  function dropAndReconnect(current: WebSocketLike): void {
    if (socket !== current) return;
    socket = undefined;
    clearConnectionTimers();
    try {
      current.close();
    } catch {
      // best-effort
    }
    if (closed || halted) return;
    setStatus('unreachable');
    scheduleReconnect();
  }

  function resetIdleTimer(current: WebSocketLike): void {
    idleTimer = clearTimer(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (closed || halted || socket !== current) return;
      logger?.debug?.('hub.control.idle_timeout', { node_id: record.node_id });
      dropAndReconnect(current);
    }, idleTimeoutMs);
    (idleTimer as { unref?: () => void }).unref?.();
  }

  function send(current: WebSocketLike, frame: unknown): void {
    try {
      current.send(JSON.stringify(frame));
    } catch {
      dropAndReconnect(current);
    }
  }

  function handleHello(current: WebSocketLike, frame: Record<string, unknown>): void {
    helloTimer = clearTimer(helloTimer);
    if (frame.node_id !== record.node_id || frame.hub_id !== hubId) {
      logger?.warn('hub.control.identity_mismatch', { node_id: record.node_id });
      halt('identity_mismatch');
      return;
    }
    attempt = 0;
    const incarnation = typeof frame.incarnation === 'string' ? frame.incarnation : '';
    if (incarnation !== currentIncarnation) {
      // 节点重启：下一个 snapshot 无条件接受，并重置 revision 比较。
      currentIncarnation = incarnation;
      forceAcceptNext = true;
    }
    setStatus('healthy');
    resetIdleTimer(current);
  }

  function handleSnapshot(current: WebSocketLike, frame: Record<string, unknown>): void {
    if (frame.node_id !== record.node_id || frame.hub_id !== hubId) {
      logger?.warn('hub.control.identity_mismatch', { node_id: record.node_id });
      halt('identity_mismatch');
      return;
    }
    const revision = frame.revision;
    if (!isFiniteNumber(revision) || revision < 0) return;
    const counts = parseCounts(frame.counts);
    if (!counts) return;
    if (typeof frame.truncated !== 'boolean') return;

    const incarnation = typeof frame.incarnation === 'string' ? frame.incarnation : '';
    const changed = forceAcceptNext || (incarnation !== '' && incarnation !== currentIncarnation);
    if (!changed && revision <= lastRevision) {
      logger?.debug?.('hub.control.stale_snapshot', {
        node_id: record.node_id,
        revision,
        last_revision: lastRevision,
      });
      return;
    }

    forceAcceptNext = false;
    if (incarnation !== '') currentIncarnation = incarnation;
    lastRevision = revision;

    const teams: HubTeamMeta[] = [];
    if (Array.isArray(frame.teams)) {
      for (const item of frame.teams) {
        const team = parseHubTeamMeta(item);
        if (team) teams.push(team);
      }
    }
    const agents: HubAgentMeta[] = [];
    if (Array.isArray(frame.agents)) {
      for (const item of frame.agents) {
        const agent = parseHubAgentMeta(item);
        if (agent) agents.push(agent);
      }
    }

    const snapshot: HubControlSnapshot = {
      node_id: frame.node_id,
      hub_id: frame.hub_id,
      incarnation,
      revision: Math.floor(revision),
      observed_at: isFiniteNumber(frame.observed_at) ? frame.observed_at : clock(),
      truncated: frame.truncated,
      counts,
      teams,
      agents,
    };

    setStatus('healthy');
    resetIdleTimer(current);
    try {
      options.onSnapshot?.(snapshot);
    } catch (error) {
      logger?.warn('hub.control.snapshot_listener_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function handlePointer(current: WebSocketLike, frame: Record<string, unknown>): void {
    // 指针也做身份校验；不匹配时只丢弃，不更新目录。
    if (frame.node_id !== record.node_id || frame.hub_id !== hubId) {
      logger?.warn('hub.control.pointer_identity_mismatch', { node_id: record.node_id });
      return;
    }
    if (typeof frame.team_id !== 'string' || frame.team_id === '') return;
    const reason = parseHubPointerReason(frame.reason);
    if (!reason) return;
    const pointer: HubControlPointer = {
      node_id: frame.node_id,
      hub_id: frame.hub_id,
      team_id: frame.team_id,
      reason,
      ts: isFiniteNumber(frame.ts) ? frame.ts : clock(),
    };
    if (typeof frame.request_id === 'string' && frame.request_id !== '') {
      pointer.request_id = frame.request_id;
    }
    resetIdleTimer(current);
    try {
      options.onPointer?.(pointer);
    } catch (error) {
      logger?.warn('hub.control.pointer_listener_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function handleFrame(current: WebSocketLike, data: unknown): void {
    if (closed || halted || socket !== current) return;
    const text = textOf(data);
    if (text === undefined) return;
    const frame = safeParse(text);
    if (!isRecord(frame)) return;
    lastSeenAt = clock();

    if (frame.v !== 1 || !isHubProtocol(frame.protocol)) {
      logger?.warn('hub.control.incompatible_frame', { node_id: record.node_id });
      halt('incompatible');
      return;
    }

    switch (frame.kind) {
      case 'hello':
        handleHello(current, frame);
        return;
      case 'snapshot':
        handleSnapshot(current, frame);
        return;
      case 'pointer':
        handlePointer(current, frame);
        return;
      case 'ping':
        resetIdleTimer(current);
        send(current, { v: 1, kind: 'pong', protocol: HUB_PROTOCOL, dialer: 'hub' });
        return;
      case 'pong':
        // 心跳应答；idle timer 已由 message 事件重置。
        return;
      default:
        // 未知元数据帧：忽略，不做正文解析。
        return;
    }
  }

  function open(current: WebSocketLike): void {
    current.addEventListener('open', () => {
      if (closed || halted || socket !== current) return;
      send(current, {
        v: 1,
        kind: 'auth',
        protocol: HUB_PROTOCOL,
        dialer: 'hub',
        token: viewToken,
        hub_id: hubId,
      });
      helloTimer = setTimeout(() => {
        helloTimer = undefined;
        if (closed || halted || socket !== current) return;
        logger?.warn('hub.control.hello_timeout', { node_id: record.node_id });
        dropAndReconnect(current);
      }, helloTimeoutMs);
      (helloTimer as { unref?: () => void }).unref?.();
      resetIdleTimer(current);
    });

    current.addEventListener('message', (event: { data: unknown }) => {
      handleFrame(current, event.data);
    });

    current.addEventListener('close', (event?: unknown) => {
      if (socket !== current) return;
      socket = undefined;
      clearConnectionTimers();
      if (closed || halted) return;
      const code = closeCode(event);
      if (code === DEFAULT_WS_CLOSE_UNAUTHORIZED || code === 401) {
        halt('unauthorized');
        return;
      }
      if (code === DEFAULT_WS_CLOSE_INCOMPATIBLE || code === 400) {
        halt('incompatible');
        return;
      }
      setStatus('unreachable');
      scheduleReconnect();
    });

    current.addEventListener('error', () => {
      dropAndReconnect(current);
    });
  }

  function startConnect(): void {
    if (closed || halted || socket !== undefined || starting) return;
    const url = controlUrl(record.url);

    if (record.ca_file === undefined) {
      let current: WebSocketLike;
      try {
        current = wsFactory(url);
      } catch (error) {
        logger?.warn('hub.control.connect_failed', {
          node_id: record.node_id,
          error: error instanceof Error ? error.message : String(error),
        });
        setStatus('unreachable');
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
        ca = await readCaFile(record.ca_file as string);
      } catch (error) {
        starting = false;
        logger?.warn('hub.control.ca_read_failed', {
          node_id: record.node_id,
          error: error instanceof Error ? error.message : String(error),
        });
        setStatus('unreachable');
        scheduleReconnect();
        return;
      }
      starting = false;
      if (closed || halted || socket !== undefined) return;
      let current: WebSocketLike;
      try {
        current = wsFactory(url, { ca });
      } catch (error) {
        logger?.warn('hub.control.connect_failed', {
          node_id: record.node_id,
          error: error instanceof Error ? error.message : String(error),
        });
        setStatus('unreachable');
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
      clearConnectionTimers();
      const current = socket;
      socket = undefined;
      if (current) {
        try {
          current.close();
        } catch {
          // best-effort
        }
      }
    },
    status(): HubNodeStatus {
      return status;
    },
    lastSeen(): number | undefined {
      return lastSeenAt;
    },
    attempt(): number {
      return attempt;
    },
  };
}
