import { describe, expect, it } from 'bun:test';
import { DEV_PROXY_TOKEN, resolveConnectionSeed } from '../src/gateway/dev-auth';

const base = {
  dev: true,
  proxyFlag: '1' as string | undefined,
  explicitToken: '',
  storedUrl: null as string | null,
  envUrl: undefined as string | undefined,
};

describe('resolveConnectionSeed', () => {
  it('production build never enables the dev proxy bypass', () => {
    const seed = resolveConnectionSeed({ ...base, dev: false });
    expect(seed.devProxyAuth).toBe(false);
    expect(seed.token).toBe('');
    expect(seed.gatewayUrl).toBe('');
  });

  it('explicit session token disables the dev proxy seed', () => {
    const seed = resolveConnectionSeed({ ...base, explicitToken: 'user-token' });
    expect(seed.devProxyAuth).toBe(false);
    expect(seed.token).toBe('user-token');
    expect(seed.gatewayUrl).toBe('');
  });

  it('explicit gateway URL disables the dev proxy seed', () => {
    const seed = resolveConnectionSeed({
      ...base,
      storedUrl: 'https://gw.example.com:8642',
    });
    expect(seed.devProxyAuth).toBe(false);
    expect(seed.token).toBe('');
    expect(seed.gatewayUrl).toBe('https://gw.example.com:8642');
  });

  it('dev proxy seed uses same-origin and a non-secret placeholder token', () => {
    const seed = resolveConnectionSeed(base);
    expect(seed.devProxyAuth).toBe(true);
    expect(seed.gatewayUrl).toBe('');
    expect(seed.token).toBe(DEV_PROXY_TOKEN);
    expect(DEV_PROXY_TOKEN).not.toBe('');
    // 占位值不是用户凭据：不应看起来像密钥，也不随持久化写入。
    expect(DEV_PROXY_TOKEN).toBe('vessel-dev-proxy');
  });

  it('requires both the dev build and the explicit flag', () => {
    expect(resolveConnectionSeed({ ...base, proxyFlag: undefined }).devProxyAuth).toBe(false);
    expect(resolveConnectionSeed({ ...base, proxyFlag: '0' }).devProxyAuth).toBe(false);
    expect(resolveConnectionSeed({ ...base, dev: false, proxyFlag: '1' }).devProxyAuth).toBe(false);
  });
});
