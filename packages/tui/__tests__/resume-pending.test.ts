import { describe, expect, it } from 'bun:test';
import type { Message, RunState } from '@vessel/core';
import { consumePendingResume } from '../src/commands/commands.js';
import { captureConsole, makeCtx, makeState } from './helpers.js';

function runState(sessionId: string, preview: string, startedAt: number): RunState {
  return {
    run_id: `run-${sessionId}`,
    session_id: sessionId,
    messages: [{ role: 'user', content: preview }] as Message[],
    started_at: startedAt,
    status: 'completed',
  };
}

describe('consumePendingResume（/resume 裸数字 one-shot）', () => {
  it('裸数字 -> 按编号恢复对应会话', async () => {
    const ctx = makeCtx();
    // 两条历史会话，按 updated_at 倒序：s2 在前（更晚）
    await ctx.session.save(runState('s1', '第一个', 1000));
    await ctx.session.save(runState('s2', '第二个', 2000));
    let changedTo = '';
    ctx.onSessionChange = (id) => {
      changedTo = id;
    };
    const state = makeState(ctx.currentSessionId);
    state.pendingResume = true;

    const cap = captureConsole();
    await consumePendingResume('1', ctx, state);
    cap.restore();

    // listRich 倒序：#1 = s2
    expect(state.currentSessionId).toBe('s2');
    expect(changedTo).toBe('s2');
    expect(state.pendingResume).toBe(false);
    expect(cap.logs.join('\n')).toContain('Resumed');
  });

  it('非数字 -> 取消恢复', async () => {
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    state.pendingResume = true;
    const cap = captureConsole();
    await consumePendingResume('hello', ctx, state);
    cap.restore();
    expect(state.pendingResume).toBe(false);
    expect(cap.logs.join('\n')).toContain('Cancelled');
    expect(state.currentSessionId).toBe(ctx.currentSessionId); // 未切换
  });

  it('超出范围的数字 -> 取消', async () => {
    const ctx = makeCtx();
    await ctx.session.save(runState('s1', '唯一', 1000));
    const state = makeState(ctx.currentSessionId);
    state.pendingResume = true;
    const cap = captureConsole();
    await consumePendingResume('9', ctx, state);
    cap.restore();
    expect(state.pendingResume).toBe(false);
    expect(cap.logs.join('\n')).toContain('No session #9');
    expect(state.currentSessionId).toBe(ctx.currentSessionId);
  });

  it('恢复后 context 已清空（下次 run 会从 backend 载入历史）', async () => {
    const ctx = makeCtx();
    await ctx.session.save(runState('target', '历史', 1000));
    ctx.context.add({ role: 'user', content: '旧上下文' });
    const state = makeState(ctx.currentSessionId);
    state.pendingResume = true;
    const cap = captureConsole();
    await consumePendingResume('1', ctx, state);
    cap.restore();
    expect(ctx.context.messages.length).toBe(0);
  });
});
