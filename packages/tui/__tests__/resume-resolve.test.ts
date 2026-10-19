import { describe, expect, it } from 'bun:test';
import type { Message, RunState } from '@vessel/core';
import { resolveResumeTarget } from '../src/commands/commands.js';
import { makeCtx } from './helpers.js';

function stateWith(
  sessionId: string,
  title: string,
  updatedAt: number,
  content = 'hello',
): RunState {
  return {
    run_id: `run-${sessionId}`,
    session_id: sessionId,
    title,
    messages: [{ role: 'user', content }] as Message[],
    started_at: updatedAt,
    updated_at: updatedAt,
    status: 'completed',
  };
}

async function ctxWith(...states: RunState[]) {
  const ctx = makeCtx();
  for (const state of states) await ctx.session.save(state);
  return ctx;
}

describe('resolveResumeTarget', () => {
  it('唯一 id 前缀可恢复；歧义前缀列出候选且不猜（猜错会切错会话）', async () => {
    const ctx = await ctxWith(
      stateWith('20260101_120000_aaa111', 'alpha', 1000),
      stateWith('20260101_130000_bbb222', 'beta', 2000),
    );

    await expect(resolveResumeTarget('20260101_12', ctx)).resolves.toEqual({
      ok: true,
      sessionId: '20260101_120000_aaa111',
    });

    const ambiguous = await resolveResumeTarget('20260101', ctx);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.message).toContain('ambiguous');
      expect(ambiguous.message).toContain('20260101_120000_aaa111');
    }
  });

  it('exact id 优先于前缀', async () => {
    const ctx = await ctxWith(
      stateWith('20260101_120000_aaa111', 'alpha', 1000),
      stateWith('20260101_120000_aaa111_x', 'longer', 2000),
    );
    await expect(resolveResumeTarget('20260101_120000_aaa111', ctx)).resolves.toEqual({
      ok: true,
      sessionId: '20260101_120000_aaa111',
    });
  });

  it('title 精确匹配取最新；同名 "base #2" 取第二新', async () => {
    const ctx = await ctxWith(
      stateWith('20260101_100000_aaa111', 'same', 1000),
      stateWith('20260101_110000_bbb222', 'same', 2000),
      stateWith('20260101_120000_ccc333', 'same', 3000),
    );

    await expect(resolveResumeTarget('same', ctx)).resolves.toEqual({
      ok: true,
      sessionId: '20260101_120000_ccc333',
    });
    await expect(resolveResumeTarget('same #2', ctx)).resolves.toEqual({
      ok: true,
      sessionId: '20260101_110000_bbb222',
    });
  });

  it('字面 "title #N" 精确命中该会话', async () => {
    const ctx = await ctxWith(
      stateWith('20260101_100000_aaa111', 'lineage', 1000),
      stateWith('20260101_110000_bbb222', 'lineage #2', 2000),
    );
    await expect(resolveResumeTarget('lineage #2', ctx)).resolves.toEqual({
      ok: true,
      sessionId: '20260101_110000_bbb222',
    });
    await expect(resolveResumeTarget('lineage', ctx)).resolves.toEqual({
      ok: true,
      sessionId: '20260101_110000_bbb222',
    });
  });

  it('找不到时给出明确错误，不静默恢复当前会话', async () => {
    const ctx = await ctxWith(stateWith('20260101_100000_aaa111', 'alpha', 1000));
    const result = await resolveResumeTarget('nope', ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('not found');
  });
});
