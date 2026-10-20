import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel-agent/core';
import { type Gateway, startGateway } from '../src/gateway';
import { createTeamNode, makeTempDir, removeTempDir } from './helpers';

describe('gateway /v1/team auth & validation', () => {
  const dirs: string[] = [];
  const gateways: Gateway[] = [];
  const closers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    for (const gw of gateways.splice(0)) gw.stop();
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });

  async function makeTeam() {
    const dir = await makeTempDir();
    dirs.push(dir);
    const node = await createTeamNode({
      nodeId: 'A',
      peersDir: dir,
      token: 'team-token',
      heartbeatMs: 50,
      peerTtlMs: 500,
    });
    gateways.push(node.gateway);
    closers.push(() => node.transport.close());
    return node.gateway;
  }

  const postMessage = (gw: Gateway, body: unknown) => {
    const payload = body && typeof body === 'object' ? { node_id: 'B', ...(body as object) } : body;
    return fetch(`${gw.url}/v1/team/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gw.token}` },
      body: JSON.stringify(payload),
    });
  };

  it('requires a token and enforces Origin/Host', async () => {
    const gw = await makeTeam();
    expect((await fetch(`${gw.url}/v1/team/peers`)).status).toBe(401);
    expect(
      (
        await fetch(`${gw.url}/v1/team/peers`, {
          headers: { Authorization: 'Bearer wrong' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${gw.url}/v1/team/peers`, {
          headers: { Authorization: `Bearer ${gw.token}`, Origin: 'http://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${gw.url}/v1/team/peers`, {
          headers: { Authorization: `Bearer ${gw.token}` },
        })
      ).status,
    ).toBe(200);
  });

  it('returns 404 when team is disabled', async () => {
    const gw = startGateway({ events: new MemoryEventStream(), port: 0 });
    gateways.push(gw);
    const res = await fetch(`${gw.url}/v1/team/peers`, {
      headers: { Authorization: `Bearer ${gw.token}` },
    });
    expect(res.status).toBe(404);
  });

  it('validates protocol, kind and addresses', async () => {
    const gw = await makeTeam();
    const validMessage = {
      id: 'm1',
      from: 'B:owner',
      to: 'A:worker',
      kind: 'task',
      content: 'hi',
      ts: Date.now(),
    };

    const wrongProtocol = await postMessage(gw, { protocol: 2, message: validMessage });
    expect(wrongProtocol.status).toBe(426);

    const unknownKind = await postMessage(gw, {
      protocol: 1,
      message: { ...validMessage, kind: 'unknown' },
    });
    expect(unknownKind.status).toBe(400);
    const kindBody = (await unknownKind.json()) as { error: { code: string } };
    expect(kindBody.error.code).toBe('invalid_request');

    const badAddress = await postMessage(gw, {
      protocol: 1,
      message: { ...validMessage, to: 'bad/address' },
    });
    expect(badAddress.status).toBe(400);

    const relay = await postMessage(gw, {
      protocol: 1,
      message: { ...validMessage, to: 'C:worker' },
    });
    expect(relay.status).toBe(404);
    const relayBody = (await relay.json()) as { error: { code: string } };
    expect(relayBody.error.code).toBe('agent_not_found');
  });

  it('rejects inbound broadcast messages (F9)', async () => {
    const gw = await makeTeam();
    const res = await postMessage(gw, {
      protocol: 1,
      message: {
        id: 'broadcast-1',
        from: 'B:owner',
        to: '*',
        kind: 'message',
        content: 'hi all',
        ts: Date.now(),
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('broadcast_not_supported');
  });

  it('rejects spoofed envelope node_id when from has a node prefix (F11)', async () => {
    const gw = await makeTeam();
    const res = await postMessage(gw, {
      node_id: 'C',
      protocol: 1,
      message: {
        id: 'spoof-1',
        from: 'B:owner',
        to: 'A:worker',
        kind: 'message',
        content: 'spoof',
        ts: Date.now(),
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('requires envelope node_id when from has a node prefix (F11)', async () => {
    const gw = await makeTeam();
    const res = await postMessage(gw, {
      node_id: undefined,
      protocol: 1,
      message: {
        id: 'no-node-1',
        from: 'B:owner',
        to: 'A:worker',
        kind: 'message',
        content: 'no envelope node',
        ts: Date.now(),
      },
    });
    expect(res.status).toBe(400);
  });

  it('allows local shorthand from without a node prefix (F11)', async () => {
    const gw = await makeTeam();
    const res = await postMessage(gw, {
      node_id: 'ignored-for-local',
      protocol: 1,
      message: {
        id: 'local-from-1',
        from: 'owner',
        to: 'A:worker',
        kind: 'message',
        content: 'local from',
        ts: Date.now(),
      },
    });
    expect(res.status).toBe(202);
  });

  it('accepts a valid inbound message for this node', async () => {
    const gw = await makeTeam();
    const res = await postMessage(gw, {
      protocol: 1,
      node_id: 'B',
      message: {
        id: 'm-ok',
        from: 'B:owner',
        to: 'A:worker',
        kind: 'message',
        content: 'hello',
        ts: Date.now(),
      },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; message_id: string; cursor: string };
    expect(body.ok).toBe(true);
    expect(body.message_id).toBe('m-ok');
    expect(typeof body.cursor).toBe('string');
  });
});
