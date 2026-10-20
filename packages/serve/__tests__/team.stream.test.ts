import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel/core';
import type { Gateway } from '../src/gateway';
import { startGateway } from '../src/gateway';

describe('gateway /v1/team/stream', () => {
  const gateways: Gateway[] = [];

  afterEach(() => {
    for (const gw of gateways.splice(0)) gw.stop();
  });

  it('filters team events by agent_id and exposes snake_case payloads', async () => {
    const events = new MemoryEventStream();
    const gw = startGateway({
      events,
      port: 0,
      nodeId: 'A',
      team: { nodeId: 'A' },
    });
    gateways.push(gw);

    const res = await fetch(`${gw.url}/v1/team/stream?agent_id=a1`, {
      headers: { Authorization: `Bearer ${gw.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    const decoder = new TextDecoder();

    events.publish({
      type: 'agent.spawned',
      run_id: 'a1',
      data: { agentId: 'a1', name: 'One' },
      ts: Date.now(),
    });
    events.publish({
      type: 'agent.spawned',
      run_id: 'a2',
      data: { agentId: 'a2', name: 'Two' },
      ts: Date.now(),
    });
    events.publish({
      type: 'team.peer.joined',
      run_id: 'team',
      data: { nodeId: 'B' },
      ts: Date.now(),
    });

    let text = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !text.includes('"agent_id":"a1"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    await reader.cancel();

    expect(text).toContain('"kind":"team.hello"');
    expect(text).toContain('"kind":"team.event"');
    expect(text).toContain('"agent_id":"a1"');
    expect(text).toContain('agent.spawned');
    expect(text).not.toContain('"agent_id":"a2"');
    expect(text).not.toContain('"node_id":"B"');
  });
});
