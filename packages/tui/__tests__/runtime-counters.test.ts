import { describe, expect, it } from 'bun:test';
import {
  INITIAL_RUNTIME_COUNTERS,
  type RuntimeCounters,
  reduceRuntimeCounters,
} from '../src/repl/runtime-counters.js';
import type { TuiEvent } from '../src/types/events.js';

function toolEvent(
  type:
    | 'tool.call.started'
    | 'tool.call.completed'
    | 'tool.call.failed'
    | 'subagent.tool.call.started'
    | 'subagent.tool.call.completed'
    | 'subagent.tool.call.failed',
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

function subagentEvent(
  type: 'subagent.delegate.started' | 'subagent.run.completed' | 'subagent.run.failed',
): TuiEvent {
  return {
    type,
    run_id: 'r1',
    ts: 1,
    data: { run_id: 'r1', depth: 1, task: 't', hasContext: false },
  } as unknown as TuiEvent;
}

function run(events: TuiEvent[]): RuntimeCounters {
  return events.reduce(reduceRuntimeCounters, INITIAL_RUNTIME_COUNTERS);
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

  it('子 agent 内部的 bash 同样计数', () => {
    expect(
      run([
        toolEvent('subagent.tool.call.started', 'bash'),
        toolEvent('subagent.tool.call.failed', 'bash'),
      ]).bash,
    ).toBe(0);
    expect(
      run([
        toolEvent('subagent.tool.call.started', 'bash'),
        toolEvent('subagent.tool.call.completed', 'bash'),
        toolEvent('subagent.tool.call.started', 'bash'),
      ]).bash,
    ).toBe(1);
  });

  it('delegate started / subagent.run 终态估算子 agent 数', () => {
    expect(run([subagentEvent('subagent.delegate.started')]).subagents).toBe(1);
    expect(
      run([
        subagentEvent('subagent.delegate.started'),
        subagentEvent('subagent.delegate.started'),
        subagentEvent('subagent.run.completed'),
      ]).subagents,
    ).toBe(1);
    expect(run([subagentEvent('subagent.run.failed')]).subagents).toBe(0);
  });

  it('run 开始与终态一律清零（事件缺失也不卡住计数）', () => {
    const leaked = run([
      toolEvent('tool.call.started', 'bash'),
      subagentEvent('subagent.delegate.started'),
    ]);
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

  it('无关事件保持引用不变', () => {
    const state = { bash: 1, subagents: 2 };
    const event = {
      type: 'llm.stream.chunk',
      run_id: 'r1',
      ts: 1,
      data: {},
    } as unknown as TuiEvent;
    expect(reduceRuntimeCounters(state, event)).toBe(state);
  });
});
