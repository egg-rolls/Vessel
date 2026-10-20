import { describe, expect, it } from 'bun:test';
import type { Transport } from '../src/kernel/index';
import { MemoryEventBus } from '../src/kernel/index';
import { InProcessTransport } from '../src/transport/index';
import type { RunEvent } from '../src/types/event';

function event(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    type: 'run.started',
    run_id: 'r1',
    data: {},
    ts: Date.now(),
    ...overrides,
  };
}

describe('Transport remote port（0.6）', () => {
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
});
