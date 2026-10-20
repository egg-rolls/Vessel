import { afterEach, describe, expect, it } from 'bun:test';
import {
  MemoryContextManager,
  MemoryEventStream,
  MemoryPluginHost,
  MemorySessionBackend,
} from '@vessel/core';
import type { Gateway } from '../src/gateway';
import type { RunStatus } from '../src/protocol';
import {
  createGateway,
  createRuntime,
  RecordingProvider,
  SlowProvider,
  TestWs,
  waitUntil,
} from './helpers';

describe('gateway core', () => {
  const gateways: Gateway[] = [];
  const clients: TestWs[] = [];

  const track = (gw: Gateway): Gateway => {
    gateways.push(gw);
    return gw;
  };

  const wsConnect = async (gw: Gateway, opts?: { token?: string | null }) => {
    const client = await TestWs.connect(gw, opts);
    clients.push(client);
    return client;
  };

  const authHeaders = (gw: Gateway): Record<string, string> => ({
    Authorization: `Bearer ${gw.token}`,
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    for (const gw of gateways.splice(0)) gw.stop();
  });

  it('serves /v1/health without auth and advertises protocol v1', async () => {
    const events = new MemoryEventStream();
    const gw = track(createGateway({ events }));
    const res = await fetch(`${gw.url}/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      protocol: { name: string; version: number };
      node: { node_id: string; capabilities: { max_concurrency: number } };
    };
    expect(body.status).toBe('ok');
    expect(body.protocol.name).toBe('vessel.gateway');
    expect(body.protocol.version).toBe(1);
    expect(body.node.node_id).toBe(gw.nodeId);
    expect(body.node.capabilities.max_concurrency).toBe(1);
  });

  it('keeps legacy /health shape', async () => {
    const gw = track(createGateway({ events: new MemoryEventStream() }));
    const body = (await (await fetch(`${gw.url}/health`)).json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('rejects protected endpoints without a token', async () => {
    const gw = track(
      createGateway({ events: new MemoryEventStream(), session: new MemorySessionBackend() }),
    );
    for (const path of ['/v1/sessions', '/v1/tools', '/v1/runs']) {
      const res = await fetch(`${gw.url}${path}`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthorized');
    }
  });

  it('accepts Bearer header but rejects query token on REST', async () => {
    const gw = track(
      createGateway({ events: new MemoryEventStream(), session: new MemorySessionBackend() }),
    );
    const viaHeader = await fetch(`${gw.url}/v1/sessions`, { headers: authHeaders(gw) });
    expect(viaHeader.status).toBe(200);
    const viaQuery = await fetch(`${gw.url}/v1/sessions?token=${gw.token}`);
    expect(viaQuery.status).toBe(401);
  });

  it('rejects cross-origin browser requests and allows configured origins', async () => {
    const events = new MemoryEventStream();
    const gw = track(
      createGateway({
        events,
        session: new MemorySessionBackend(),
        allowedOrigins: ['http://localhost:5173'],
      }),
    );

    const denied = await fetch(`${gw.url}/v1/sessions`, {
      headers: { ...authHeaders(gw), Origin: 'http://evil.example' },
    });
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as { error: { code: string } };
    expect(deniedBody.error.code).toBe('forbidden_origin');

    const allowed = await fetch(`${gw.url}/v1/sessions`, {
      headers: { ...authHeaders(gw), Origin: 'http://localhost:5173' },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('rejects unsupported protocol versions', async () => {
    const gw = track(createGateway({ events: new MemoryEventStream() }));
    const res = await fetch(`${gw.url}/v1/health`, {
      headers: { 'X-Vessel-Protocol': '2' },
    });
    expect(res.status).toBe(426);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unsupported_protocol');
  });

  it('lists tools from the plugin host without leaking handlers', async () => {
    const events = new MemoryEventStream();
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool({
      name: 'demo_tool',
      description: 'Demo tool',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'demo',
      checkPermission: async () => 'allow',
    });
    const runtime = await createRuntime({ events, pluginHost });
    const gw = track(createGateway({ events, runtime, pluginHost }));

    const body = (await (
      await fetch(`${gw.url}/v1/tools`, { headers: authHeaders(gw) })
    ).json()) as {
      tools: Array<{ name: string; has_permission_check: boolean; handler?: unknown }>;
    };
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]?.name).toBe('demo_tool');
    expect(body.tools[0]?.has_permission_check).toBe(true);
    expect(body.tools[0]?.handler).toBeUndefined();
  });

  it('submits a run asynchronously and reports status via events', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events });
    const gw = track(createGateway({ events, runtime }));

    const res = await fetch(`${gw.url}/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(gw), 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hello' }),
    });
    expect(res.status).toBe(202);
    const submitted = (await res.json()) as { run_id: string; status: string };
    expect(submitted.status).toBe('running');

    const client = await wsConnect(gw);
    await client.nextEvent('run.started');
    const completed = await client.nextEvent('run.completed');
    expect(completed.output).toBe('Echo: Hello');

    await waitUntil(async () => {
      const statusRes = await fetch(`${gw.url}/v1/runs/${submitted.run_id}`, {
        headers: authHeaders(gw),
      });
      const status = (await statusRes.json()) as RunStatus;
      return status.status === 'completed';
    });
    const status = (await (
      await fetch(`${gw.url}/v1/runs/${submitted.run_id}`, { headers: authHeaders(gw) })
    ).json()) as RunStatus;
    expect(status.output).toBe('Echo: Hello');
    expect(typeof status.core_run_id).toBe('string');
  });

  it('keeps the blocking legacy /run endpoint', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events });
    const gw = track(createGateway({ events, runtime }));
    const res = await fetch(`${gw.url}/run`, {
      method: 'POST',
      headers: { ...authHeaders(gw), 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hello' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: string };
    expect(body.output).toBe('Echo: Hello');
  });

  it('validates request bodies', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events });
    const gw = track(createGateway({ events, runtime, maxBodyBytes: 64 }));

    const badJson = await fetch(`${gw.url}/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(gw), 'Content-Type': 'application/json' },
      body: '{oops',
    });
    expect(badJson.status).toBe(400);

    const badType = await fetch(`${gw.url}/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(gw), 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(badType.status).toBe(415);

    const tooLarge = await fetch(`${gw.url}/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(gw), 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'x'.repeat(200) }),
    });
    expect(tooLarge.status).toBe(413);

    const empty = await fetch(`${gw.url}/v1/runs`, {
      method: 'POST',
      headers: { ...authHeaders(gw), 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '' }),
    });
    expect(empty.status).toBe(400);
  });

  it('queues runs serially and cancels queued/running work', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events, provider: new SlowProvider(400) });
    const gw = track(createGateway({ events, runtime }));
    const client = await wsConnect(gw);

    const submit = async (input: string) => {
      const res = await fetch(`${gw.url}/v1/runs`, {
        method: 'POST',
        headers: { ...authHeaders(gw), 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      });
      expect(res.status).toBe(202);
      return (await res.json()) as { run_id: string; status: string; queue_position?: number };
    };

    const first = await submit('first');
    const second = await submit('second');
    expect(second.status).toBe('queued');
    expect(second.queue_position).toBe(1);

    const cancelSecond = await fetch(`${gw.url}/v1/runs/${second.run_id}/cancel`, {
      method: 'POST',
      headers: authHeaders(gw),
    });
    expect(cancelSecond.status).toBe(200);
    expect(((await cancelSecond.json()) as { cancelled: boolean }).cancelled).toBe(true);

    await client.nextEvent('run.started');
    const cancelFirst = await fetch(`${gw.url}/v1/runs/${first.run_id}/cancel`, {
      method: 'POST',
      headers: authHeaders(gw),
    });
    expect(((await cancelFirst.json()) as { cancelled: boolean }).cancelled).toBe(true);

    await waitUntil(async () => {
      const res = await fetch(`${gw.url}/v1/runs/${first.run_id}`, {
        headers: authHeaders(gw),
      });
      return ((await res.json()) as RunStatus).status === 'cancelled';
    });
  });

  it('caps the queue and reports busy', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events, provider: new SlowProvider(50) });
    const gw = track(createGateway({ events, runtime, maxQueue: 2 }));
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${gw.url}/v1/runs`, {
        method: 'POST',
        headers: { ...authHeaders(gw), 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: `run-${i}` }),
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([202, 202, 429]);
  });

  it('clears context when switching sessions (G2)', async () => {
    const events = new MemoryEventStream();
    const context = new MemoryContextManager();
    const session = new MemorySessionBackend();
    const provider = new RecordingProvider();
    const runtime = await createRuntime({ events, provider, context, session });
    const gw = track(createGateway({ events, runtime, context, session }));

    const run = async (input: string, sessionId: string) => {
      const res = await fetch(`${gw.url}/v1/runs`, {
        method: 'POST',
        headers: { ...authHeaders(gw), 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, session_id: sessionId }),
      });
      expect(res.status).toBe(202);
      const { run_id } = (await res.json()) as { run_id: string };
      await waitUntil(async () => {
        const statusRes = await fetch(`${gw.url}/v1/runs/${run_id}`, {
          headers: authHeaders(gw),
        });
        return ((await statusRes.json()) as RunStatus).status === 'completed';
      });
    };

    await run('alpha-message', 'session-a');
    await run('beta-message', 'session-b');

    const secondRequest = provider.requests[1];
    expect(secondRequest).toBeDefined();
    const contents = (secondRequest?.messages ?? []).map((message) => message.content);
    expect(contents).not.toContain('alpha-message');
    expect(contents).toContain('beta-message');
  });
});
