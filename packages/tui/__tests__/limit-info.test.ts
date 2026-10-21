import { describe, expect, it } from 'bun:test';
import type { VesselConfig } from '@vessel-agent/config';
import type { RunEvent } from '@vessel-agent/core';
import {
  findLatestLimitBlock,
  readAgentTools,
  readAgentUsage,
  readDelegateLimits,
  readEffectiveLimits,
  readLimitBlock,
  readRunUsage,
  remainingBudget,
} from '../src/repl/limit-info.js';

function ev(type: string, runId: string, data: Record<string, unknown>, ts: number): RunEvent {
  return { type, run_id: runId, data, ts } as RunEvent;
}

describe('limit info reducer', () => {
  it('falls back to runtime defaults only for omitted config blocks', () => {
    expect(readEffectiveLimits(undefined)).toEqual({
      maxIterations: 20,
      maxRuntimeSeconds: 300,
      requestLimit: 100,
      toolCallsLimit: 50,
      inputTokensLimit: 100000,
      outputTokensLimit: 50000,
      contextMaxTokens: 1_000_000,
    });

    const partial = readEffectiveLimits({
      termination: { maxIterations: 5 },
      limits: {},
      context: {},
    } as VesselConfig);
    expect(partial.maxIterations).toBe(5);
    expect(partial.maxRuntimeSeconds).toBe(300);
    expect(partial.requestLimit).toBeUndefined();
    expect(partial.toolCallsLimit).toBeUndefined();
    expect(partial.contextMaxTokens).toBe(1_000_000);
  });

  it('delegate limits never inherit the main agent termination when unset', () => {
    expect(readDelegateLimits(undefined)).toEqual({
      maxIterations: 10,
      maxRuntimeSeconds: 60,
      maxDepth: 3,
    });

    const explicitEmpty = readDelegateLimits({
      termination: { maxIterations: 99, maxRuntimeSeconds: 999 },
      delegate: { termination: {}, limits: { requestLimit: 4 }, maxDepth: 7 },
    } as VesselConfig);
    expect(explicitEmpty.maxIterations).toBe(10);
    expect(explicitEmpty.maxRuntimeSeconds).toBeUndefined();
    expect(explicitEmpty.requestLimit).toBe(4);
    expect(explicitEmpty.toolCallsLimit).toBeUndefined();
    expect(explicitEmpty.maxDepth).toBe(7);
  });

  it('folds only the requested run and uses completed iterations as request fallback', () => {
    const events = [
      ev('run.started', 'r1', {}, 1000),
      ev(
        'llm.response',
        'r1',
        { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, total_cost: 0.01 } },
        2000,
      ),
      ev('llm.response', 'r1', { usage: { prompt_tokens: 20, completion_tokens: 7 } }, 3000),
      ev('tool.call.started', 'r1', { tool_name: 'bash' }, 4000),
      ev('run.completed', 'r1', { iterations: 5 }, 6000),
      ev('llm.response', 'other', { usage: { prompt_tokens: 999 } }, 7000),
    ];

    const usage = readRunUsage(events, 'r1', 8000);
    expect(usage.requests).toBe(5);
    expect(usage.toolCalls).toBe(1);
    expect(usage.promptTokens).toBe(30);
    expect(usage.completionTokens).toBe(12);
    expect(usage.totalTokens).toBe(42);
    expect(usage.totalCost).toBeCloseTo(0.01);
    expect(usage.elapsedMs).toBe(7000);
  });

  it('recognizes a limit block by event type or nested error envelope', () => {
    const typed = readLimitBlock(
      ev(
        'agent.limit.blocked',
        'r1',
        {
          scope: 'agent',
          key: 'maxIterations',
          current: 20,
          max: '20',
          source: 'config.termination',
          hint: 'raise termination.maxIterations',
          delegateId: 'd1',
        },
        1000,
      ),
    );
    expect(typed).toMatchObject({
      errorCode: 'limit_blocked',
      scope: 'agent',
      key: 'maxIterations',
      current: 20,
      max: 20,
      source: 'config.termination',
      hint: 'raise termination.maxIterations',
      agentId: 'd1',
      runId: 'r1',
    });

    const nested = readLimitBlock(
      ev(
        'tool.call.failed',
        'r2',
        {
          tool_name: 'bash',
          error: 'Usage limits exceeded',
          details: { errorCode: 'limit_blocked', limitKey: 'toolCallsLimit', used: 50, limit: 50 },
        },
        2000,
      ),
    );
    expect(nested).toMatchObject({ key: 'toolCallsLimit', current: 50, max: 50 });

    expect(readLimitBlock(ev('llm.response', 'r3', { error_code: 'other' }, 3000))).toBeUndefined();
  });

  it('finds the latest block matching either the run id or the delegate id', () => {
    const events = [
      ev('limit.blocked', 'r1', { scope: 'agent', key: 'requests', current: 1, max: 1 }, 1000),
      ev('limit.blocked', 'r2', { scope: 'agent', key: 'requests', current: 2, max: 2 }, 2000),
      ev(
        'limit.blocked',
        'r1',
        { scope: 'agent', key: 'toolCalls', current: 3, max: 3, delegateId: 'd1' },
        3000,
      ),
    ];

    expect(findLatestLimitBlock(events, { runIds: ['r1'] })?.key).toBe('toolCalls');
    expect(findLatestLimitBlock(events, { runIds: ['r2'] })?.key).toBe('requests');
    expect(findLatestLimitBlock(events, { agentId: 'd1' })?.key).toBe('toolCalls');
    expect(findLatestLimitBlock(events, { runIds: ['r2'], agentId: 'd1' })?.key).toBe('toolCalls');
    expect(findLatestLimitBlock(events, { runIds: ['r9'] })).toBeUndefined();
  });

  it('does not double count live child usage with the delegate.completed aggregate', () => {
    const node = { id: 'd1', childRunId: 'child', startedAt: 1000, endedAt: 6000 };
    const events = [
      ev('subagent.delegate.started', 'parent', { delegateId: 'd1', depth: 0 }, 1000),
      ev('subagent.run.started', 'child', { delegateId: 'd1' }, 1100),
      ev(
        'subagent.llm.response',
        'child',
        { delegateId: 'd1', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
        2000,
      ),
      ev('subagent.tool.call.started', 'child', { delegateId: 'd1', tool_name: 'bash' }, 3000),
      ev('subagent.run.completed', 'child', { delegateId: 'd1', iterations: 3 }, 4000),
      ev(
        'subagent.delegate.completed',
        'parent',
        {
          delegateId: 'd1',
          usage: {
            prompt_tokens: 20,
            completion_tokens: 8,
            total_tokens: 28,
            total_cost: 0.02,
          },
        },
        5000,
      ),
      ev('llm.response', 'parent', { usage: { prompt_tokens: 999 } }, 5500),
    ];

    const usage = readAgentUsage(events, node, 6000);
    expect(usage.requests).toBe(3);
    expect(usage.toolCalls).toBe(1);
    expect(usage.promptTokens).toBe(20);
    expect(usage.completionTokens).toBe(8);
    expect(usage.totalTokens).toBe(28);
    expect(usage.totalCost).toBeCloseTo(0.02);
    expect(usage.elapsedMs).toBe(5000);
  });

  it('prefers declared agent tools over tools seen in child events', () => {
    const node = { id: 'd1', childRunId: 'child', startedAt: 1000 };
    const seen = [
      ev('subagent.run.started', 'child', { delegateId: 'd1' }, 1000),
      ev('subagent.tool.call.started', 'child', { delegateId: 'd1', tool_name: 'bash' }, 1100),
      ev('subagent.tool.call.started', 'child', { delegateId: 'd1', tool_name: 'read' }, 1200),
    ];
    expect(readAgentTools(seen, node)).toEqual({ tools: ['bash', 'read'], seen: true });

    const declared = [
      ev('subagent.delegate.started', 'parent', { delegateId: 'd1', tool_names: ['edit'] }, 1000),
      ...seen,
    ];
    expect(readAgentTools(declared, node)).toEqual({ tools: ['edit'], seen: false });
    expect(readAgentTools([ev('llm.response', 'parent', {}, 1000)], node)).toEqual({ seen: false });
  });

  it('computes remaining only for configured limits', () => {
    const remaining = remainingBudget(
      { maxIterations: 20, maxRuntimeSeconds: 60, toolCallsLimit: 50 },
      {
        requests: 3,
        toolCalls: 4,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        elapsedMs: 15000,
      },
    );
    expect(remaining).toEqual({ iterations: 17, runtimeMs: 45000, toolCalls: 46 });
  });
});
