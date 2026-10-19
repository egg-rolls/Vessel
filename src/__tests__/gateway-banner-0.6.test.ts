import { describe, expect, it } from 'bun:test';
import type { Gateway } from '../../packages/serve/src/index';
import { renderGatewayBanner } from '../gateway-banner';

describe('gateway banner (0.6 P2 token redaction)', () => {
  it('never prints the gateway token or token-bearing URLs', () => {
    const gateway = {
      url: 'https://127.0.0.1:8642',
      token: 'super-secret-token-value',
      tls: true,
    } as unknown as Gateway;

    const banner = renderGatewayBanner(gateway);
    expect(banner).toContain('https://127.0.0.1:8642');
    expect(banner).toContain('***');
    expect(banner).not.toContain('super-secret-token-value');
    expect(banner).not.toContain('token=');
    expect(banner).not.toContain('super');
  });
});
