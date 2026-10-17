import { afterEach, describe, expect, it } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMessage } from '@vessel/core';
import { createLoopbackTransport } from '../src/transport/index';
import { createTeamNode, makeTempDir, removeTempDir, waitUntil } from './helpers';

function message(partial: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'to'>): AgentMessage {
  return {
    from: 'A:owner',
    kind: 'task',
    content: 'hello',
    ts: Date.now(),
    ...partial,
  };
}

describe('LoopbackTransport', () => {
  const dirs: string[] = [];
  const closers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });

  async function makeNodes() {
    const dir = await makeTempDir();
    dirs.push(dir);
    const token = 'test-token';
    const bReceived: AgentMessage[] = [];
    const aReceived: AgentMessage[] = [];

    const b = await createTeamNode({
      nodeId: 'B',
      peersDir: dir,
      token,
      heartbeatMs: 50,
      peerTtlMs: 500,
    });
    b.transport.receive((msg) => {
      bReceived.push(msg);
    });
    const a = await createTeamNode({
      nodeId: 'A',
      peersDir: dir,
      token,
      heartbeatMs: 50,
      peerTtlMs: 500,
    });
    a.transport.receive((msg) => {
      aReceived.push(msg);
    });
    closers.push(async () => {
      await a.transport.close();
      a.gateway.stop();
      await b.transport.close();
      b.gateway.stop();
    });
    return { a, b, bReceived, aReceived };
  }

  it('discovers peers and sends cross-process messages', async () => {
    const { a, bReceived } = await makeNodes();
    await waitUntil(async () => (await a.transport.peers()).some((peer) => peer.nodeId === 'B'));

    await a.transport.send(message({ id: 'm1', to: 'B:worker', content: 'ping' }));
    await waitUntil(() => bReceived.length === 1);
    expect(bReceived[0]?.from).toBe('A:owner');
    expect(bReceived[0]?.to).toBe('worker');
    expect(bReceived[0]?.content).toBe('ping');
  });

  it('delivers local addresses without HTTP', async () => {
    const { a, aReceived } = await makeNodes();
    await a.transport.send(message({ id: 'local-1', to: 'owner', content: 'local' }));
    await waitUntil(() => aReceived.length === 1);
    expect(aReceived[0]?.to).toBe('owner');
  });

  it('deduplicates inbound message ids', async () => {
    const { a, bReceived } = await makeNodes();
    await waitUntil(async () => (await a.transport.peers()).some((peer) => peer.nodeId === 'B'));

    const duplicate = message({ id: 'dup-1', to: 'B:worker' });
    await a.transport.send(duplicate);
    await waitUntil(() => bReceived.length === 1);
    await a.transport.send(duplicate);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(bReceived.length).toBe(1);
  });

  it('rejects invalid kinds and addresses', async () => {
    const { a } = await makeNodes();
    await expect(
      a.transport.send(message({ id: 'bad-kind', to: 'B:worker', kind: 'weird' })),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      a.transport.send(message({ id: 'bad-addr', to: 'bad/address' })),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('reports peer_not_found for unknown nodes', async () => {
    const { a } = await makeNodes();
    await expect(
      a.transport.send(message({ id: 'unknown-peer', to: 'Z:worker' })),
    ).rejects.toMatchObject({ code: 'peer_not_found' });
  });

  it('reports peer failures without throwing into the caller runtime', async () => {
    const { a, b } = await makeNodes();
    await waitUntil(async () => (await a.transport.peers()).some((peer) => peer.nodeId === 'B'));
    await b.transport.close();
    b.gateway.stop();

    try {
      await a.transport.send(message({ id: 'down-1', to: 'B:worker' }));
      throw new Error('expected send to fail');
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      expect(['peer_not_found', 'peer_unreachable', 'timeout']).toContain(code);
    }
  });

  it('enforces peerTtlMs > heartbeatMs > 0', async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    await expect(
      createLoopbackTransport({
        nodeId: 'A',
        endpoint: 'http://127.0.0.1:1234',
        token: 't',
        peersDir: dir,
        heartbeatMs: 100,
        peerTtlMs: 50,
      }),
    ).rejects.toThrow(/peerTtlMs > heartbeatMs/);
  });

  it('degrades to local-only when peersDir is a file', async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const filePath = join(dir, 'not-a-dir');
    await writeFile(filePath, 'x');

    const transport = await createLoopbackTransport({
      nodeId: 'A',
      endpoint: 'http://127.0.0.1:1234',
      token: 't',
      peersDir: filePath,
    });
    closers.push(() => transport.close());
    expect(transport.kind).toBe('loopback');
    expect((await transport.peers()).map((peer) => peer.nodeId)).toEqual(['A']);
  });

  it('rejects send after close', async () => {
    const { a } = await makeNodes();
    await a.transport.close();
    await expect(a.transport.send(message({ id: 'closed-1', to: 'owner' }))).rejects.toMatchObject({
      code: 'transport_closed',
    });
  });
});
