import { describe, expect, it } from 'bun:test';
import type { AgentMessage, PeerInfo, Transport, TransportRequest } from '../src/kernel/index';
import { MemoryEventBus } from '../src/kernel/index';
import { InProcessTransport } from '../src/transport/index';
import type { RunEvent, Unsubscribe } from '../src/types/event';

function event(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    type: 'run.started',
    run_id: 'r1',
    data: {},
    ts: Date.now(),
    ...overrides,
  };
}

interface RemoteCall {
  nodeId: string;
  request: TransportRequest;
}

class FakeRemoteTransport implements Transport {
  readonly kind = 'remote' as const;
  readonly nodeId = 'node-local';
  readonly calls: RemoteCall[] = [];
  readonly sent: AgentMessage[] = [];
  private readonly handlers = new Set<(message: AgentMessage) => void>();

  async send(message: AgentMessage): Promise<void> {
    this.sent.push(message);
  }

  receive(handler: (message: AgentMessage) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async peers(): Promise<PeerInfo[]> {
    return [
      {
        nodeId: 'node-remote',
        agents: [],
        protocol: 1,
        status: 'healthy',
        lastSeen: 1_700_000_000_000,
      },
    ];
  }

  async request<T>(nodeId: string, request: TransportRequest): Promise<T> {
    this.calls.push({ nodeId, request });
    return { nodeId, method: request.method, params: request.params } as T;
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}

describe('Transport remote port（0.6）', () => {
  it('remote fake 可赋值给 Transport，request 按 nodeId 透传 method/params 并返回泛型结果', async () => {
    const remote = new FakeRemoteTransport();
    const transport: Transport = remote;

    expect(transport.kind).toBe('remote');
    expect(transport.nodeId).toBe('node-local');

    expect(transport.request).toBeDefined();

    const params = { prompt: 'hi' };
    const result = await transport.request?.<{
      nodeId: string;
      method: string;
      params: unknown;
    }>('node-remote', {
      requestId: 'req-1',
      method: 'team.task',
      params,
    });

    expect(result).toEqual({ nodeId: 'node-remote', method: 'team.task', params });
    expect(remote.calls).toEqual([
      {
        nodeId: 'node-remote',
        request: { requestId: 'req-1', method: 'team.task', params },
      },
    ]);
  });

  it('InProcessTransport 的 kind 为 in-process、nodeId 可用，且不提供 request', async () => {
    const transport: Transport = new InProcessTransport({ nodeId: 'node-a' });

    expect(transport.kind).toBe('in-process');
    expect(transport.nodeId).toBe('node-a');
    expect(transport.request).toBeUndefined();

    await transport.close();
  });

  it('subscribeFiltered 的 nodeId 只匹配相同 event.node_id；无 node_id 不匹配显式 nodeId', () => {
    const bus = new MemoryEventBus();
    const matched: RunEvent[] = [];
    bus.subscribeFiltered(
      (item) => {
        matched.push(item);
      },
      { nodeId: 'node-a' },
    );

    bus.publish(event({ node_id: 'node-a', run_id: 'r1' }));
    bus.publish(event({ node_id: 'node-b', run_id: 'r2' }));
    bus.publish(event({ run_id: 'r3' }));

    expect(matched.map((item) => item.run_id)).toEqual(['r1']);
  });

  it('subscribeFiltered 不传 filter 时收到全部事件', () => {
    const bus = new MemoryEventBus();
    const all: RunEvent[] = [];
    bus.subscribeFiltered((item) => {
      all.push(item);
    });

    bus.publish(event({ node_id: 'node-a', run_id: 'r1' }));
    bus.publish(event({ run_id: 'r2' }));
    bus.publish(event({ node_id: 'node-b', run_id: 'r3' }));

    expect(all.map((item) => item.run_id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('RunEvent 可带 node_id，PeerInfo 可带可选 status/lastSeen', () => {
    const withNode = event({ node_id: 'node-a' });
    expect(withNode.node_id).toBe('node-a');

    const healthy: PeerInfo = {
      nodeId: 'node-a',
      agents: [],
      protocol: 1,
      status: 'healthy',
      lastSeen: 123,
    };
    const unreachable: PeerInfo = {
      nodeId: 'node-b',
      agents: [],
      protocol: 1,
      status: 'unreachable',
    };
    const unknown: PeerInfo = { nodeId: 'node-c', agents: [], protocol: 1 };

    expect(healthy.lastSeen).toBe(123);
    expect(unreachable.status).toBe('unreachable');
    expect(unknown.status).toBeUndefined();
  });
});
