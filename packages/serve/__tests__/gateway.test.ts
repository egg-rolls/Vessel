import { afterEach, describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  MemoryContextManager,
  MemoryEventStream,
  MemoryLLMProvider,
  MemorySessionBackend,
  MemoryToolRegistry,
} from '@vessel/core';
import { type Gateway, startGateway } from '../src/gateway';

/** 构造一个 echo 式 mock runtime（MemoryLLMProvider 回显输入） */
function makeRuntime(events: MemoryEventStream): Promise<AgentRuntime> {
  return AgentRuntime.create({
    provider: new MemoryLLMProvider(),
    model: 'test-model',
    tools: new MemoryToolRegistry(),
    context: new MemoryContextManager(),
    events,
    limits: { requestLimit: 10, toolCallsLimit: 5 },
    termination: { maxIterations: 10 },
  });
}

describe('startGateway', () => {
  let gw: Gateway | undefined;

  afterEach(() => {
    gw?.stop();
    gw = undefined;
  });

  it('serves /health without auth', async () => {
    gw = startGateway({ events: new MemoryEventStream(), port: 0 });
    const res = await fetch(`${gw.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('rejects protected endpoints without token', async () => {
    gw = startGateway({
      events: new MemoryEventStream(),
      session: new MemorySessionBackend(),
      port: 0,
    });
    const res = await fetch(`${gw.url}/sessions`);
    expect(res.status).toBe(401);
  });

  it('lists sessions with token', async () => {
    const session = new MemorySessionBackend();
    gw = startGateway({ events: new MemoryEventStream(), session, port: 0 });
    const res = await fetch(`${gw.url}/sessions?token=${gw.token}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions).toBeArray();
  });

  it('runs a prompt via /run (inbound control)', async () => {
    const events = new MemoryEventStream();
    const runtime = await makeRuntime(events);
    gw = startGateway({ events, runtime, port: 0 });
    const res = await fetch(`${gw.url}/run?token=${gw.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hello' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: string };
    expect(body.output).toBe('Echo: Hello');
  });
});
