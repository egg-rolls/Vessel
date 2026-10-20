import { describe, expect, it } from 'bun:test';
import {
  checkGatewayUrl,
  isLoopbackHostname,
  resolveInitialGatewayUrl,
  toWebSocketBase,
} from '../src/gatewayUrl';

describe('checkGatewayUrl', () => {
  it('treats an empty value as same-origin', () => {
    expect(checkGatewayUrl('', 'https:')).toEqual({ ok: true, value: '' });
    expect(checkGatewayUrl('   ', 'https:')).toEqual({ ok: true, value: '' });
  });

  it('accepts https remote origins and strips trailing slash', () => {
    expect(checkGatewayUrl('https://gw.example.com:8642/', 'https:')).toEqual({
      ok: true,
      value: 'https://gw.example.com:8642',
    });
    expect(checkGatewayUrl('https://GW.Example.COM/', 'https:')).toEqual({
      ok: true,
      value: 'https://gw.example.com',
    });
  });

  it('accepts loopback http on an http page', () => {
    for (const raw of ['http://127.0.0.1:8642', 'http://localhost:8642/', 'http://[::1]:8642']) {
      expect(checkGatewayUrl(raw, 'http:').ok).toBe(true);
    }
  });

  it('normalizes ws/wss to http(s)', () => {
    expect(checkGatewayUrl('ws://127.0.0.1:8642', 'http:')).toEqual({
      ok: true,
      value: 'http://127.0.0.1:8642',
    });
    expect(checkGatewayUrl('wss://gw.example.com', 'https:')).toEqual({
      ok: true,
      value: 'https://gw.example.com',
    });
  });

  it('rejects non-loopback http', () => {
    const result = checkGatewayUrl('http://gw.example.com', 'http:');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTPS');
  });

  it('rejects http from an https page (mixed content)', () => {
    const result = checkGatewayUrl('http://127.0.0.1:8642', 'https:');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('mixed content');
  });

  it('rejects path/query/hash/credentials/wildcard', () => {
    for (const raw of [
      'https://gw.example.com/v1',
      'https://gw.example.com?x=1',
      'https://gw.example.com#top',
      'https://user:pass@gw.example.com',
      '*',
    ]) {
      expect(checkGatewayUrl(raw, 'https:').ok).toBe(false);
    }
  });

  it('rejects unsupported schemes and malformed input', () => {
    for (const raw of ['ftp://gw.example.com', 'gw.example.com', 'not a url']) {
      expect(checkGatewayUrl(raw, 'https:').ok).toBe(false);
    }
  });
});

describe('resolveInitialGatewayUrl', () => {
  it('prefers localStorage over VITE_GATEWAY_URL', () => {
    expect(
      resolveInitialGatewayUrl('https://stored.example.com', 'https://env.example.com', 'https:'),
    ).toEqual({ ok: true, value: 'https://stored.example.com' });
  });

  it('falls back to VITE_GATEWAY_URL when storage is empty', () => {
    expect(resolveInitialGatewayUrl('', 'https://env.example.com', 'https:')).toEqual({
      ok: true,
      value: 'https://env.example.com',
    });
    expect(resolveInitialGatewayUrl(null, 'https://env.example.com', 'https:')).toEqual({
      ok: true,
      value: 'https://env.example.com',
    });
  });

  it('falls back to same-origin when both are empty', () => {
    expect(resolveInitialGatewayUrl(null, undefined, 'https:')).toEqual({ ok: true, value: '' });
  });

  it('surfaces an invalid stored value instead of silently falling back', () => {
    const result = resolveInitialGatewayUrl(
      'http://evil.example',
      'https://env.example.com',
      'https:',
    );
    expect(result.ok).toBe(false);
    expect(result.value).toBe('');
  });
});

describe('helpers', () => {
  it('detects loopback hostnames', () => {
    for (const host of ['localhost', '127.0.0.1', '127.8.9.10', '::1', '[::1]']) {
      expect(isLoopbackHostname(host)).toBe(true);
    }
    for (const host of ['example.com', '10.0.0.1', '192.168.1.1', '::2']) {
      expect(isLoopbackHostname(host)).toBe(false);
    }
  });

  it('derives ws/wss bases', () => {
    expect(toWebSocketBase('')).toBe('');
    expect(toWebSocketBase('http://127.0.0.1:8642')).toBe('ws://127.0.0.1:8642');
    expect(toWebSocketBase('https://gw.example.com')).toBe('wss://gw.example.com');
  });
});
