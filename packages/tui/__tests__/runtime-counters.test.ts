import { describe, expect, it } from 'bun:test';
import { type AgentNode, countActiveAgents } from '../src/repl/agent-registry.js';
import {
  INITIAL_RUNTIME_COUNTERS,
  type RuntimeCounters,
  reduceRuntimeCounters,
} from '../src/repl/runtime-counters.js';
import type { TuiEvent } from '../src/types/events.js';

function toolEvent(
  type: 'tool.call.started' | 'tool.call.completed' | 'tool.call.failed',
  toolName: string,
): TuiEvent {
  return {
    type,
    run_id: 'r1',
    ts: 1,
    data: {
      run_id: 'r1',
      tool_call_id: 'c1',
      tool_name: toolName,
      arguments: {},
      result: '',
      error: '',
      duration_ms: 1,
    },
  } as unknown as TuiEvent;
}

function simpleEvent(
  type: 'run.started' | 'run.resumed' | 'run.completed' | 'run.failed' | 'run.cancelled',
): TuiEvent {
  return {
    type,
    run_id: 'r1',
    ts: 1,
    data: { run_id: 'r1', input: '', error: '' },
  } as unknown as TuiEvent;
}

function run(events: TuiEvent[]): RuntimeCounters {
  return events.reduce(reduceRuntimeCounters, INITIAL_RUNTIME_COUNTERS);
}

function node(id: string, state: AgentNode['state']): AgentNode {
  return { id, role: 'agent', parentRunId: 'r1', depth: 0, state, startedAt: 1 };
}

describe('reduceRuntimeCounters', () => {
  it('bash started/completed 成对计数', () => {
    const started = run([
      toolEvent('tool.call.started', 'bash'),
      toolEvent('tool.call.started', 'read'),
    ]);
    expect(started.bash).toBe(1);
    expect(
      run([toolEvent('tool.call.started', 'bash'), toolEvent('tool.call.completed', 'bash')]),
    ).toEqual({ bash: 0, subagents: 0 });
  });

  it('failed 也递减，且不会下溢', () => {
    expect(
      run([toolEvent('tool.call.started', 'bash'), toolEvent('tool.call.failed', 'bash')]).bash,
    ).toBe(0);
    expect(run([toolEvent('tool.call.completed', 'bash')]).bash).toBe(0);
  });

  it('run 开始与终态一律清零（事件缺失也不卡住计数）', () => {
    const leaked = run([toolEvent('tool.call.started', 'bash')]);
    for (const type of [
      'run.started',
      'run.resumed',
      'run.completed',
      'run.failed',
      'run.cancelled',
    ] as const) {
      expect(reduceRuntimeCounters(leaked, simpleEvent(type))).toEqual({
        bash: 0,
        subagents: 0,
      });
    }
  });

  it('未知事件不改变状态', () => {
    const state = run([toolEvent('tool.call.started', 'bash')]);
    expect(reduceRuntimeCounters(state, simpleEvent('run.resumed'))).toEqual({
      bash: 0,
      subagents: 0,
    });
  });
});

describe('countActiveAgents（与 SubagentActivity 共用 registry）', () => {
  it('只统计 running / waiting_permission', () => {
    expect(
      countActiveAgents([
        node('a', 'running'),
        node('b', 'waiting_permission'),
        node('c', 'completed'),
        node('d', 'failed'),
        node('e', 'closed'),
      ]),
    ).toBe(2);
  });

  it('空注册表为 0', () => {
    expect(countActiveAgents([])).toBe(0);
  });
});
