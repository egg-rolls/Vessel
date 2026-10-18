/**
 * A6-10：config 快照不得暴露其它 tenant 的 overlay。
 */

import { describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import { sanitizeConfigForSnapshot } from '../config-snapshot';

describe('sanitizeConfigForSnapshot', () => {
  it('removes tenant.tenants but keeps tenant.default', () => {
    const config: VesselConfig = {
      provider: { name: 'openai', model: 'gpt-4' },
      tenant: {
        default: 'acme',
        tenants: {
          acme: { config: { agent: { systemPrompt: 'acme-prompt' } } },
          work: { config: { agent: { systemPrompt: 'work-prompt' } } },
        },
      },
    };

    const snapshot = sanitizeConfigForSnapshot(config);
    expect(snapshot.tenant).toEqual({ default: 'acme' });
    expect(JSON.stringify(snapshot)).not.toContain('acme-prompt');
    expect(JSON.stringify(snapshot)).not.toContain('work-prompt');
  });

  it('drops an empty tenant block and does not mutate the input', () => {
    const config: VesselConfig = {
      tenant: { tenants: { acme: { config: {} }, work: { config: {} } } },
    };

    const snapshot = sanitizeConfigForSnapshot(config);
    expect(snapshot.tenant).toBeUndefined();
    expect(config.tenant?.tenants).toBeDefined();
  });

  it('leaves configs without a tenant block unchanged', () => {
    const config: VesselConfig = { provider: { name: 'openai', model: 'gpt-4' } };
    expect(sanitizeConfigForSnapshot(config)).toEqual(config);
  });
});
