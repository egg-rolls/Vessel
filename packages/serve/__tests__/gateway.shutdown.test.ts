/**
 * 0.10 R2-18：gateway.stop() 以 `shutdown` 中断 active run，并限时等待终态。
 *
 * 断言 checkpoint 终态是 `interrupted`（可 resume）而不是用户取消的 `cancelled`，
 * 且 stop() resolve 时终态已经落盘；重复 stop 幂等。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  type ChatRequest,
  type LLMProvider,
  type LLMResponse,
  MemoryContextManager,
  MemoryEventStream,
  MemoryPluginHost,
  MemoryRunStore,
  MemorySessionBackend,
} from '@vessel-agent/core';
import { isResumableStatus } from '../src/durable';
import { type Gateway, startGateway } from '../src/gateway';

/** 挂起直到 signal abort 的 provider；可选在 abort 后延迟 reject 以验证 stop 等待。 */
class ShutdownProvider implements LLMProvider {
  private resolveStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  constructor(private readonly rejectDelayMs = 0) {}

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.resolveStarted();
    const signal = req.signal;
    return await new Promise<LLMResponse>((_resolve, reject) => {
      const fail = (): void => {
        if (this.rejectDelayMs > 0) {
          setTimeout(
            () => reject(new Error(String(signal?.reason ?? 'aborted'))),
            this.rejectDelayMs,
          );
          return;
        }
        reject(new Error(String(signal?.reason ?? 'aborted')));
      };
      if (!signal) {
        reject(new Error('missing abort signal'));
        return;
      }
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener('abort', fail, { once: true });
    });
  }
}

interface Parts {
  gateway: Gateway;
  runtime: AgentRuntime;
  provider: ShutdownProvider;
  store: MemoryRunStore;
}

const gateways: Gateway[] = [];

afterEach(() => {
  for (const gateway of gateways.splice(0)) void gateway.stop();
});

async function setup(rejectDelayMs = 0): Promise<Parts> {
  const events = new MemoryEventStream();
  const store = new MemoryRunStore();
  const provider = new ShutdownProvider(rejectDelayMs);
  const runtime = await AgentRuntime.create({
    provider,
    model: 'test-model',
    pluginHost: new MemoryPluginHost(),
    context: new MemoryContextManager(),
    events,
    limits: { requestLimit: 20, toolCallsLimit: 5 },
    termination: { maxIterations: 20 },
    session: new MemorySessionBackend(),
    runStore: store,
  });
  const gateway = startGateway({ events, port: 0, runtime });
  gateways.push(gateway);
  return { gateway, runtime, provider, store };
}

async function startRun(gateway: Gateway, input = 'hello'): Promise<void> {
  const response = await fetch(`${gateway.url}/v1/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gateway.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      id: crypto.randomUUID(),
      method: 'runs.start',
      params: { input },
    }),
  });
  const body = (await response.json()) as { ok?: boolean; error?: { code?: string } };
  expect(body.ok).toBe(true);
}

describe('gateway stop drain (0.10 R2-18)', () => {
  it('interrupts the active run as shutdown so its checkpoint is interrupted', async () => {
    const { gateway, provider, store } = await setup();
    await startRun(gateway);
    await provider.started;

    await gateway.stop();

    const [checkpoint] = await store.list();
    expect(checkpoint?.status).toBe('interrupted');
    expect(checkpoint !== undefined && isResumableStatus(checkpoint.status)).toBe(true);
  });

  it('waits for the active run to reach its terminal checkpoint', async () => {
    const { gateway, provider, store } = await setup(30);
    await startRun(gateway);
    await provider.started;

    await gateway.stop();

    // provider 在 abort 后 30ms 才 reject；若 stop 不等待，这里仍是 running。
    const [checkpoint] = await store.list();
    expect(checkpoint?.status).toBe('interrupted');
  });

  it('is idempotent: repeated stop returns the same promise and interrupts once', async () => {
    const { gateway, runtime, provider } = await setup();
    const reasons: Array<string | undefined> = [];
    const original = runtime.interrupt.bind(runtime);
    runtime.interrupt = (reason) => {
      reasons.push(reason);
      original(reason);
    };

    await startRun(gateway);
    await provider.started;

    const first = gateway.stop();
    const second = gateway.stop();
    expect(second).toBe(first);
    await first;
    await gateway.stop();

    expect(reasons).toEqual(['shutdown']);
  });
});
