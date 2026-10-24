/**
 * 0.17 A4 agent 装配决策。
 *
 * 故障形态：显式禁用仍然注册 agent，或成员设置仍从已删除的 delegate /
 * team 块读取。
 */

import { describe, expect, it } from 'bun:test';
import { resolveAgentWiring } from '../agent-wiring';

describe('resolveAgentWiring', () => {
  it('enables agent by default and only disables on explicit false', () => {
    expect(resolveAgentWiring({}, { headless: true }).agentEnabled).toBe(true);
    expect(resolveAgentWiring({}, { headless: false }).agentEnabled).toBe(true);
    expect(resolveAgentWiring({ agent: {} }, { headless: true }).agentEnabled).toBe(true);
    expect(resolveAgentWiring({ agent: { enabled: true } }, { headless: true }).agentEnabled).toBe(
      true,
    );
    expect(resolveAgentWiring({ agent: { enabled: false } }, { headless: true }).agentEnabled).toBe(
      false,
    );
    expect(
      resolveAgentWiring({ agent: { enabled: false } }, { headless: false }).agentEnabled,
    ).toBe(false);
  });

  it('defaults visibility to private and followReplies to false', () => {
    expect(resolveAgentWiring({}, { headless: false }).defaultVisibility).toBe('private');
    expect(resolveAgentWiring({}, { headless: false }).followReplies).toBe(false);

    const configured = resolveAgentWiring(
      { agent: { defaultVisibility: 'tenant', followReplies: true } },
      { headless: false },
    );
    expect(configured.defaultVisibility).toBe('tenant');
    expect(configured.followReplies).toBe(true);
  });

  it('maps member permission mode by entry and config', () => {
    expect(resolveAgentWiring({}, { headless: false }).permissionMode).toBe('bridge');
    expect(resolveAgentWiring({}, { headless: true }).permissionMode).toBe('allow');
    expect(
      resolveAgentWiring({ agent: { permissionMode: 'deny' } }, { headless: false }).permissionMode,
    ).toBe('deny');
  });

  it('reads member model/limits/termination/readOnlyTools from config.agent', () => {
    const plan = resolveAgentWiring(
      {
        agent: {
          enabled: true,
          model: 'member-model',
          limits: { requestLimit: 3 },
          termination: { maxIterations: 4 },
          readOnlyTools: ['read', 'edit'],
        },
      },
      { headless: false },
    );
    expect(plan.model).toBe('member-model');
    expect(plan.limits).toEqual({ requestLimit: 3 });
    expect(plan.termination).toEqual({ maxIterations: 4 });
    expect(plan.readOnlyTools).toEqual(['read', 'edit']);
  });
});
