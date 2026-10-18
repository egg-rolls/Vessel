import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel/core';
import type { EvalReport } from '../src/evals';
import type { Gateway } from '../src/gateway';
import { createGateway } from './helpers';

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    suite: 'smoke',
    network: false,
    started_at: 1000,
    finished_at: 2000,
    duration_ms: 1000,
    total: 1,
    passed: 1,
    failed: 0,
    errors: 0,
    skipped: 0,
    cases: [
      {
        id: 'basic',
        status: 'passed',
        duration_ms: 10,
        assertions: [{ type: 'no_error', ok: true }],
        output: 'hello',
      },
    ],
    ...overrides,
  };
}

describe('gateway evals endpoint', () => {
  const gateways: Gateway[] = [];

  const start = (latest?: (suite: string) => Promise<EvalReport | null>): Gateway => {
    const gw = createGateway({
      events: new MemoryEventStream(),
      ...(latest ? { evals: { latest } } : {}),
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

  it('returns eval_not_found when not injected', async () => {
    const gw = start();
    const res = await fetch(`${gw.url}/v1/evals/latest?suite=smoke`, { headers: auth(gw) });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('eval_not_found');
  });

  it('returns eval_not_found when there is no report', async () => {
    const gw = start(async () => null);
    const res = await fetch(`${gw.url}/v1/evals/latest?suite=smoke`, { headers: auth(gw) });
    expect(res.status).toBe(404);
  });

  it('returns a normalized report', async () => {
    let requested = '';
    const gw = start(async (suite) => {
      requested = suite;
      return report();
    });
    const res = await fetch(`${gw.url}/v1/evals/latest?suite=smoke`, { headers: auth(gw) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: EvalReport };
    expect(requested).toBe('smoke');
    expect(body.report.suite).toBe('smoke');
    expect(body.report.cases).toHaveLength(1);
    expect(body.report.cases[0]?.assertions).toEqual([{ type: 'no_error', ok: true }]);
  });

  it('requires a safe suite name', async () => {
    const gw = start(async () => report());
    for (const query of ['', '?suite=', '?suite=../x', '?suite=a/b', '?suite=a..b']) {
      const res = await fetch(`${gw.url}/v1/evals/latest${query}`, { headers: auth(gw) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'invalid_request',
      );
    }
  });

  it('maps control-plane errors', async () => {
    const gw = start(async () => {
      throw Object.assign(new Error('missing'), { code: 'eval_not_found' });
    });
    const missing = await fetch(`${gw.url}/v1/evals/latest?suite=smoke`, { headers: auth(gw) });
    expect(missing.status).toBe(404);

    const invalid = start(async () => {
      throw Object.assign(new Error('bad suite'), { code: 'eval_invalid' });
    });
    const bad = await fetch(`${invalid.url}/v1/evals/latest?suite=smoke`, {
      headers: auth(invalid),
    });
    expect(bad.status).toBe(400);
  });

  it('rejects non-GET methods', async () => {
    const gw = start(async () => report());
    const res = await fetch(`${gw.url}/v1/evals/latest?suite=smoke`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(res.status).toBe(405);
  });
});
