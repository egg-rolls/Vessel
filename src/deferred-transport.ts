/**
 * DeferredTransport — 晚绑定的 Transport 适配器（0.2 A5/F14）。
 *
 * bootstrap 需要先把 team 插件装到 Host 上，但 loopback 必须等 gateway
 * 启动拿到实际端口/token 后才能构造。这个适配器让 team 插件从一开始就拿到
 * 一个稳定的 Transport 实例：
 *
 * - `receive` 先本地登记，`resolve(real)` 后补订阅；
 * - `send` 在 resolve 前排队，resolve 后按序 flush；
 * - `peers` 在 resolve 前返回 []；
 * - `fail(error)` 让排队/后续 send 结构化失败（loopback 构造失败时使用）；
 * - `close` 关闭 real 并清空。
 *
 * 它只做适配，不实现传输、不复制 inbox/peers 语义。
 */

import type { AgentMessage, PeerInfo, Transport, Unsubscribe } from '../packages/core/src/index';

type ReceiveHandler = (message: AgentMessage) => void | Promise<void>;

interface PendingSend {
  message: AgentMessage;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

export class DeferredTransport implements Transport {
  readonly kind = 'loopback' as const;

  private real?: Transport;
  private failure?: Error;
  private closed = false;
  private readonly handlers = new Set<ReceiveHandler>();
  private readonly realUnsubscribes = new Map<ReceiveHandler, Unsubscribe>();
  private pending: PendingSend[] = [];

  receive(handler: ReceiveHandler): Unsubscribe {
    if (this.closed) return () => {};
    this.handlers.add(handler);
    if (this.real) {
      this.realUnsubscribes.set(handler, this.real.receive(handler));
    }
    return () => {
      this.handlers.delete(handler);
      const unsubscribe = this.realUnsubscribes.get(handler);
      if (unsubscribe) {
        unsubscribe();
        this.realUnsubscribes.delete(handler);
      }
    };
  }

  send(message: AgentMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error('transport_closed'));
    if (this.failure) return Promise.reject(this.failure);
    if (this.real) return this.real.send(message);

    return new Promise<void>((resolve, reject) => {
      this.pending.push({ message, resolve, reject });
    });
  }

  async peers(): Promise<PeerInfo[]> {
    if (!this.real || this.failure) return [];
    return this.real.peers();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.splice(0)) {
      pending.reject(new Error('transport_closed'));
    }
    for (const unsubscribe of this.realUnsubscribes.values()) unsubscribe();
    this.realUnsubscribes.clear();
    this.handlers.clear();
    await this.real?.close();
  }

  /** 绑定真实 transport，补订阅并 flush 排队的消息 */
  resolve(real: Transport): void {
    if (this.closed) {
      void real.close();
      return;
    }
    if (this.real || this.failure) return;

    this.real = real;
    for (const handler of this.handlers) {
      this.realUnsubscribes.set(handler, real.receive(handler));
    }

    const pending = this.pending.splice(0);
    for (const item of pending) {
      real.send(item.message).then(item.resolve, item.reject);
    }
  }

  /** 绑定失败：排队与后续 send 直接 reject；peers 返回空 */
  fail(error: Error): void {
    if (this.real || this.failure || this.closed) return;
    this.failure = error;
    for (const pending of this.pending.splice(0)) pending.reject(error);
  }
}
