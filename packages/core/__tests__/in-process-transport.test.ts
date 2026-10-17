import { describe, expect, it } from 'bun:test';
import type { AgentMessage, AgentStatus } from '../src/kernel/index';
import { InProcessTransport } from '../src/transport/index';

function message(overrides: Partial<AgentMessage> & Pick<AgentMessage, 'to'>): AgentMessage {
  return {
    id: 'm1',
    from: 'owner',
    kind: 'message',
    content: 'hello',
    ts: Date.now(),
    ...overrides,
  };
}

describe('InProcessTransport（R3a-core）', () => {
  it('send 扇出到订阅者；退订后不再接收；消息对象原样传递', async () => {
    const transport = new InProcessTransport();
    const received: AgentMessage[] = [];
    const unsubscribe = transport.receive((item) => received.push(item));

    const first = message({ id: 'm1', to: 'a' });
    await transport.send(first);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(first);

    unsubscribe();
    unsubscribe(); // 幂等
    await transport.send(message({ id: 'm2', to: 'a' }));
    expect(received).toHaveLength(1);

    await transport.close();
  });

  it('多个订阅者都能收到（广播原样透传，不做 Host inbox 语义）', async () => {
    const transport = new InProcessTransport();
    const a: AgentMessage[] = [];
    const b: AgentMessage[] = [];
    transport.receive((item) => a.push(item));
    transport.receive((item) => b.push(item));

    await transport.send(message({ id: 'm1', to: '*' }));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.to).toBe('*');

    await transport.close();
  });

  it('错误隔离：同步抛错/异步拒绝的订阅者不影响其它订阅者', async () => {
    const transport = new InProcessTransport();
    const received: AgentMessage[] = [];

    transport.receive(() => {
      throw new Error('sync boom');
    });
    transport.receive(async () => {
      throw new Error('async boom');
    });
    transport.receive((item) => received.push(item));

    await expect(transport.send(message({ id: 'm1', to: 'a' }))).resolves.toBeUndefined();
    expect(received).toHaveLength(1);

    await transport.close();
  });

  it('peers 返回本节点信息；close 后为空', async () => {
    const agents: AgentStatus[] = [{ id: 'a', state: 'idle', toolNames: ['read'] }];
    const transport = new InProcessTransport({
      nodeId: 'node-a',
      endpoint: 'inproc://a',
      agents: () => agents,
    });

    expect(await transport.peers()).toEqual([
      { nodeId: 'node-a', endpoint: 'inproc://a', agents, protocol: 1 },
    ]);

    await transport.close();
    expect(await transport.peers()).toEqual([]);
  });

  it('close 后 send/receive 明确报错；close 幂等', async () => {
    const transport = new InProcessTransport();
    await transport.close();
    await transport.close();

    await expect(transport.send(message({ id: 'm1', to: 'a' }))).rejects.toThrow(
      'transport is closed',
    );
    expect(() => transport.receive(() => {})).toThrow('transport is closed');
  });

  it('节点 id 校验', () => {
    expect(() => new InProcessTransport({ nodeId: 'bad id' })).toThrow('invalid node id');
    expect(() => new InProcessTransport({ nodeId: 'a'.repeat(65) })).toThrow('invalid node id');
    expect(() => new InProcessTransport({ nodeId: 'node_1-ok' })).not.toThrow();
  });
});
