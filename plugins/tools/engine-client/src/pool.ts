/**
 * PoolTransport（engine-pool 契约 S8 / S15 / S16 / S17 + 修正案 R1.2 / R1.3）。
 *
 * node 侧数据面客户端：实现既有 EngineTransport 端口（protocol.ts）⇒ forward.ts /
 * registry.ts / client.ts / mcp-engine-wiring.ts 消费面零改动。gateway 发布 routing.json
 * （S5 唯一写者）；本模块 fs.watch + 5s poll + 数据面失败即刷，对 ready engine eager 直连
 * （engine 侧每 data 连接 = 一个 NodeScope，S19）。路由三步：亲和过滤（S15 绑定表）→
 * 健康/熔断过滤 → P2C（node 本地在途计数，不依赖 gateway 全局负载）。
 *
 * 帧泵 = S10 codec 单实现（@vessel-agent/serve attachNdjsonReader / createNdjsonWriter）；
 * pending 关联 / 稳定错误码 / 重试安全由本消费方自持。wire 字段一律取自 protocol.ts
 * （ENGINE_WIRE / EngineAuthFrame / ENGINE_BUSY_CODE / ENGINE_ERROR），禁第二份序列化。
 *
 * 重试安全（S17 冻结白名单 = 证明未执行/未派发）：busy 快拒（派发前）/ connect 失败 /
 * 错 engine not_registered / callback 且 host oracle pendingState==='pending'。
 * **worker 派发后失联绝不自动重试**（副作用未知）；busy 不计熔断；全候选不可用 →
 * throw ENGINE_ERROR.unavailable（不静默回退 in-process，supervisor 纪律）。
 *
 * 解释项（PLAN §5，已批）：(a) ping 双角色——data 连接心跳应答；(b) TCP close 码只是
 * 诊断标签——node 侧 auth 期 close 一律按可重试连接失败退避 1s→30s。
 *
 * @module @vessel-agent/engine-client
 */

import { type FSWatcher, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { type Logger, noopLogger } from '@vessel-agent/core';
import type { McpServerConfig, McpServerStatus } from '@vessel-agent/mcp-client';
import { attachNdjsonReader, createNdjsonWriter } from '@vessel-agent/serve';
import { isRecord, type PendingState, pendingKey } from './pending.js';
import {
  ENGINE_BUSY_CODE,
  ENGINE_ERROR,
  ENGINE_MAX_MESSAGE_BYTES,
  ENGINE_WIRE,
  type EngineAuthFrame,
  type EngineHealthParams,
  type EngineTransport,
  type McpConfigureServerResult,
  type McpControlResult,
  type RegistrySyncResult,
  type ToolInvokeParams,
} from './protocol.js';

// ── 冻结常量（S8；逐字对契约，调参须另批） ─────────────────────

/** 心跳 ping 间隔（child.ts:31 同值）。 */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** 心跳 ping 超时（child.ts:31 同值）；超时 → 回收连接（child fail 同口径）。 */
const HEARTBEAT_TIMEOUT_MS = 15_000;
/** 熔断阈值 = 连续 3 次传输层失败（busy 不计入）。 */
const BREAKER_THRESHOLD = 3;
/** 熔断冷却 5s→30s 指数 + jitter（hub 重连退避同汇）。 */
const BREAKER_COOLDOWN_BASE_MS = 5_000;
const BREAKER_COOLDOWN_CAP_MS = 30_000;
/** 重试预算 min(3, 候选数)（重试次数，首发之外）。 */
const RETRY_MAX = 3;
/** 重试退避 50–200ms jitter。 */
const RETRY_BACKOFF_MIN_MS = 50;
const RETRY_BACKOFF_MAX_MS = 200;
/** 路由 poll 5s（fs.watch / 数据面失败即刷之外的兜底）。 */
const ROUTING_POLL_MS = 5_000;
/** 重连退避 1s→30s + jitter（auth 期 close 一律可重试，解释 (b)）。 */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
/** auth 超时 5s（S2；engine 侧同值）。 */
const AUTH_TIMEOUT_MS = 5_000;
/** 回环 bind 物理表达（远程 engine 仍禁止，§3.6）。 */
const LOOPBACK_HOST = '127.0.0.1';

// ── 冻结签名（S8 + 修正案 R1.2 / R1.3） ───────────────────────

export interface PoolTransportOptions {
  poolDir: string;
  nodeId: string;
  incarnation: number;
  dirs: { dataDir: string; toolOutputDir: string };
  /** host 账本 source 查询（亲和过滤用；'mcp:<server>' / 'basic-tools' / 入口名）。 */
  getSource(toolName: string): string | undefined;
  /** callback 续上 oracle（S9）。 */
  pendingState(runId: string, toolCallId: string): PendingState | undefined;
  logger?: Logger;
  /** 连接转健康时触发（含重连 / respawn 恢复）；装配层复用现态 reconcile+pushRegistry 闭包（S20）。 */
  onConnectionReady?: () => void;
  /** engine→host tool.callback 受限反向请求：host 按在途记录执行原 handler（关联-only fail-closed）。 */
  onToolCallback?(params: unknown): Promise<unknown>;
  /** engine→host 通知（engine.impl.swapped / engine.health）：host 指纹对拍 / health 缓存读面。 */
  onEngineNotification?(method: string, params: unknown): void;
}

export interface PoolTransport extends EngineTransport {
  dispose(): void;
}

// ── 内部形状（S5 读面 / 熔断 / 连接槽；不导出） ────────────────

/** S5 routing.json 引擎条目（gateway 只发布 data_token；机械校验，形状不过忽略）。 */
interface RoutingEngineEntry {
  id: string;
  port: number;
  data_token: string;
  status: 'ready' | 'draining' | 'disabled';
}

interface RoutingSnapshot {
  epoch: string;
  revision: number;
  engines: RoutingEngineEntry[];
}

/** 熔断器（per-node per-engine）：closed → open（连续 3 次传输层失败）→ half-open 单探测。 */
interface Breaker {
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  /** 连续 open 次数（冷却指数 5s→10s→20s→30s cap）；探测成功清零。 */
  opens: number;
  cooldownUntil: number;
  probeInFlight: boolean;
}

/** 每 engine 槽位：路由条目 + 当前连接 + 熔断 + 重连退避 + node 本地在途计数。 */
interface EngineSlot {
  id: string;
  entry: RoutingEngineEntry;
  inRouting: boolean;
  link: Link | undefined;
  dialing: boolean;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** 在途计数 = 本 node 发出未收口 invoke 数（发出 +1 / settle −1）。 */
  inflight: number;
  breaker: Breaker;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** 一条已鉴权 data 连接（帧泵 = S10 codec；pending 关联本消费方自持）。 */
interface Link {
  readonly port: number;
  readonly token: string;
  closed: boolean;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): void;
  destroy(): void;
}

/** S17 证明未派发：连接未就绪 / 熔断 gate 拦截（字节未发出）→ connect 失败可重试。 */
class NotDispatchedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotDispatchedError';
  }
}

