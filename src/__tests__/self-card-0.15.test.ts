/**
 * 0.15 owner Self Card：角色 / 工具 / 限额 / 上下文预算映射。
 *
 * 故障形态：主 agent 拿到成员工具或错误预算，模型据此做出不可用调用；
 * 或 headless 入口声称可以提问。
 */

import { describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import type {
  ContextManager,
  LLMProvider,
  PluginHost,
  SessionBackend,
} from '../../packages/core/src/index';
import { buildOwnerSpec } from '../runtime-factory';
import { knownOwnerToolNames, ownerSelfCard } from '../self-card';

describe('owner self card', () => {
  it('lists only tools that the default owner runtime registers', () => {
    const config: VesselConfig = {};
    expect(knownOwnerToolNames(config)).toEqual(['bash', 'read', 'edit', 'delegate_task']);
    expect(knownOwnerToolNames({ ...config, delegate: { enabled: false } })).toEqual([
      'bash',
      'read',
      'edit',
    ]);
  });

  it('adds ask_user only for interactive entries and ui.askUser !== false', () => {
    expect(knownOwnerToolNames({}, { askUser: true })).toContain('ask_user');
    expect(knownOwnerToolNames({ ui: { askUser: false } }, { askUser: true })).not.toContain(
      'ask_user',
    );
    expect(knownOwnerToolNames({}, { askUser: false })).not.toContain('ask_user');
  });

  it('adds team tools only when team is enabled', () => {
    const tools = knownOwnerToolNames({ team: { enabled: true } });
    expect(tools).toEqual(
      expect.arrayContaining([
        'team_spawn',
        'team_send',
        'team_inbox',
        'team_status',
        'team_cancel',
      ]),
    );
  });

  it('maps limits, context and headless how_to_ask', () => {
    const card = ownerSelfCard(
      {
        limits: { requestLimit: 5, inputTokensLimit: 1000 },
        termination: { maxIterations: 7, maxRuntimeSeconds: 30 },
        context: { maxTokens: 4096 },
      },
      'gpt-x',
    );
    expect(card.role).toBe('owner');
    expect(card.depth).toBe(0);
    expect(card.model).toBe('gpt-x');
    expect(card.limits).toEqual({
      requestLimit: 5,
      inputTokensLimit: 1000,
      maxIterations: 7,
      maxRuntimeSeconds: 30,
    });
    expect(card.context).toEqual({ max: 4096 });
    expect(card.how_to_ask).toContain('cannot ask');
  });

  it('uses 1M context and interactive how_to_ask when ask_user exists', () => {
    const card = ownerSelfCard({}, 'm', { askUser: true });
    expect(card.context.max).toBe(1_000_000);
    expect(card.how_to_ask).toContain('ask_user');
  });

  it('carries selfCard into the host owner AgentSpec', () => {
    const selfCard = ownerSelfCard({}, 'm');
    const spec = buildOwnerSpec(
      {
        id: 'owner',
        provider: {} as LLMProvider,
        model: 'm',
        pluginHost: {} as PluginHost,
        context: {} as ContextManager,
        session: {} as SessionBackend,
        limits: {},
        termination: { maxIterations: 1 },
        selfCard,
      },
      'session-1',
    );
    expect(spec.selfCard).toEqual(selfCard);
  });
});
