import { describe, expect, it } from 'bun:test';
import type { FederationConfig } from '../../packages/config/src/index';
import { createFederationSendPort } from '../federation-send-port';

const FEDERATION: FederationConfig = {
  enabled: true,
  peers: [
    {
      nodeId: 'node-b',
      teamId: 'beta',
      url: 'http://peer.test',
      tokenEnv: 'FED_TOKEN',
      direction: 'out',
    },
  ],
};

const ENV = { FED_TOKEN: 'secret-token' };

const VALID_FROM = 'alice@node-a:alpha';
const VALID_TO = 'bob@node-b:beta';

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function captureFetch(respond: (call: CapturedCall) => Response): {
  fetchImpl: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createFederationSendPort', () => {
  it('exposes nodeId and sends a wire message with parsed from/to principals', async () => {
    const { fetchImpl, calls } = captureFetch(() =>
      jsonResponse({ ok: true, message_id: 'remote-1', cursor: 'cursor-1' }),
    );
    const port = createFederationSendPort({
      federation: FEDERATION,
      nodeId: 'node-a',
      env: ENV,
      fetchImpl,
      now: () => 123,
      generateId: () => 'local-1',
    });

    expect(port.nodeId).toBe('node-a');

    const result = await port.send({
      from: VALID_FROM,
      to: VALID_TO,
      content: 'hello bob',
      conversation_id: 'conv-1',
    });

    expect(result).toEqual({ status: 'queued', message_id: 'remote-1' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('http://peer.test/v1/federation/messages');
    const headers = call?.init.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer secret-token');
    const body = JSON.parse(String(call?.init.body)) as {
      protocol: string;
      message_id: string;
      conversation_id: string;
      from: Record<string, string>;
      to: Record<string, string>;
      content: string;
      ts: number;
      hop: number;
    };
    expect(body.protocol).toBe('vessel.federation/1');
    expect(body.message_id).toBe('local-1');
    expect(body.conversation_id).toBe('conv-1');
    expect(body.from).toEqual({ principal: 'alice', node_id: 'node-a', team_id: 'alpha' });
    expect(body.to).toEqual({ principal: 'bob', node_id: 'node-b', team_id: 'beta' });
    expect(body.content).toBe('hello bob');
    expect(body.ts).toBe(123);
    expect(body.hop).toBe(1);
  });

  it('maps delivered and deduplicated both to queued', async () => {
    let deduplicated = false;
    const { fetchImpl } = captureFetch(() =>
      jsonResponse({
        ok: true,
        message_id: 'remote-2',
        cursor: 'cursor-2',
        deduplicated,
      }),
    );
    const port = createFederationSendPort({
      federation: FEDERATION,
      nodeId: 'node-a',
      env: ENV,
      fetchImpl,
      generateId: () => 'local-2',
    });

    const delivered = await port.send({
      from: VALID_FROM,
      to: VALID_TO,
      content: 'one',
    });
    expect(delivered).toEqual({ status: 'queued', message_id: 'remote-2' });

    deduplicated = true;
    const deduped = await port.send({
      from: VALID_FROM,
      to: VALID_TO,
      content: 'two',
    });
    expect(deduped).toEqual({ status: 'queued', message_id: 'remote-2' });
  });

  it('rejects invalid addresses and foreign from nodes with zero fetch calls', async () => {
    const { fetchImpl, calls } = captureFetch(() => jsonResponse({ ok: true }));
    const port = createFederationSendPort({
      federation: FEDERATION,
      nodeId: 'node-a',
      env: ENV,
      fetchImpl,
    });

    const badFrom = await port.send({
      from: 'not-an-address',
      to: VALID_TO,
      content: 'hi',
    });
    expect(badFrom).toMatchObject({
      status: 'rejected',
      code: 'federation_invalid_address',
    });

    const badTo = await port.send({
      from: VALID_FROM,
      to: 'bob@node-b',
      content: 'hi',
    });
    expect(badTo).toMatchObject({
      status: 'rejected',
      code: 'federation_invalid_address',
    });

    const foreignNode = await port.send({
      from: 'alice@node-x:alpha',
      to: VALID_TO,
      content: 'hi',
    });
    expect(foreignNode).toMatchObject({ status: 'rejected', code: 'federation_invalid' });

    expect(calls).toHaveLength(0);
  });

  it('maps a remote rejection to its remote code and never leaks the token', async () => {
    const { fetchImpl, calls } = captureFetch(() =>
      jsonResponse(
        {
          error: {
            code: 'federation_unknown_principal',
            message: 'unknown principal',
          },
        },
        404,
      ),
    );
    const port = createFederationSendPort({
      federation: FEDERATION,
      nodeId: 'node-a',
      env: ENV,
      fetchImpl,
    });

    const result = await port.send({
      from: VALID_FROM,
      to: 'ghost@node-b:beta',
      content: 'hi',
    });

    expect(result).toEqual({
      status: 'rejected',
      code: 'federation_unknown_principal',
      reason: 'unknown principal',
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(calls).toHaveLength(1);
  });

  it('maps client validation errors to error without a request', async () => {
    const { fetchImpl, calls } = captureFetch(() => jsonResponse({ ok: true }));
    const port = createFederationSendPort({
      federation: FEDERATION,
      nodeId: 'node-a',
      env: ENV,
      fetchImpl,
    });

    const result = await port.send({
      from: VALID_FROM,
      to: VALID_TO,
      content: '',
    });

    expect(result).toMatchObject({ status: 'error', code: 'federation_invalid' });
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(calls).toHaveLength(0);
  });

  it('maps a disabled config to rejected without a request', async () => {
    const { fetchImpl, calls } = captureFetch(() => jsonResponse({ ok: true }));
    const port = createFederationSendPort({
      federation: { ...FEDERATION, enabled: false },
      nodeId: 'node-a',
      env: ENV,
      fetchImpl,
    });

    const result = await port.send({
      from: VALID_FROM,
      to: VALID_TO,
      content: 'hi',
    });

    expect(result).toMatchObject({ status: 'rejected', code: 'federation_disabled' });
    expect(calls).toHaveLength(0);
  });
});
