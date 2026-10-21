import { describe, expect, it } from 'bun:test';
import type { RunState } from '@vessel-agent/core';
import { doResume, formatUiItemsAsText } from '../src/commands/commands.js';
import { t } from '../src/i18n/index.js';
import type { EventLogReadPort, SessionEventRecordLike } from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

function record(
  type: string,
  data: Record<string, unknown>,
  seq: number,
  ts = seq,
): SessionEventRecordLike {
  return { seq, ts, type, run_id: 'r1', data };
}

function port(events: readonly SessionEventRecordLike[]): EventLogReadPort {
  return { read: async () => events };
}

function failingPort(): EventLogReadPort {
  return {
    read: async () => {
      throw new Error('events.ndjson unreadable');
    },
  };
}

async function saveMessages(
  ctx: ReturnType<typeof makeCtx>,
  sessionId: string,
  messages: RunState['messages'],
): Promise<void> {
  await ctx.session.save({
    run_id: `run-${sessionId}`,
    session_id: sessionId,
    messages,
    started_at: 1,
    status: 'completed',
  });
}

describe('doResume：事件日志历史', () => {
  it('有日志时产出结构化 item（工具参数/结果/耗时、权限、agent、错误）', async () => {
    const ctx = makeCtx({
      eventLog: port([
        record('user.message', { message: { role: 'user', content: 'hello' } }, 1),
        record(
          'llm.response',
          {
            content: 'running tool',
            tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{}' } }],
            finish_reason: 'tool_calls',
          },
          2,
        ),
        record(
          'tool.call.started',
          { tool_call_id: 'c1', tool_name: 'bash', arguments: { command: 'ls -la' } },
          3,
        ),
        record('tool.permission.request', { requestId: 'p1', tool: 'bash' }, 4),
        record('tool.permission.response', { requestId: 'p1', decision: 'allow' }, 5),
        record(
          'tool.call.completed',
          { tool_call_id: 'c1', tool_name: 'bash', result: 'total 2', duration_ms: 42 },
          6,
        ),
        record(
          'tool.call.started',
          { tool_call_id: 'c2', tool_name: 'read', arguments: { path: 'a.ts' } },
          7,
        ),
        record(
          'tool.call.failed',
          { tool_call_id: 'c2', tool_name: 'read', error: 'ENOENT', duration_ms: 3 },
          8,
        ),
        record('agent.spawned', { agent_id: 'm1', task: 'child work' }, 9),
        record(
          'run.completed',
          { run_id: 'r1', output: 'done', usage: { total_tokens: 12 }, duration_ms: 100 },
          10,
        ),
      ]),
    });
    await saveMessages(ctx, 's1', [{ role: 'user', content: 'snapshot text' }]);

    const result = await doResume(ctx, 's1', { showReasoning: false });
    const kinds = result.items?.map((item) => item.kind);
    expect(kinds).toEqual(['user', 'assistant', 'tool', 'permission', 'tool', 'agent', 'run']);
    // 有可用日志时不得出现“不完整”notice
    expect(result.items?.some((item) => item.kind === 'notice')).toBe(false);

    const firstTool = result.items?.[2];
    if (firstTool?.kind !== 'tool') throw new Error('expected tool');
    expect(firstTool.view.name).toBe('bash');
    expect(firstTool.view.args).toEqual({ command: 'ls -la' });
    expect(firstTool.view.result).toBe('total 2');
    expect(firstTool.view.status).toBe('completed');
    expect(firstTool.view.durationMs).toBe(42);
    expect(firstTool.view.permission).toMatchObject({ requestId: 'p1', decision: 'allow' });

    const permission = result.items?.[3];
    expect(permission).toMatchObject({ kind: 'permission', tool: 'bash', decision: 'allow' });

    const failedTool = result.items?.[4];
    if (failedTool?.kind !== 'tool') throw new Error('expected tool');
    expect(failedTool.view.status).toBe('failed');
    expect(failedTool.view.error).toBe('ENOENT');

    expect(result.items?.[5]).toMatchObject({ kind: 'agent', agentId: 'm1', task: 'child work' });
    expect(result.items?.[6]).toMatchObject({ kind: 'run', status: 'completed', toolCount: 2 });
  });

  it('reasoning 默认不进入历史，显式开启才展示', async () => {
    const events = [
      record('user.message', { message: { role: 'user', content: 'q' } }, 1),
      record(
        'llm.response',
        { content: 'a', reasoning: 'private thought', finish_reason: 'stop' },
        2,
      ),
    ];
    const ctx = makeCtx({ eventLog: port(events) });

    const hidden = await doResume(ctx, 's1', { showReasoning: false });
    expect(hidden.items?.map((item) => item.kind)).toEqual(['user', 'assistant']);

    const shown = await doResume(ctx, 's1', { showReasoning: true });
    expect(shown.items?.map((item) => item.kind)).toEqual(['user', 'reasoning', 'assistant']);
  });

  it('run.failed 还原半截回答 + error item + failed run', async () => {
    const ctx = makeCtx({
      eventLog: port([
        record('user.message', { message: { role: 'user', content: 'q' } }, 1),
        record(
          'run.failed',
          {
            run_id: 'r1',
            error: 'provider exploded',
            duration_ms: 9,
            partial_content: 'half answer',
            error_code: 'provider_error',
            category: 'provider',
            phase: 'llm',
            retryable: true,
          },
          2,
        ),
      ]),
    });

    const result = await doResume(ctx, 's1');
    expect(result.items?.map((item) => item.kind)).toEqual(['user', 'assistant', 'error', 'run']);
    expect(result.items?.[1]).toMatchObject({ kind: 'assistant', text: 'half answer' });
    expect(result.items?.[2]).toMatchObject({
      kind: 'error',
      text: 'provider exploded',
      envelope: { error_code: 'provider_error', category: 'provider', phase: 'llm' },
    });
    expect(result.items?.[3]).toMatchObject({ kind: 'run', status: 'failed' });
  });

  it('无日志时回退 messages 并标注“不完整”', async () => {
    const ctx = makeCtx();
    await saveMessages(ctx, 's1', [
      { role: 'user', content: 'from snapshot' },
      { role: 'assistant', content: 'answer' },
    ]);

    const result = await doResume(ctx, 's1');

    expect(result.items?.[0]).toMatchObject({
      kind: 'notice',
      level: 'warn',
      text: t('history.incomplete'),
    });
    expect(result.items?.slice(1).map((item) => item.kind)).toEqual(['user', 'assistant']);
    expect(result.items?.[1]).toMatchObject({ kind: 'user', text: 'from snapshot' });
  });

  it('读取失败时同样回退 messages 并标注“不完整”', async () => {
    const ctx = makeCtx({ eventLog: failingPort() });
    await saveMessages(ctx, 's1', [{ role: 'user', content: 'fallback' }]);

    const result = await doResume(ctx, 's1');

    expect(result.items?.[0]).toMatchObject({ kind: 'notice', text: t('history.incomplete') });
    expect(result.items?.[1]).toMatchObject({ kind: 'user', text: 'fallback' });
  });

  it('空日志回退 messages', async () => {
    const ctx = makeCtx({ eventLog: port([]) });
    await saveMessages(ctx, 's1', [{ role: 'user', content: 'empty log fallback' }]);

    const result = await doResume(ctx, 's1');

    expect(result.items?.[0]).toMatchObject({ kind: 'notice', text: t('history.incomplete') });
    expect(result.items?.[1]).toMatchObject({ kind: 'user', text: 'empty log fallback' });
  });

  it('大日志只渲染最近 200 项并在顶部标注省略', async () => {
    const events = Array.from({ length: 250 }, (_, index) =>
      record('user.message', { message: { role: 'user', content: `msg-${index}` } }, index + 1),
    );
    const ctx = makeCtx({ eventLog: port(events) });

    const result = await doResume(ctx, 's1');

    expect(result.items).toHaveLength(201);
    expect(result.items?.[0]).toMatchObject({
      kind: 'notice',
      text: t('history.itemsOmitted', { count: 200 }),
    });
    expect(result.items?.[1]).toMatchObject({ kind: 'user', text: 'msg-50' });
    expect(result.items?.at(-1)).toMatchObject({ kind: 'user', text: 'msg-249' });
  });

  it('simple mode 的 history 始终是字符串行', async () => {
    const ctx = makeCtx({
      eventLog: port([
        record('user.message', { message: { role: 'user', content: 'hello' } }, 1),
        record('llm.response', { content: 'hi', finish_reason: 'stop' }, 2),
        record(
          'tool.call.started',
          { tool_call_id: 'c1', tool_name: 'bash', arguments: { command: 'ls' } },
          3,
        ),
        record(
          'tool.call.completed',
          { tool_call_id: 'c1', tool_name: 'bash', result: 'ok', duration_ms: 5 },
          4,
        ),
      ]),
    });

    const result = await doResume(ctx, 's1');

    expect(result.history?.every((line) => typeof line === 'string')).toBe(true);
    const joined = result.history?.join('\n') ?? '';
    expect(joined).toContain('you ');
    expect(joined).toContain('hello');
    expect(joined).toContain('tool');
    expect(joined).not.toContain('[object Object]');
  });
});

describe('formatUiItemsAsText', () => {
  it('空项返回空数组', () => {
    expect(formatUiItemsAsText([])).toEqual([]);
  });

  it('工具结果超长时按 600 字符截断（不拼整段历史）', () => {
    const lines = formatUiItemsAsText([
      {
        kind: 'tool',
        id: 't1',
        view: {
          id: 'c1',
          name: 'bash',
          args: { command: 'ls' },
          status: 'completed',
          title: 'bash',
          result: 'x'.repeat(700),
        },
      },
    ]);
    const resultLine = lines.find((line) => line.includes('xxx'));
    expect(resultLine?.endsWith('…')).toBe(true);
    expect(resultLine?.replace(/^.*│ /, '').length).toBe(601);
  });
});
