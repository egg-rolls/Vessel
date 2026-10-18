import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel/core';
import type { Gateway } from '../src/gateway';
import type { MetricsSnapshot } from '../src/metrics';
import { createGateway } from './helpers';

function snapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    runs: { started: 3, completed: 2, failed: 1, cancelled: 0 },
    tool_calls: { total: 4, failed: 1 },
    llm: { requests: 5, prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    duration_ms: { total: 1000, max: 600, avg: 500 },
    updated_at: 1234,
    ...overrides,
  };
}

describe('gateway metrics endpoint', () => {
  const gateways: Gateway[] = [];

  const start = (metrics?: () => MetricsSnapshot): Gateway => {
    const gw = createGateway({
      events: new MemoryEventStream(),
      ...(metrics ? { metrics } : {}),
    });
    gateways.push(gw);
    return gw;
  };

  const auth = (gw: Gateway): Record<string, string> => ({
    Authorization: `Bearer ${gw.token}`,
  });

  afterEach(() => {
    for (const gw of gateways.splice(0)) gw.stop();
  });

  it('returns metrics_disabled when not injected', async () => {
    const gw = start();
    const res = await fetch(`${gw.url}/v1/metrics`, { headers: auth(gw) });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('metrics_disabled');
  });

  it('returns the normalized snapshot', async () => {
    const gw = start(() => snapshot());
    const res = await fetch(`${gw.url}/v1/metrics`, { headers: auth(gw) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { metrics: MetricsSnapshot };
    expect(body.metrics).toEqual(snapshot());
  });

  it('fills missing fields and drops invalid ones', async () => {
    const gw = start(
      () =>
        ({
          runs: { started: 2 },
          duration_ms: { avg: 4.5 },
          updated_at: 9,
        }) as unknown as MetricsSnapshot,
    );
    const res = await fetch(`${gw.url}/v1/metrics`, { headers: auth(gw) });
    const body = (await res.json()) as { metrics: MetricsSnapshot };
    expect(body.metrics.runs).toEqual({
      started: 2,
      completed: 0,
      failed: 0,
      cancelled: 0,
    });
    expect(body.metrics.duration_ms.avg).toBe(4.5);
  });

  it('maps provider failures to internal', async () => {
    const gw = start(() => {
      throw new Error('boom');
    });
    const res = await fetch(`${gw.url}/v1/metrics`, { headers: auth(gw) });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('internal');
  });

  it('rejects non-GET methods', async () => {
    const gw = start(() => snapshot());
    const res = await fetch(`${gw.url}/v1/metrics`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(res.status).toBe(405);
  });
});
