import { describe, expect, test } from 'bun:test';
import {
  extractTokenFromHash,
  formatRoute,
  parseRoute,
  type Route,
  sameRoute,
} from '../src/app/router';

const ROUTES: Route[] = [
  { domain: 'chat' },
  { domain: 'chat', sessionId: 'new' },
  { domain: 'chat', sessionId: 'session-1' },
  { domain: 'chat', sessionId: 'session-1', agent: 'delegate-1' },
  { domain: 'runs', tab: 'live' },
  { domain: 'runs', tab: 'durable', runId: 'run 1', sessionId: 's/2' },
  { domain: 'workflows' },
  { domain: 'workflows', workflowId: 'wf_1' },
  { domain: 'integrations', tab: 'tools' },
  { domain: 'integrations', tab: 'mcp' },
  { domain: 'integrations', tab: 'channels' },
  { domain: 'observe', tab: 'metrics' },
  { domain: 'observe', tab: 'evals' },
  { domain: 'settings', tab: 'connection' },
  { domain: 'settings', tab: 'nodes' },
  { domain: 'settings', tab: 'config' },
  { domain: 'settings', tab: 'capabilities' },
  { domain: 'settings', tab: 'tenants' },
  { domain: 'settings', tab: 'appearance' },
];

describe('parseRoute / formatRoute', () => {
  test('round-trips every Route variant', () => {
    for (const route of ROUTES) {
      expect(parseRoute(formatRoute(route))).toEqual(route);
    }
  });

  test('parses deep links and query filters', () => {
    expect(parseRoute('#/runs?tab=durable&run=r1&session=s1')).toEqual({
      domain: 'runs',
      tab: 'durable',
      runId: 'r1',
      sessionId: 's1',
    });
    expect(parseRoute('#/runs/r1')).toEqual({ domain: 'runs', tab: 'live', runId: 'r1' });
    expect(parseRoute('#/settings/tenants')).toEqual({
      domain: 'settings',
      tab: 'tenants',
    });
  });

  test('falls back to chat for unknown or empty routes', () => {
    for (const hash of ['', '#', '#/', '#/unknown', '#/Runs', '#/chat/extra/path']) {
      expect(parseRoute(hash).domain).toBe('chat');
    }
    expect(parseRoute('')).toEqual({ domain: 'chat' });
  });

  test('keeps unknown tab values away from the Route union', () => {
    expect(parseRoute('#/runs?tab=weird')).toEqual({ domain: 'runs', tab: 'live' });
    expect(parseRoute('#/settings/weird')).toEqual({
      domain: 'settings',
      tab: 'connection',
    });
  });

  test('parses and formats the subagent deep link', () => {
    expect(parseRoute('#/chat/s1?agent=delegate%201')).toEqual({
      domain: 'chat',
      sessionId: 's1',
      agent: 'delegate 1',
    });
    expect(formatRoute({ domain: 'chat', sessionId: 's1', agent: 'delegate 1' })).toBe(
      '#/chat/s1?agent=delegate+1',
    );
    // 未知/空 agent 不影响会话路由。
    expect(parseRoute('#/chat/s1?agent=')).toEqual({ domain: 'chat', sessionId: 's1' });
  });

  test('decodes ids and preserves ids that cannot be decoded', () => {
    expect(parseRoute('#/chat/a%20b')).toEqual({ domain: 'chat', sessionId: 'a b' });
    expect(parseRoute('#/chat/%E0%A4%A')).toEqual({ domain: 'chat', sessionId: '%E0%A4%A' });
  });

  test('sameRoute compares canonical hashes', () => {
    expect(sameRoute({ domain: 'runs', tab: 'live' }, { domain: 'runs', tab: 'live' })).toBe(true);
    expect(sameRoute({ domain: 'runs', tab: 'live' }, { domain: 'runs', tab: 'durable' })).toBe(
      false,
    );
  });
});

describe('extractTokenFromHash', () => {
  test('extracts #token= and clears the hash', () => {
    expect(extractTokenFromHash('#token=abc&other=1')).toEqual({
      token: 'abc',
      restHash: '',
    });
  });

  test('leaves ordinary routes untouched', () => {
    expect(extractTokenFromHash('#/chat?token=abc')).toEqual({
      restHash: '#/chat?token=abc',
    });
    expect(extractTokenFromHash('#/runs')).toEqual({ restHash: '#/runs' });
  });

  test('empty token is not treated as a credential', () => {
    expect(extractTokenFromHash('#token=')).toEqual({ restHash: '#token=' });
  });
});
