import { describe, expect, it } from 'bun:test';
import type { AgentMessage, PeerInfo, Transport } from '../../packages/core/src/index';
import { DeferredTransport } from '../deferred-transport';

type Handler = (message: AgentMessage) => void | Promise<void>;

function message(id: string, to = 'B:worker'): AgentMessage {
  return { id, from: 'A:owner', to, kind: 'message', content: id, ts: 1 };
}

function fakeReal() {
  const handlers = new Set<Handler>();
  const sent: AgentMessage[] = [];
  let closed = 0;
  const transport: Transport = {
    kind: 'loopback',
    send: async (item) => {
      sent.push(item);
    },
    receive: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    peers: async (): Promise<PeerInfo[]> => [{ nodeId: 'B', agents: [], protocol: 1 }],
    close: async () => {
      closed++;
    },
  };
  return {
    transport,
    handlers,
    sent,
    get closed() {
      return closed;
    },
  };
}

describe('DeferredTransport', () => {
  it('resolve 前 send 排队，resolve 后按序 flush', async () => {
    const deferred = new DeferredTransport();
    const real = fakeReal();

    const first = deferred.send(message('one'));
    const second = deferred.send(message('two'));
    expect(real.sent).toHaveLength(0);

    deferred.resolve(real.transport);
    await Promise.all([first, second]);

    expect(real.sent.map((item) => item.id)).toEqual(['one', 'two']);
  });

  it('resolve 前登记的 receive 在 resolve 后收到消息', async () => {
    const deferred = new DeferredTransport();
    const real = fakeReal();
    const received: string[] = [];

    const unsubscribe = deferred.receive((item) => {
      received.push(item.id);
    });
    deferred.resolve(real.transport);

    for (const handler of real.handlers) await handler(message('in-1'));
    expect(received).toEqual(['in-1']);

    unsubscribe();
    expect(real.handlers.size).toBe(0);
  });

  it('peers 在 resolve 前为空，resolve 后委托真实实现', async () => {
    const deferred = new DeferredTransport();
    expect(await deferred.peers()).toEqual([]);

    const real = fakeReal();
    deferred.resolve(real.transport);
    expect((await deferred.peers()).map((peer) => peer.nodeId)).toEqual(['B']);
  });

  it('fail 后排队与后续 send 都 reject，peers 为空', async () => {
    const deferred = new DeferredTransport();
    const queued = deferred.send(message('queued'));
    deferred.fail(new Error('loopback unavailable'));

    await expect(queued).rejects.toThrow('loopback unavailable');
    await expect(deferred.send(message('later'))).rejects.toThrow('loopback unavailable');
    expect(await deferred.peers()).toEqual([]);
  });

  it('close 拒绝 resolve 前排队消息', async () => {
    const deferred = new DeferredTransport();
    const queued = deferred.send(message('queued'));

    await deferred.close();

    await expect(queued).rejects.toThrow('transport_closed');
    await expect(deferred.send(message('after'))).rejects.toThrow('transport_closed');
  });

  it('close 关闭已绑定的真实 transport', async () => {
    const deferred = new DeferredTransport();
    const real = fakeReal();
    deferred.resolve(real.transport);

    await deferred.close();

    expect(real.closed).toBe(1);
    await expect(deferred.send(message('after'))).rejects.toThrow('transport_closed');
  });

  it('resolve 只生效一次；closed 后 resolve 直接关闭真实实现', async () => {
    const deferred = new DeferredTransport();
    const first = fakeReal();
    const second = fakeReal();

    deferred.resolve(first.transport);
    deferred.resolve(second.transport);
    expect(second.closed).toBe(0);

    await deferred.close();
    const late = fakeReal();
    deferred.resolve(late.transport);
    expect(late.closed).toBe(1);
  });
});
