/**
 * 0.16 canonical agent 工具的装配决策。
 *
 * 故障形态：headless 默认注册 agent（改变默认无头行为），或 agent 可用时
 * 同时注册 delegate_task（模型看到两个 schema）；旧配置名没有映射到新工具。
 */

import { describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import { mapDelegateToolAlias, resolveAgentWiring } from '../agent-wiring';
import { planFactoryPlugins } from '../factory-plugins';

describe('resolveAgentWiring', () => {
  it('keeps headless delegate_task by default and does not build the team engine', () => {
    const plan = resolveAgentWiring({}, { headless: true });
    expect(plan.agentEnabled).toBe(false);
    expect(plan.teamEngine).toBe(false);
    expect(plan.delegateEnabled).toBe(true);
  });

  it('enables agent in interactive entries and drops delegate_task', () => {
    const plan = resolveAgentWiring({}, { headless: false });
    expect(plan.agentEnabled).toBe(true);
    expect(plan.teamEngine).toBe(true);
    expect(plan.delegateEnabled).toBe(false);
  });

  it('treats an explicitly constructed team as agent available and drops delegate_task', () => {
    const plan = resolveAgentWiring({ team: { enabled: true } }, { headless: true });
    expect(plan.agentEnabled).toBe(true);
    expect(plan.teamEngine).toBe(true);
    expect(plan.delegateEnabled).toBe(false);
  });

  it('honors explicit agent.enabled in both directions', () => {
    const headlessOn = resolveAgentWiring({ agent: { enabled: true } }, { headless: true });
    expect(headlessOn.agentEnabled).toBe(true);
    expect(headlessOn.teamEngine).toBe(true);

    const interactiveOff = resolveAgentWiring({ agent: { enabled: false } }, { headless: false });
    expect(interactiveOff.agentEnabled).toBe(false);
    expect(interactiveOff.delegateEnabled).toBe(true);
  });

  it('defaults visibility to private and hides legacyTools unless explicitly enabled', () => {
    const plan = resolveAgentWiring({}, { headless: false });
    expect(plan.defaultVisibility).toBe('private');
    expect(plan.legacyTools).toBe(false);

    const configured = resolveAgentWiring(
      { agent: { defaultVisibility: 'tenant' }, team: { legacyTools: true } },
      { headless: false },
    );
    expect(configured.defaultVisibility).toBe('tenant');
    expect(configured.legacyTools).toBe(true);

    expect(
      resolveAgentWiring({ team: { legacyTools: false } }, { headless: false }).legacyTools,
    ).toBe(false);
  });

  it('maps member permission mode by entry and config', () => {
    expect(resolveAgentWiring({}, { headless: false }).permissionMode).toBe('bridge');
    expect(resolveAgentWiring({}, { headless: true }).permissionMode).toBe('allow');
    expect(
      resolveAgentWiring({ delegate: { permissionMode: 'deny' } }, { headless: false })
        .permissionMode,
    ).toBe('deny');
  });

  it('maps followReplies only when configured', () => {
    expect(resolveAgentWiring({}, { headless: true }).followReplies).toBe(false);
    expect(
      resolveAgentWiring({ agent: { followReplies: true } }, { headless: true }).followReplies,
    ).toBe(true);
  });
});

describe('delegate_task alias mapping', () => {
  it('maps delegate_task to agent only when agent is available', () => {
    expect(mapDelegateToolAlias(['delegate_task', 'bash'], true)).toEqual(['agent', 'bash']);
    expect(mapDelegateToolAlias(['delegate_task', 'bash'], false)).toEqual([
      'delegate_task',
      'bash',
    ]);
  });

  it('deduplicates when both names are configured', () => {
    expect(mapDelegateToolAlias(['delegate_task', 'agent'], true)).toEqual(['agent']);
  });

  it('maps the configured disallowed list passed to members', () => {
    const config: VesselConfig = { delegate: { disallowed: ['delegate_task'] } };
    expect(resolveAgentWiring(config, { headless: false }).disallowed).toEqual(['agent']);
    expect(resolveAgentWiring(config, { headless: true }).disallowed).toEqual(['delegate_task']);
  });
});

describe('planFactoryPlugins with agent', () => {
  it('replaces delegate_task with the team engine when agent is available', () => {
    const plan = planFactoryPlugins({}, false, { agentEnabled: true });
    expect(plan.delegate).toBeNull();
    expect(plan.team).toEqual({ enabled: true, useHost: false });
  });

  it('keeps the legacy default when no entry hint is given', () => {
    const plan = planFactoryPlugins({}, false);
    expect(plan.delegate).toEqual({ enabled: true, useHost: false });
    expect(plan.team).toBeNull();
  });

  it('suppresses delegate_task whenever team is constructed', () => {
    const plan = planFactoryPlugins({ team: { enabled: true } }, false, { headless: true });
    expect(plan.delegate).toBeNull();
    expect(plan.team).toEqual({ enabled: true, useHost: false });
  });
});
