import { describe, expect, it } from 'bun:test';
import { injectTokenIntoAuthFrame, isAllowedDevOrigin } from '../dev-web-lib';

describe('dev relay auth frame', () => {
  it('relay replaces only the auth frame token and preserves since and tenant_id', () => {
    const raw = JSON.stringify({
      v: 1,
      kind: 'auth',
      token: 'placeholder-token',
      since: 42,
      tenant_id: 'tenant-a',
    });

    const replaced = JSON.parse(injectTokenIntoAuthFrame(raw, 'real-token')) as Record<
      string,
      unknown
    >;

    expect(replaced.token).toBe('real-token');
    expect(replaced.since).toBe(42);
    expect(replaced.tenant_id).toBe('tenant-a');
    expect(replaced.v).toBe(1);
    expect(replaced.kind).toBe('auth');
    expect(Object.keys(replaced).sort()).toEqual(['kind', 'since', 'tenant_id', 'token', 'v']);
  });

  it('relay forwards non-auth frames unchanged', () => {
    const raw = JSON.stringify({
      v: 1,
      kind: 'req',
      id: 'req-1',
      method: 'run.start',
      token: 'must-not-change',
    });

    expect(injectTokenIntoAuthFrame(raw, 'real-token')).toBe(raw);
  });

  it('invalid auth frame is forwarded unchanged', () => {
    expect(injectTokenIntoAuthFrame('{not json', 'real-token')).toBe('{not json');
    expect(injectTokenIntoAuthFrame('{"kind":"auth"', 'real-token')).toBe('{"kind":"auth"');
    expect(injectTokenIntoAuthFrame('["auth"]', 'real-token')).toBe('["auth"]');
    expect(injectTokenIntoAuthFrame('"auth"', 'real-token')).toBe('"auth"');
  });

  it('empty token is still written into the auth frame', () => {
    const raw = JSON.stringify({ v: 1, kind: 'auth', token: 'placeholder', since: 0 });
    const replaced = JSON.parse(injectTokenIntoAuthFrame(raw, '')) as Record<string, unknown>;

    expect(replaced.token).toBe('');
    expect(replaced.since).toBe(0);
  });
});

describe('dev relay origin guard', () => {
  it('accepts the Vite dev origins and non-browser clients', () => {
    expect(isAllowedDevOrigin(null)).toBe(true);
    expect(isAllowedDevOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isAllowedDevOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedDevOrigin('HTTP://LOCALHOST:5173')).toBe(true);
  });

  it('rejects a foreign web page origin', () => {
    expect(isAllowedDevOrigin('https://evil.example')).toBe(false);
    expect(isAllowedDevOrigin('http://127.0.0.1:5174')).toBe(false);
    expect(isAllowedDevOrigin('null')).toBe(false);
  });
});