/** JSON-RPC error 回包（engine 已应答，传输层健康）；code = 原 error.code（busy 按 code 拦截）。 */
class RpcResponseError extends Error {
  readonly code: number | undefined;
  constructor(code: number | undefined, message: string) {
    super(message);
    this.name = 'RpcResponseError';
    this.code = code;
  }
}

/** 派发后传输层失联（连接被关 / 请求超时 / codec 违约）：worker 绝不自动重试（S17）。 */
class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 指数退避 + jitter（hub outbound-client scheduleReconnect 同汇：[0.8x, 1.2x]）。 */
function jitteredBackoff(baseMs: number, capMs: number, attempt: number): number {
  const capped = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 16));
  return Math.round(capped * (0.8 + Math.random() * 0.4));
}

function retryBackoff(): Promise<void> {
  const delay =
    RETRY_BACKOFF_MIN_MS + Math.random() * (RETRY_BACKOFF_MAX_MS - RETRY_BACKOFF_MIN_MS);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/** S5 机械校验（形状不过 → undefined → 忽略，保留 last-known-good）。 */
function parseRoutingSnapshot(value: unknown): RoutingSnapshot | undefined {
  if (!isRecord(value) || value.v !== 1) return undefined;
  if (typeof value.epoch !== 'string' || value.epoch === '') return undefined;
  if (typeof value.revision !== 'number' || !Number.isFinite(value.revision)) return undefined;
  if (typeof value.updated_at !== 'number' || !Number.isFinite(value.updated_at)) return undefined;
  if (!Array.isArray(value.engines)) return undefined;
  const engines: RoutingEngineEntry[] = [];
  for (const item of value.engines) {
    if (!isRecord(item)) return undefined;
    if (typeof item.id !== 'string' || item.id === '') return undefined;
    if (typeof item.port !== 'number' || !Number.isInteger(item.port) || item.port <= 0) {
      return undefined;
    }
    if (typeof item.data_token !== 'string' || item.data_token === '') return undefined;
    if (item.status !== 'ready' && item.status !== 'draining' && item.status !== 'disabled') {
      return undefined;
    }
    engines.push({
      id: item.id,
      port: item.port,
      data_token: item.data_token,
      status: item.status,
    });
  }
  return { epoch: value.epoch, revision: value.revision, engines };
}

/** P2C：随机 2 选 node 本地在途少者（相等随机）；候选唯一退化（无选择）。 */
function p2c(candidates: EngineSlot[]): EngineSlot | undefined {
  const n = candidates.length;
  if (n === 0) return undefined;
  if (n === 1) return candidates[0];
  const i = Math.floor(Math.random() * n);
  let j = Math.floor(Math.random() * (n - 1));
  if (j >= i) j += 1;
  const a = candidates[i];
  const b = candidates[j];
  if (a === undefined || b === undefined) return a ?? b;
  if (a.inflight !== b.inflight) return a.inflight < b.inflight ? a : b;
  return Math.random() < 0.5 ? a : b;
}

// ── 组件 ─────────────────────────────────────────────────────

export function createPoolTransport(options: PoolTransportOptions): PoolTransport {
  const logger = options.logger ?? noopLogger;
  const routingPath = join(options.poolDir, 'routing.json');

  const slots = new Map<string, EngineSlot>();
  /** S15 绑定表：per-(node,server)（本实例即一个 node）；configure = 绑定建立点。 */
  let bindings = new Map<string, string>();
  /** S8 call→engine 映射（键 = pendingKey；settle 即清）：tool.cancel 定点用。 */
  const callEngine = new Map<string, string>();
  /** abort 标记（tool.cancel notify 到达时记；worker 无 oracle，重试前查此终止）。 */
  const cancelledKeys = new Set<string>();

  let disposed = false;
  let currentEpoch: string | undefined;
  let lastRevision = -1;
  /** 已退役纪元（UUID 无序；见过的旧 epoch 不再接受 = 忽略旧 epoch，S5 fencing）。 */
  const retiredEpochs = new Set<string>();
  let refreshInFlight = false;
  let watcher: FSWatcher | undefined;
  let watchDebounce: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  // ── 熔断（busy 不计；传输层失败连续 3 次 → open；half-open 单探测） ──

  function cooldownMs(opens: number): number {
    return jitteredBackoff(BREAKER_COOLDOWN_BASE_MS, BREAKER_COOLDOWN_CAP_MS, opens - 1);
  }

  /** open 冷却到期 → half-open（lazy 转移；候选过滤与心跳共用）。 */
  function refreshBreaker(slot: EngineSlot): void {
    const breaker = slot.breaker;
    if (breaker.state === 'open' && Date.now() >= breaker.cooldownUntil) {
      breaker.state = 'half-open';
      breaker.probeInFlight = false;
    }
  }

  /** 传输层健康应答（含 busy / 业务 error 回包——engine 应答即传输活）：清零连续失败。 */
  function recordSuccess(slot: EngineSlot): void {
    const breaker = slot.breaker;
    breaker.failures = 0;
    breaker.probeInFlight = false;
    if (breaker.state === 'half-open') {
      breaker.state = 'closed';
      breaker.opens = 0;
      fireConnectionReady();
    }
  }

  /** 传输层失败（连接被关 / dial 失败 / registry.sync 坏 ack）：busy 永不进这里。 */
  function recordFailure(slot: EngineSlot): void {
    const breaker = slot.breaker;
    breaker.failures += 1;
    breaker.probeInFlight = false;
    if (breaker.state === 'half-open') {
      breaker.state = 'open';
      breaker.opens += 1;
      breaker.cooldownUntil = Date.now() + cooldownMs(breaker.opens);
    } else if (breaker.state === 'closed' && breaker.failures >= BREAKER_THRESHOLD) {
      breaker.state = 'open';
      breaker.opens += 1;
      breaker.cooldownUntil = Date.now() + cooldownMs(breaker.opens);
    }
  }

  /** 候选谓词：路由 ready ∧ 熔断 closed/half-open（单探测 gate）∧ 连接活（S8 步骤②）。 */
  function usable(slot: EngineSlot): boolean {
    if (!slot.inRouting || slot.entry.status !== 'ready') return false;
    if (slot.link === undefined || slot.link.closed) return false;
    refreshBreaker(slot);
    const breaker = slot.breaker;
    return breaker.state === 'closed' || (breaker.state === 'half-open' && !breaker.probeInFlight);
  }

  function healthySlots(): EngineSlot[] {
    return [...slots.values()].filter(usable);
  }

  function fireConnectionReady(): void {
    const hook = options.onConnectionReady;
    if (hook === undefined) return;
    try {
      hook();
    } catch (error) {
      logger.error('engine pool onConnectionReady failed', { message: errorMessage(error) });
    }
  }

  // ── 请求发送（half-open 单探测 gate + 传输层分类；熔断记账单点） ──

  function sendRequest(
    slot: EngineSlot,
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    const link = slot.link;
    if (disposed || link === undefined || link.closed) {
      return Promise.reject(new NotDispatchedError('engine connection not ready'));
    }
    refreshBreaker(slot);
    const breaker = slot.breaker;
    if (breaker.state === 'open') {
      return Promise.reject(new NotDispatchedError('engine circuit breaker is open'));
    }
    if (breaker.state === 'half-open') {
      if (breaker.probeInFlight) {
        return Promise.reject(new NotDispatchedError('engine half-open probe in flight'));
      }
      breaker.probeInFlight = true;
    }
    return link.request(method, params, timeoutMs).then(
      (value) => {
        recordSuccess(slot);
        return value;
      },
      (error: unknown) => {
        if (error instanceof RpcResponseError) {
          // engine 应答 error 回包 = 传输层健康（busy 是背压不是故障，S3/Q6）。
          recordSuccess(slot);
        } else if (!(error instanceof TransportError) && slot.breaker.state === 'half-open') {
          // NotDispatched / 出站超限：探测无结论，保持 half-open（失联已由 close 记账）。
          slot.breaker.probeInFlight = false;
        }
        throw error;
      },
    );
  }

  // ── 连接生命周期（dial / auth / 心跳 / 重连退避） ─────────────

  function scheduleReconnect(slot: EngineSlot): void {
    if (disposed || !slot.inRouting || slot.entry.status !== 'ready') return;
    if (slots.get(slot.id) !== slot) return;
    if (slot.reconnectTimer !== undefined || slot.dialing || slot.link !== undefined) return;
    const delay = jitteredBackoff(RECONNECT_BASE_MS, RECONNECT_CAP_MS, slot.reconnectAttempts);
    slot.reconnectAttempts += 1;
    slot.reconnectTimer = setTimeout(() => {
      slot.reconnectTimer = undefined;
      dialSlot(slot);
    }, delay);
  }

  function startHeartbeat(slot: EngineSlot): void {
    if (slot.heartbeatTimer !== undefined) clearInterval(slot.heartbeatTimer);
    slot.heartbeatTimer = setInterval(() => {
      const link = slot.link;
      if (disposed || link === undefined || link.closed) {
        if (slot.heartbeatTimer !== undefined) {
          clearInterval(slot.heartbeatTimer);
          slot.heartbeatTimer = undefined;
        }
        return;
      }
      refreshBreaker(slot);
      if (slot.breaker.state === 'open') return;
      if (slot.breaker.state === 'half-open' && slot.breaker.probeInFlight) return;
      // ping 双角色（解释 (a)）：data 连接心跳；half-open 时充当单探测。
      void sendRequest(slot, 'ping', {}, HEARTBEAT_TIMEOUT_MS).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * 拨号 data 连接：首行 S2 auth 帧（data role + node_id + incarnation + dirs），
   * 回包 `{ok:true}` 后进入 JSON-RPC 面。失败 close（不返回错误帧）；node 侧 auth 期
   * close 一律按可重试连接失败（解释 (b)：退避 1s→30s）。入站分发逐字镜像 child.ts
   * handleIncoming 先例 + 修正案 R1.3（未注入 hook → fail-closed 拒）。
   */
  function dialSlot(slot: EngineSlot): void {
    if (disposed || slot.dialing || slot.link !== undefined) return;
    if (slots.get(slot.id) !== slot || !slot.inRouting || slot.entry.status !== 'ready') return;
    slot.dialing = true;
    const entry = slot.entry;
    const socket: Socket = createConnection({ host: LOOPBACK_HOST, port: entry.port });
    socket.setNoDelay(true);

    const pending = new Map<string, PendingRequest>();
    let nextId = 1;
    let authenticated = false;
    let dialSettled = false;

    const writer = createNdjsonWriter(socket, {
      maxBytes: ENGINE_MAX_MESSAGE_BYTES,
      // 写端不产生入站帧；出站超限由调用方把 false 折回（child.ts 同口径）。
      onFrame: () => {},
      onViolation: () => {},
    });

    function writeFrame(frame: Record<string, unknown>): boolean {
      return socket.destroyed ? false : writer.writeFrame(frame);
    }

    function writeResult(id: unknown, result: unknown): void {
      // 出站超限折 error 回包（entry.ts writeResult 先例）：engine 侧 callback 收口不卡。
      if (!writeFrame({ jsonrpc: '2.0', id, result })) {
        writeFrame({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: 'tool.callback result exceeds the message size limit' },
        });
      }
    }

    function writeError(id: unknown, code: number, message: string): void {
      writeFrame({ jsonrpc: '2.0', id, error: { code, message } });
    }

    const link: Link = {
      port: entry.port,
      token: entry.data_token,
      closed: false,
      request(method, params, timeoutMs) {
        if (link.closed || !authenticated) {
          return Promise.reject(new NotDispatchedError('engine connection not ready'));
        }
        const id = nextId;
        nextId += 1;
        return new Promise<unknown>((resolve, reject) => {
          // timeoutMs 缺省 = 不设 per-request timer（心跳守活；端口现态语义）。
          const timer =
            timeoutMs === undefined
              ? undefined
              : setTimeout(() => {
                  pending.delete(String(id));
                  reject(new TransportError(`${method} timed out after ${timeoutMs}ms`));
                  // 请求超时 → 回收连接（child fail 同口径）；close 单点记账。
                  close();
                }, timeoutMs);
          pending.set(String(id), { method, resolve, reject, timer });
          if (!writeFrame({ jsonrpc: '2.0', id, method, params })) {
            pending.delete(String(id));
            if (timer !== undefined) clearTimeout(timer);
            // 出站超限：确定性失败（字节未发出），不重试不计熔断，折稳定错误。
            reject(new Error(`${method} request frame exceeds ${ENGINE_MAX_MESSAGE_BYTES} bytes`));
          }
        });
      },
      notify(method, params) {
        if (link.closed || !authenticated) return;
        // fire-and-forget；超限 / 不在跑时静默丢弃（cancel 是 best-effort）。
        writeFrame({ jsonrpc: '2.0', method, params });
      },
      destroy() {
        close();
      },
    };

    function settle(id: string, frame: Record<string, unknown>): void {
      const request = pending.get(id);
      if (request === undefined) return;
      pending.delete(id);
      if (request.timer !== undefined) clearTimeout(request.timer);
      if (frame.error !== undefined) {
        const code =
          isRecord(frame.error) && typeof frame.error.code === 'number'
            ? frame.error.code
            : undefined;
        const message =
          isRecord(frame.error) && typeof frame.error.message === 'string'
            ? frame.error.message
            : `Remote ${request.method} failed.`;
        request.reject(new RpcResponseError(code, message));
        return;
      }
      request.resolve(frame.result);
    }

    /** 入站分发（R1.3）：callback → hook 执行回包 / impl.swapped+health → hook / ping → pong / 其余 -32601。 */
    function dispatchFrame(frame: Record<string, unknown>): void {
      const method = typeof frame.method === 'string' ? frame.method : undefined;
      const rawId = frame.id;
      const id = typeof rawId === 'number' || typeof rawId === 'string' ? String(rawId) : null;
      if (method === undefined) {
        if (id !== null && (frame.result !== undefined || frame.error !== undefined)) {
          settle(id, frame);
        }
        return;
      }
      if (method === 'pong') return;
      if (method === 'ping') {
        if (id !== null) writeResult(id, { pong: true });
        return;
      }
      if (method === ENGINE_WIRE.toolCallback) {
        if (id === null) return;
        const hook = options.onToolCallback;
        // 未注入 hook → 按未知方法拒（child.ts:685 fail-closed 先例）：engine 不能注入任意调用。
        if (hook === undefined) {
          writeError(id, -32601, `Unknown method: ${method}`);
          return;
        }
        void Promise.resolve()
          .then(() => hook(frame.params))
          .then((result) => writeResult(id, result))
          .catch((error: unknown) => writeError(id, -32000, errorMessage(error)));
        return;
      }
      if (method === ENGINE_WIRE.implSwapped || method === ENGINE_WIRE.health) {
        options.onEngineNotification?.(method, frame.params);
        return;
      }
      if (id !== null) writeError(id, -32601, `Unknown method: ${method}`);
    }

    const reader = attachNdjsonReader(socket, {
      maxBytes: ENGINE_MAX_MESSAGE_BYTES,
      onFrame: (frame) => {
        if (!authenticated) {
          if (frame.ok === true) {
            authenticated = true;
            dialSettled = true;
            clearTimeout(authTimer);
            slot.dialing = false;
            if (disposed || slots.get(slot.id) !== slot) {
              //  dial 期间被除名 / dispose：不装连接（防孤儿 scope）。
              close();
              return;
            }
            slot.link = link;
            slot.reconnectAttempts = 0;
            startHeartbeat(slot);
            logger.info('engine pool connection ready', { id: slot.id, port: entry.port });
            // R1.2：连接转健康（含重连 / respawn 恢复）→ 装配层 reconcile+pushRegistry。
            fireConnectionReady();
          } else {
            close();
          }
          return;
        }
        dispatchFrame(frame);
      },
      // 残留超限 = 协议违规（host 出站同限守卫在先）：fail-closed 关连接。
      onViolation: () => close(),
    });

    const authTimer = setTimeout(() => {
      if (!authenticated) close();
    }, AUTH_TIMEOUT_MS);

    /** 单点收口：dial 失败 / 连接被关 / 超时回收 / dispose 全走这里（closed 幂等）。 */
    function close(): void {
      if (link.closed) return;
      link.closed = true;
      clearTimeout(authTimer);
      reader.close();
      socket.destroy();
      for (const request of pending.values()) {
        if (request.timer !== undefined) clearTimeout(request.timer);
        request.reject(new TransportError('engine connection closed'));
      }
      pending.clear();
      if (slot.link === link) {
        slot.link = undefined;
        if (slot.heartbeatTimer !== undefined) {
          clearInterval(slot.heartbeatTimer);
          slot.heartbeatTimer = undefined;
        }
      }
      slot.dialing = false;
      const wasDial = !dialSettled;
      dialSettled = true;
      // 一次失败事件 = 一次熔断记账（close 幂等保证单点）；busy 永不进这里。
      recordFailure(slot);
      if (wasDial) {
        logger.warn('engine pool dial failed', { id: slot.id, port: entry.port });
      }
      scheduleReconnect(slot);
      // 数据面失败即刷（S5 三触发之一）：发现替代成员，不等 poll。
      void refreshRouting();
    }

    socket.on('error', () => close());
    socket.on('close', () => close());
    socket.on('connect', () => {
      const auth: EngineAuthFrame = {
        kind: 'auth',
        role: 'data',
        token: entry.data_token,
        node_id: options.nodeId,
        incarnation: options.incarnation,
        dirs: { data_dir: options.dirs.dataDir, tool_output_dir: options.dirs.toolOutputDir },
      };
      if (!writeFrame({ ...auth })) close();
    });
  }

  // ── routing.json 消费（S5：epoch/revision fencing + 三触发刷新） ──

  function establishWatch(): void {
    if (disposed || watcher !== undefined) return;
    try {
      // watch 目录（atomicWrite rename 替换文件本体，目录 watch 不丢）；poll 兜底。
      watcher = watch(options.poolDir, { persistent: false }, (_event, filename) => {
        if (filename !== null && filename !== 'routing.json') return;
        if (watchDebounce !== undefined) clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => {
          watchDebounce = undefined;
          void refreshRouting();
        }, 100);
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      // poolDir 尚未创建（gateway 未起）：poll 兜底，刷新成功后自愈重 watch。
      watcher = undefined;
    }
  }

  async function refreshRouting(): Promise<void> {
    if (disposed || refreshInFlight) return;
    refreshInFlight = true;
    try {
      let raw: string;
      try {
        raw = await readFile(routingPath, 'utf8');
      } catch {
        return; // 读失败 ≠ 池空：last-known-good + 本地健康继续直连（gateway 宕机数据面存活）。
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      const snapshot = parseRoutingSnapshot(parsed);
      if (snapshot === undefined) return;
      // node fencing：忽略旧 epoch；同 epoch 忽略旧 revision（S5）。
      if (retiredEpochs.has(snapshot.epoch)) return;
      if (snapshot.epoch === currentEpoch && snapshot.revision < lastRevision) return;
      if (snapshot.epoch !== currentEpoch) {
        if (currentEpoch !== undefined) retiredEpochs.add(currentEpoch);
        currentEpoch = snapshot.epoch;
        lastRevision = -1;
      }
      lastRevision = snapshot.revision;
      applyRouting(snapshot.engines);
      establishWatch();
    } finally {
      refreshInFlight = false;
    }
  }

  function applyRouting(entries: RoutingEngineEntry[]): void {
    const next = new Map<string, RoutingEngineEntry>();
    for (const entry of entries) next.set(entry.id, entry);
    // 除名（respawn 换新 id / disabled 预算尽）：断连 + 停重连；在途 invoke 按 S17 处置。
    for (const [id, slot] of [...slots]) {
      if (next.has(id)) continue;
      slot.inRouting = false;
      if (slot.reconnectTimer !== undefined) {
        clearTimeout(slot.reconnectTimer);
        slot.reconnectTimer = undefined;
      }
      slot.link?.destroy();
      slots.delete(id);
    }
    for (const entry of next.values()) {
      let slot = slots.get(entry.id);
      if (slot === undefined) {
        slot = {
          id: entry.id,
          entry,
          inRouting: true,
          link: undefined,
          dialing: false,
          reconnectAttempts: 0,
          reconnectTimer: undefined,
          heartbeatTimer: undefined,
          inflight: 0,
          breaker: {
            state: 'closed',
            failures: 0,
            opens: 0,
            cooldownUntil: 0,
            probeInFlight: false,
          },
        };
        slots.set(entry.id, slot);
      } else {
        // 同 id 换 port/token（防御）：重建连接。
        if (
          slot.link !== undefined &&
          (slot.link.port !== entry.port || slot.link.token !== entry.data_token)
        ) {
          slot.link.destroy();
        }
        const wasReady = slot.entry.status === 'ready';
        slot.entry = entry;
        // draining → ready 恢复且连接仍在：转健康 → 对账（R1.2 语义）。
        if (!wasReady && entry.status === 'ready' && slot.link !== undefined && !slot.link.closed) {
          fireConnectionReady();
        }
      }
      slot.inRouting = true;
      if (entry.status === 'ready') {
        // eager 建连（N×M）；已在连 / 已排重连不重复拨。
        if (slot.link === undefined && !slot.dialing && slot.reconnectTimer === undefined) {
          dialSlot(slot);
        }
      } else {
        // draining = 路由降级 node 避让（Q6）：保留活连接让在途收口，停重连、不新拨。
        if (slot.reconnectTimer !== undefined) {
          clearTimeout(slot.reconnectTimer);
          slot.reconnectTimer = undefined;
        }
        if (entry.status === 'disabled') slot.link?.destroy();
      }
    }
  }

  // ── 逐方法路由（S8 冻结表） ─────────────────────────────────

  /**
   * tool.invoke 三步路由 + S17 重试安全。白名单四条 = 证明未执行/未派发：
   * busy 快拒 / connect 失败（NotDispatched）/ 错 engine not_registered / callback oracle pending。
   * worker 派发后失联（TransportError）绝不自动重试；callback state=executing/settled/缺失同。
   */
  async function routeInvoke(params: unknown, timeoutMs?: number): Promise<unknown> {
    if (
      !isRecord(params) ||
      typeof params.run_id !== 'string' ||
      typeof params.tool_call_id !== 'string' ||
      typeof params.tool_name !== 'string' ||
      (params.exec !== 'worker' && params.exec !== 'callback')
    ) {
      throw new Error(ENGINE_ERROR.invalidParams('tool.invoke envelope'));
    }
    const envelope = params as unknown as ToolInvokeParams;
    const key = pendingKey(envelope.run_id, envelope.tool_call_id);
    const source = options.getSource(envelope.tool_name);
    // 路由只特判 mcp:（解释 (e)）：命中 → 绑定唯一候选（硬亲和）；否则全候选。
    const affineServer = source?.startsWith('mcp:') ? source.slice('mcp:'.length) : undefined;

    const candidates = (): EngineSlot[] => {
      if (affineServer !== undefined) {
        const id = bindings.get(affineServer);
        const slot = id === undefined ? undefined : slots.get(id);
        return slot !== undefined && usable(slot) ? [slot] : [];
      }
      return healthySlots();
    };
    const nextTarget = (failed: EngineSlot): EngineSlot | undefined => {
      if (affineServer !== undefined) {
        // 亲和 busy / not_registered → 退避重试原 engine（S15；不换家、不重绑）。
        return usable(failed) ? failed : undefined;
      }
      return p2c(candidates().filter((slot) => !tried.has(slot.id)));
    };

    const initial = candidates();
    // 全候选不可用 → fail-closed（不静默回退 in-process）。
    if (initial.length === 0) throw new Error(ENGINE_ERROR.unavailable);
    const budget = Math.min(RETRY_MAX, initial.length);
    const tried = new Set<string>();
    let current = p2c(initial);
    let lastBusy = false;
    let lastResult: unknown;
    let hasResult = false;
    let lastError: Error | undefined;

    try {
      for (let attempt = 0; attempt <= budget && current !== undefined; attempt++) {
        if (disposed) throw new Error(ENGINE_ERROR.unavailable);
        // abort（tool.cancel notify 已标记）→ 重试终止；worker 无 oracle，靠 wire 标记。
        if (cancelledKeys.has(key)) throw new Error(ENGINE_ERROR.cancelled);
        // callback 透明续上 oracle（S17）：state≠pending（executing/settled/缺失）绝不重派。
        if (
          envelope.exec === 'callback' &&
          options.pendingState(envelope.run_id, envelope.tool_call_id) !== 'pending'
        ) {
          throw new Error(ENGINE_ERROR.cancelled);
        }
        tried.add(current.id);
        callEngine.set(key, current.id);
        const slot = current;
        slot.inflight += 1;
        let value: unknown;
        let failed: Error | undefined;
        try {
          value = await sendRequest(slot, ENGINE_WIRE.toolInvoke, envelope, timeoutMs);
        } catch (error) {
          failed = error instanceof Error ? error : new Error(String(error));
        } finally {
          slot.inflight -= 1;
        }

        if (failed === undefined) {
          lastError = undefined;
          lastBusy = false;
          lastResult = value;
          hasResult = true;
          // 错 engine not_registered（重绑定竞态）：engine 未派发 → 证明未执行，可重试。
          const notRegistered =
            isRecord(value) && value.content === ENGINE_ERROR.notRegistered(envelope.tool_name);
          if (!notRegistered) return value;
          if (attempt >= budget) return value;
          await retryBackoff();
          current = nextTarget(slot);
          continue;
        }

        hasResult = false;
        lastError = failed;
        if (failed instanceof RpcResponseError && failed.code === ENGINE_BUSY_CODE) {
          // busy 快拒（派发前准入，S18）：不计熔断（sendRequest 已按应答记健康）。
          lastBusy = true;
          if (attempt >= budget) throw new Error(ENGINE_ERROR.busy);
          await retryBackoff();
          current = nextTarget(slot);
          continue;
        }
        lastBusy = false;
        const retryable =
          failed instanceof NotDispatchedError ||
          (envelope.exec === 'callback' &&
            failed instanceof TransportError &&
            options.pendingState(envelope.run_id, envelope.tool_call_id) === 'pending');
        // worker 派发后失联 / callback oracle≠pending / 业务 error / 出站超限：绝不自动重试。
        if (!retryable || attempt >= budget) throw failed;
        await retryBackoff();
        current = nextTarget(slot);
      }
      // 预算耗尽 / 无下一候选：全池 busy 折稳定文本（S3/Q5）；其余折最后结果/错误。
      if (lastBusy) throw new Error(ENGINE_ERROR.busy);
      if (hasResult) return lastResult;
      throw lastError ?? new Error(ENGINE_ERROR.unavailable);
    } finally {
      // settle 即清（S8）：迟到 cancel 无映射 → 静默丢弃。
      callEngine.delete(key);
      cancelledKeys.delete(key);
    }
  }

  /**
   * engine.registry.sync 广播（S16）：Promise.allSettled 全部健康连接；
   * 全部 ack {ok:true} 才算成功；任一失败 → 该 engine 计熔断 + throw unavailable。
   */
  async function routeRegistrySync(params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!isRecord(params)) throw new Error(ENGINE_ERROR.unavailable);
    const targets = healthySlots();
    if (targets.length === 0) throw new Error(ENGINE_ERROR.unavailable);
    const settled = await Promise.allSettled(
      targets.map((slot) => sendRequest(slot, ENGINE_WIRE.registrySync, params, timeoutMs)),
    );
    const loaded = new Set<string>();
    let allOk = true;
    for (const [index, outcome] of settled.entries()) {
      const slot = targets[index];
      if (slot === undefined) continue;
      if (outcome.status === 'rejected') {
        // 传输层失联已由 close 单点记账；engine 应答 error 回包 = S16 失败计熔断。
        if (outcome.reason instanceof RpcResponseError) recordFailure(slot);
        allOk = false;
        continue;
      }
      if (!isRecord(outcome.value) || outcome.value.ok !== true) {
        recordFailure(slot);
        allOk = false;
        continue;
      }
      if (Array.isArray(outcome.value.loaded)) {
        for (const name of outcome.value.loaded) {
          if (typeof name === 'string') loaded.add(name);
        }
      }
    }
    if (!allOk) throw new Error(ENGINE_ERROR.unavailable);
    const result: RegistrySyncResult = { ok: true, loaded: [...loaded] };
    return result;
  }

  /**
   * engine.health request fan-out 合并（S16）：{status: 任一 degraded 则 degraded,
   * loaded: 并集去重, mcp: concat}；无健康 engine → throw unavailable。
   * 数据连接回包 = per-scope 形状（S4）；形状不过忽略（校验权 host 机械）。
   */
  async function routeHealth(timeoutMs?: number): Promise<unknown> {
    const targets = healthySlots();
    if (targets.length === 0) throw new Error(ENGINE_ERROR.unavailable);
    const settled = await Promise.allSettled(
      targets.map((slot) => sendRequest(slot, ENGINE_WIRE.health, {}, timeoutMs)),
    );
    let status: 'ok' | 'degraded' = 'ok';
    const loaded = new Set<string>();
    const mcp: McpServerStatus[] = [];
    let hasMcp = false;
    let valid = 0;
    for (const outcome of settled) {
      if (outcome.status === 'rejected') continue; // 失联已由 close 记账；合并容忍部分失败。
      const value = outcome.value;
      if (
        !isRecord(value) ||
        (value.status !== 'ok' && value.status !== 'degraded') ||
        !Array.isArray(value.loaded)
      ) {
        continue;
      }
      const names: string[] = [];
      let loadedValid = true;
      for (const item of value.loaded) {
        if (typeof item !== 'string') {
          loadedValid = false;
          break;
        }
        names.push(item);
      }
      if (!loadedValid) continue;
      valid += 1;
      if (value.status === 'degraded') status = 'degraded';
      for (const name of names) loaded.add(name);
      if (Array.isArray(value.mcp)) {
        hasMcp = true;
        for (const item of value.mcp) mcp.push(item as McpServerStatus);
      }
    }
    if (valid === 0) throw new Error(ENGINE_ERROR.unavailable);
    const merged: EngineHealthParams = {
      status,
      loaded: [...loaded],
      ...(hasMcp ? { mcp } : {}),
    };
    return merged;
  }

  /**
   * engine.mcp.control（S15）：configure = 绑定建立点 + 分裂合并；其余 action 绑定定点。
   * 无绑定 → {ok:false, code:'mcp_server_not_found'}（既有稳定码复用）。
   */
  async function routeMcpControl(params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!isRecord(params) || typeof params.action !== 'string') {
      throw new Error(ENGINE_ERROR.unavailable);
    }
    if (params.action === 'configure') {
      return configureSplitMerge(params.servers, timeoutMs);
    }
    if (
      params.action !== 'reconnect' &&
      params.action !== 'listTools' &&
      params.action !== 'listResources' &&
      params.action !== 'readResource' &&
      params.action !== 'listPrompts'
    ) {
      throw new Error(ENGINE_ERROR.unavailable);
    }
    const server = typeof params.server === 'string' ? params.server : undefined;
    if (server === undefined) throw new Error(ENGINE_ERROR.unavailable);
    const id = bindings.get(server);
    const slot = id === undefined ? undefined : slots.get(id);
    if (slot === undefined || !slot.inRouting) {
      const result: McpControlResult = {
        ok: false,
        code: 'mcp_server_not_found',
        message: `MCP server "${server}" is not configured`,
      };
      return result;
    }
    if (!usable(slot)) throw new Error(ENGINE_ERROR.unavailable);
    return sendRequest(slot, ENGINE_WIRE.mcpControl, params, timeoutMs);
  }

  /**
   * configure 分裂合并（S15）：按绑定分组 → 逐 engine 发该 engine 全部绑定 server
   * （per-scope 全量 diff 语义保留：失去绑定的活 engine 发缩减集 = 移除；死 engine 跳过，
   * scope 已 dispose）；回包 results 合并为单一 configure 结果（逐 server 部分失败语义保留）。
   * 健康绑定保留；新 server / 死 engine / 熔断 → P2C 重选（rebind 只由死亡/熔断触发）。
   */
  async function configureSplitMerge(servers: unknown, timeoutMs?: number): Promise<unknown> {
    if (!Array.isArray(servers)) throw new Error(ENGINE_ERROR.unavailable);
    const configs: McpServerConfig[] = [];
    for (const item of servers) {
      if (!isRecord(item) || typeof item.name !== 'string') {
        throw new Error(ENGINE_ERROR.unavailable);
      }
      configs.push(item as unknown as McpServerConfig);
    }
    const healthy = healthySlots();
    if (healthy.length === 0) throw new Error(ENGINE_ERROR.unavailable);

    // 绑定建立点：健康绑定保留，新 server / 死 engine / 熔断 → P2C 重选。
    const nextBindings = new Map<string, string>();
    for (const config of configs) {
      const existing = bindings.get(config.name);
      const slot = existing === undefined ? undefined : slots.get(existing);
      if (slot !== undefined && usable(slot)) {
        nextBindings.set(config.name, slot.id);
        continue;
      }
      const pick = p2c(healthy);
      if (pick === undefined) throw new Error(ENGINE_ERROR.unavailable);
      nextBindings.set(config.name, pick.id);
    }
    // 失去绑定的活 engine 也要发缩减集（全量 diff = 移除）：目标 = 新旧绑定 engine 并集。
    const targetIds = new Set<string>([...bindings.values(), ...nextBindings.values()]);
    bindings = nextBindings;

    const sends: { slot: EngineSlot; promise: Promise<unknown> }[] = [];
    for (const engineId of targetIds) {
      const slot = slots.get(engineId);
      // 死 engine 跳过（scope 已 dispose，MCP 连接已杀）；熔断 open 同样跳过（避让）。
      if (slot === undefined || !usable(slot)) continue;
      const group = configs.filter((config) => nextBindings.get(config.name) === engineId);
      sends.push({
        slot,
        promise: sendRequest(
          slot,
          ENGINE_WIRE.mcpControl,
          { action: 'configure', servers: group },
          timeoutMs,
        ),
      });
    }
    const settled = await Promise.allSettled(sends.map((send) => send.promise));
    const results: McpConfigureServerResult[] = [];
    for (const [index, outcome] of settled.entries()) {
      const send = sends[index];
      if (send === undefined) continue;
      if (outcome.status === 'rejected') {
        // 传输层失联已由 close 记账；任一 engine 失败 → fail-closed（装配层 reconcile 重试）。
        if (outcome.reason instanceof RpcResponseError) recordFailure(send.slot);
        throw new Error(ENGINE_ERROR.unavailable);
      }
      const value = outcome.value;
      if (
        !isRecord(value) ||
        value.ok !== true ||
        value.action !== 'configure' ||
        !Array.isArray(value.results)
      ) {
        throw new Error(ENGINE_ERROR.unavailable);
      }
      for (const item of value.results) results.push(item as McpConfigureServerResult);
    }
    const merged: McpControlResult = { ok: true, action: 'configure', results };
    return merged;
  }

  // ── EngineTransport 端口（消费面零改动） ─────────────────────

  const transport: PoolTransport = {
    get active() {
      return !disposed && healthySlots().length > 0;
    },
    async request(method, params, timeoutMs) {
      if (disposed) throw new Error(ENGINE_ERROR.unavailable);
      switch (method) {
        case ENGINE_WIRE.toolInvoke:
          return routeInvoke(params, timeoutMs);
        case ENGINE_WIRE.registrySync:
          return routeRegistrySync(params, timeoutMs);
        case ENGINE_WIRE.health:
          return routeHealth(timeoutMs);
        case ENGINE_WIRE.mcpControl:
          return routeMcpControl(params, timeoutMs);
        default:
          // 冻结路由表之外的方法：fail-closed（不静默发明路由）。
          throw new Error(ENGINE_ERROR.unavailable);
      }
    },
    notify(method, params) {
      if (disposed) return;
      if (method === ENGINE_WIRE.toolCancel) {
        // call→engine 映射定点（settle 即清）；无映射 → 静默丢弃（best-effort）。
        if (
          !isRecord(params) ||
          typeof params.run_id !== 'string' ||
          typeof params.tool_call_id !== 'string'
        ) {
          return;
        }
        const key = pendingKey(params.run_id, params.tool_call_id);
        const id = callEngine.get(key);
        if (id === undefined) return;
        // abort 标记：重试循环下一轮查此终止（forward settle 记录 → oracle 消失同语义）。
        cancelledKeys.add(key);
        slots.get(id)?.link?.notify(method, params);
        return;
      }
      if (method === ENGINE_WIRE.implReject) {
        // 广播 notify（S8）：全部健康连接。
        for (const slot of healthySlots()) slot.link?.notify(method, params);
        return;
      }
      // 其余 notification：静默丢弃（冻结表只有 tool.cancel / engine.impl.reject）。
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      if (watchDebounce !== undefined) {
        clearTimeout(watchDebounce);
        watchDebounce = undefined;
      }
      watcher?.close();
      watcher = undefined;
      for (const slot of slots.values()) {
        if (slot.reconnectTimer !== undefined) {
          clearTimeout(slot.reconnectTimer);
          slot.reconnectTimer = undefined;
        }
        slot.link?.destroy();
      }
      slots.clear();
      bindings.clear();
      callEngine.clear();
      cancelledKeys.clear();
    },
  };

  // 路由三触发（S5）：fs.watch + 5s poll + 数据面失败即刷（close 内）。
  void refreshRouting();
  establishWatch();
  pollTimer = setInterval(() => void refreshRouting(), ROUTING_POLL_MS);

  return transport;
}
