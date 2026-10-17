import { describe, expect, it } from 'bun:test';
import { reduceSubagentState, type SubagentState } from '../src/components/SubagentActivity.js';
import type { TuiEvent } from '../src/types/events.js';

const initial: SubagentState = { status: 'idle', active: 0 };

function event(type: string, data: unknown, run_id = 'run-1'): TuiEvent {
  return { type, run_id, data, ts: 1 } as unknown as TuiEvent;
}

describe('reduceSubagentState', () => {
  it('delegate.started -> running 并记录 task', () => {
    const state = reduceSubagentState(
      initial,
      event('subagent.delegate.started', { depth: 1, task: '查资料', hasContext: false }),
    );
    expect(state.status).toBe('running');
    expect(state.active).toBe(1);
    expect(state.task).toBe('查资料');
  });

  it('子 agent 工具开始 -> 更新 activity', () => {
    let state = reduceSubagentState(
      initial,
      event('subagent.delegate.started', { depth: 1, task: 't', hasContext: false }),
    );
    state = reduceSubagentState(
      state,
      event('subagent.tool.call.started', {
        run_id: 'run-1',
        tool_call_id: 'c1',
        tool_name: 'bash',
        arguments: {},
      }),
    );
    expect(state.activity).toBe('bash');
  });

  it('子 run 完成 -> completed；父 run 结束 -> idle', () => {
    let state = reduceSubagentState(
      initial,
      event('subagent.delegate.started', { depth: 1, task: 't', hasContext: false }),
    );
    state = reduceSubagentState(state, event('subagent.run.completed', {}));
    expect(state.status).toBe('completed');
    expect(state.active).toBe(0);

    state = reduceSubagentState(state, event('run.completed', {}));
    expect(state.status).toBe('idle');
  });

  it('子 run 失败 -> failed', () => {
    let state = reduceSubagentState(
      initial,
      event('subagent.delegate.started', { depth: 1, task: 't', hasContext: false }),
    );
    state = reduceSubagentState(state, event('subagent.run.failed', {}));
    expect(state.status).toBe('failed');
  });

  it('父 run.started 重置活动', () => {
    let state = reduceSubagentState(
      initial,
      event('subagent.delegate.started', { depth: 1, task: 't', hasContext: false }),
    );
    state = reduceSubagentState(state, event('run.started', {}));
    expect(state).toEqual(initial);
  });

  it('未知事件不改变状态', () => {
    expect(reduceSubagentState(initial, event('llm.stream.chunk', {}))).toBe(initial);
  });
});
