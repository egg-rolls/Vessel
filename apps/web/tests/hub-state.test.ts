import { describe, expect, test } from 'bun:test';
import { hubInfoFromConfig } from '../src/domains/hub/hub-state';

describe('hubInfoFromConfig', () => {
  test('treats a missing hub section as the default local hub', () => {
    expect(hubInfoFromConfig({})).toEqual({ state: 'local', autoStart: true });
    expect(hubInfoFromConfig(undefined)).toEqual({ state: 'local', autoStart: true });
  });

  test('reports joined only when a node direction has a hub URL', () => {
    expect(
      hubInfoFromConfig({ hub: { direction: 'node', url: 'https://hub.example' } }),
    ).toMatchObject({ state: 'joined', url: 'https://hub.example', direction: 'node' });
    // 只有 direction=node、没有 url 时不伪装成已加入。
    expect(hubInfoFromConfig({ hub: { direction: 'node' } }).state).toBe('local');
  });

  test('autoStart false without a hub URL is not configured', () => {
    expect(hubInfoFromConfig({ hub: { autoStart: false } })).toMatchObject({
      state: 'not_configured',
      autoStart: false,
    });
    expect(hubInfoFromConfig({ hub: { direction: 'hub' } }).state).toBe('local');
  });

  test('formats the loopback listen address when present', () => {
    expect(
      hubInfoFromConfig({ hub: { listen: { hostname: '127.0.0.1', port: 0 } } }),
    ).toMatchObject({ listen: '127.0.0.1:0' });
  });
});
