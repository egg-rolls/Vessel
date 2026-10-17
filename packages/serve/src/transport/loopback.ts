/**
 * LoopbackTransport —— 本机不同进程之间的 Transport 实现（R3b）
 *
 * - 只走 127.0.0.1 HTTP；不用 Unix socket / named pipe（D2）。
 * - `send` 跨节点时 POST `/v1/team/messages`；本机地址直接投递给本地 handler。
 * - 发现用 `PeerRegistry` 文件注册表；token 不落盘（U7）。
 * - 失败只影响本次调用：返回结构化 `PeerTransportError`，不抛进 owner run。
 *
 * @module @vessel/serve/transport
 */

import type { AgentMessage, PeerInfo, Transport, Unsubscribe } from '@vessel/core';
import { fromWireMessage, parseAddress, TeamProtocolError, toWireMessage } from '../team.js';
import { PeerRegistry } from './registry.js';

export interface LoopbackTransportOptions {
  /** 唯一来源 host.node_id（U3） */
  nodeId: string;
  /** 本节点 gateway 实际地址；由 asm 注入（U4） */
  endpoint: string;
  /** 与 gateway 共用的 token（U7） */
  token: string;
  /** transport.peers_dir，默认 ~/.vessel/peers（U5） */
  peersDir: string;
  heartbeatMs?: number;
  peerTtlMs?: number;
  requestTimeoutMs?: number;
  /** 入站去重窗口（默认 1000） */
  maxInbox?: number;
}

/** 传输层错误码（稳定字符串，供 ext 折回语言空间） */
export type PeerTransportErrorCode =
  | 'transport_closed'
  | 'invalid_request'
  | 'peer_not_found'
  | 'peer_unreachable'
  | 'timeout'
  | 'unauthorized'
  | 'unsupported_protocol'
  | 'peer_error';

export class PeerTransportError extends Error {
  constructor(
    readonly code: PeerTransportErrorCode,
    message: string,
    readonly peerNodeId?: string,
  ) {
    super(message);
    this.name = 'PeerTransportError';
  }
}

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_PEER_TTL_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_INBOX = 1_000;

/** query wrapper：把 team 协议错误转成传输层错误 */
function normalizeMessage(message: AgentMessage): AgentMessage {
  try {
    return fromWireMessage(toWireMessage(message));
  } catch (error) {
    if (error instanceof TeamProtocolError) {
      throw new PeerTransportError('invalid_request', error.message);
    }
    throw error;
  }
}

/** 本机 loopback Transport */
export class LoopbackTransport implements Transport {
  readonly kind = 'loopback' as const;
  private readonly handlers = new Set<(message: AgentMessage) => void | Promise<void>>();
  private readonly seen = new Map<string, true>();
  private readonly maxInbox: number;
  private readonly requestTimeoutMs: number;
  private closed = false;

  private constructor(
    private readonly options: LoopbackTransportOptions,
    private readonly registry: PeerRegistry,
    maxInbox: number,
    requestTimeoutMs: number,
  ) {
    this.maxInbox = maxInbox;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /** 创建并启动注册表；目录不可写时降级为 local-only，不抛（R7） */
  static async create(options: LoopbackTransportOptions): Promise<LoopbackTransport> {
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const peerTtlMs = options.peerTtlMs ?? DEFAULT_PEER_TTL_MS;
    if (!(heartbeatMs > 0) || !(peerTtlMs > heartbeatMs)) {
      throw new Error(
        `invalid transport timing: require peerTtlMs > heartbeatMs > 0 (got heartbeatMs=${heartbeatMs}, peerTtlMs=${peerTtlMs})`,
      );
    }
    const registry = await PeerRegistry.create({
      nodeId: options.nodeId,
      endpoint: options.endpoint,
      peersDir: options.peersDir,
      heartbeatMs,
      peerTtlMs,
    });
    await registry.start();
    return new LoopbackTransport(
      options,
      registry,
      options.maxInbox ?? DEFAULT_MAX_INBOX,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
  }

  /** 本节点 + 存活 peer */
  peers(): Promise<PeerInfo[]> {
    return Promise.resolve(this.registry.peers());
  }

  /** 订阅入站消息 */
  receive(handler: (message: AgentMessage) => void | Promise<void>): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** 发送消息；本机地址直投，跨节点 POST */
  async send(message: AgentMessage): Promise<void> {
    if (this.closed) {
      throw new PeerTransportError('transport_closed', 'Transport is closed');
    }
    const normalized = normalizeMessage(message);

    if (normalized.to === '*') {
      await this.deliverLocal(normalized);
      return;
    }

    const target = parseAddress(normalized.to);
    if (target.nodeId === undefined || target.nodeId === this.options.nodeId) {
      await this.deliverLocal(normalized);
      return;
    }

    const peer = this.registry.get(target.nodeId);
    if (!peer?.endpoint) {
      throw new PeerTransportError(
        'peer_not_found',
        `Peer not found or stale: ${target.nodeId}`,
        target.nodeId,
      );
    }
    await this.post(peer.endpoint, target.nodeId, normalized);
  }

  /**
   * gateway 入站入口：校验、去重、投递给本地 handler。
   * 返回 false 表示重复消息（已投递过）。
   */
  async deliver(message: AgentMessage): Promise<boolean> {
    if (this.closed) {
      throw new PeerTransportError('transport_closed', 'Transport is closed');
    }
    const normalized = normalizeMessage(message);
    if (this.seen.has(normalized.id)) return false;
    this.remember(normalized.id);
    await this.deliverLocal(normalized);
    return true;
  }

  /** 关闭心跳/注册表/订阅；不关闭 gateway */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    this.seen.clear();
    await this.registry.stop();
  }

  private async deliverLocal(message: AgentMessage): Promise<void> {
    const results = await Promise.allSettled(
      [...this.handlers].map((handler) => Promise.resolve().then(() => handler(message))),
    );
    // handler 异常只影响该 handler；不向调用方抛出（失败隔离）。
    void results;
  }

  private remember(id: string): void {
    this.seen.set(id, true);
    while (this.seen.size > this.maxInbox) {
      const first = this.seen.keys().next();
      if (first.done) break;
      this.seen.delete(first.value);
    }
  }

  private async post(endpoint: string, peerNodeId: string, message: AgentMessage): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      const res = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/team/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.token}`,
        },
        body: JSON.stringify({
          protocol: 1,
          node_id: this.options.nodeId,
          message: toWireMessage(message),
        }),
        signal: controller.signal,
      });
      if (res.status === 401) {
        throw new PeerTransportError('unauthorized', 'Peer rejected token (401)', peerNodeId);
      }
      if (res.status === 426) {
        throw new PeerTransportError(
          'unsupported_protocol',
          'Peer does not support protocol 1',
          peerNodeId,
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new PeerTransportError(
          'peer_error',
          `Peer returned ${res.status}: ${text.slice(0, 200)}`,
          peerNodeId,
        );
      }
    } catch (error) {
      if (error instanceof PeerTransportError) throw error;
      if (controller.signal.aborted) {
        throw new PeerTransportError(
          'timeout',
          `Peer request timed out after ${this.requestTimeoutMs}ms`,
          peerNodeId,
        );
      }
      throw new PeerTransportError(
        'peer_unreachable',
        `Peer unreachable: ${error instanceof Error ? error.message : String(error)}`,
        peerNodeId,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 导出工厂（DECISION-006 R2） */
export function createLoopbackTransport(
  options: LoopbackTransportOptions,
): Promise<LoopbackTransport> {
  return LoopbackTransport.create(options);
}
