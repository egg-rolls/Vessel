import { describe, expect, test } from 'bun:test';
import { tenantResetPlan } from '../src/app/tenant-reset';

describe('tenantResetPlan', () => {
  test('drops every tenant-scoped selection by routing to empty Chat', () => {
    const plan = tenantResetPlan();
    expect(plan.route).toEqual({ domain: 'chat' });
    expect('sessionId' in plan.route).toBe(false);
    expect('runId' in plan.route).toBe(false);
    expect('workflowId' in plan.route).toBe(false);
  });

  test('clears shell caches and transient overlays', () => {
    expect(tenantResetPlan()).toEqual({
      route: { domain: 'chat' },
      clearPaletteEntities: true,
      closePalette: true,
      closeSessionsDrawer: true,
      clearPendingAction: true,
    });
  });
});
