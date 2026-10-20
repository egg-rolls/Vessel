import { describe, expect, it } from 'bun:test';
import type { RunEvent } from '@vessel/core';
import {
  buildContentSecurityPolicy,
  corsHeaders,
  normalizeAllowedOrigins,
  originAllowed,
} from '../src/gateway';
import { errorFrame, eventFrame, gapFrame, helloFrame, resultFrame } from '../src/gateway/frames';
import { sseInflight } from '../src/gateway/sse';
import type { NodeInfo, ProtocolInfo } from '../src/protocol';

const PROTOCOL: ProtocolInfo = {
  name: 'vessel.gateway',
  version: 1,
  min: 1,
  features: [],
};

const NODE: NodeInfo = {
  node_id: 'node-1',
  pid: 1,
  started_at: 0,
  endpoint: 'http://127.0.0.1:8642',
  role: 'standalone',
  status: 'idle',
  capabilities: { tools: [], max_concurrency: 1, protocol: 1 },
};

function request(headers: Record<string, string>, url = 'http://127.0.0.1:8642/v1/x'): Request {
  return new Request(url, { headers });
}

describe('gateway auth helpers', () => {
  it('normalizes explicit origins and rejects wildcards', () => {
    expect(normalizeAllowedOrigins(['HTTP://LocalHost:5173/', 'http://localhost:5173'])).toEqual([
      'http://localhost:5173',
    ]);
    expect(() => normalizeAllowedOrigins(['*'])).toThrow();
  });

  it('returns CORS headers only for allowlisted origins', () => {
    const allowed = ['https://console.example.com'];
    expect(corsHeaders(request({}), allowed)).toEqual({ Vary: 'Origin' });
    expect(corsHeaders(request({ origin: 'https://evil.example.com' }), allowed)).toEqual({
      Vary: 'Origin',
    });
    expect(corsHeaders(request({ origin: 'https://console.example.com' }), allowed)).toMatchObject({
      'Access-Control-Allow-Origin': 'https://console.example.com',
    });
  });

  it('allows same-host or allowlisted origins and rejects others', () => {
    expect(originAllowed(request({}), [])).toBe(true);
    expect(
      originAllowed(request({ origin: 'http://127.0.0.1:8642', host: '127.0.0.1:8642' }), []),
    ).toBe(true);
    expect(
      originAllowed(request({ origin: 'https://evil.example.com', host: '127.0.0.1:8642' }), []),
    ).toBe(false);
  });

  it('builds CSP connect-src from host and allowlist', () => {
    const csp = buildContentSecurityPolicy(request({ host: '127.0.0.1:8642' }), [
      'https://console.example.com',
    ]);
    expect(csp).toContain('connect-src');
    expect(csp).toContain('ws://127.0.0.1:8642');
    expect(csp).toContain('https://console.example.com');
    expect(csp).toContain('wss://console.example.com');
  });
});

describe('gateway frame constructors', () => {
  const event: RunEvent = { type: 'run.started', run_id: 'run-1', data: {}, ts: 1 };

  it('builds event frames with optional job_id', () => {
    expect(eventFrame({ nodeId: 'node-1', seq: 3, event, ts: 42 })).toEqual({
      v: 1,
      kind: 'event',
      node_id: 'node-1',
      ts: 42,
      seq: 3,
      event,
    });
    expect(eventFrame({ nodeId: 'node-1', seq: 3, event, jobId: 'job-1' })).toMatchObject({
      job_id: 'job-1',
    });
  });

  it('prefers the node_id carried by cross-node events', () => {
    const remote = { ...event, node_id: 'node-2' } as RunEvent;
    expect(eventFrame({ nodeId: 'node-1', seq: 1, event: remote })).toMatchObject({
      node_id: 'node-2',
    });
  });

  it('computes hello from_seq against the replay window', () => {
    const base = {
      nodeId: 'node-1',
      protocol: PROTOCOL,
      node: NODE,
      incarnation: 'inc-test-001',
      ts: 5,
    };
    expect(helloFrame({ ...base, fromSeq: 0, latestSeq: 0, oldestSeq: 1 })).toMatchObject({
      kind: 'hello',
      incarnation: 'inc-test-001',
      from_seq: 0,
      latest_seq: 0,
    });
    expect(helloFrame({ ...base, fromSeq: 2, latestSeq: 9, oldestSeq: 4 })).toMatchObject({
      from_seq: 4,
      latest_seq: 9,
    });
    expect(helloFrame({ ...base, fromSeq: 9, latestSeq: 9, oldestSeq: 4 })).toMatchObject({
      from_seq: 10,
    });
  });

  it('builds gap and result/error frames', () => {
    expect(gapFrame({ nodeId: 'node-1', gap: { from_seq: 2, to_seq: 5 }, ts: 7 })).toEqual({
      v: 1,
      kind: 'gap',
      node_id: 'node-1',
      ts: 7,
      from_seq: 2,
      to_seq: 5,
    });
    expect(resultFrame({ nodeId: 'node-1', id: 'r1', result: { ok: true } })).toMatchObject({
      kind: 'res',
      ok: true,
      result: { ok: true },
    });
    expect(errorFrame({ nodeId: 'node-1', id: 'r1' })).toMatchObject({
      kind: 'res',
      ok: false,
      error: { code: 'internal' },
    });
  });

  it('falls back to unacked when desiredSize is unavailable', () => {
    const state = { unacked: 7 } as Parameters<typeof sseInflight>[1];
    const ctrl = { desiredSize: null } as unknown as ReadableStreamDefaultController<unknown>;
    expect(sseInflight(ctrl, state)).toBe(7);
  });
});
