import { afterEach, describe, expect, it } from 'bun:test';
import type { RunEvent } from '@vessel-agent/core';
import { formatAgentDetail, formatAgentList } from '../src/commands/agents-command.js';
import { createCommands } from '../src/commands/commands.js';
import { setLocale } from '../src/i18n/index.js';
import { buildAgentRegistry } from '../src/repl/agent-registry.js';
import { makeCtx, makeState } from './helpers.js';

function ev(type: string, runId: string, data: Record<string, unknown>, ts = 1000): RunEvent {
  return { type, run_id: runId, data, ts } as RunEvent;
}

afterEach(() => {
  setLocale('zh-CN');
});

describe('/agents', () => {
  it('shows a friendly empty state', async () => {
    const result = await createCommands().execute('/agents', makeCtx(), makeState('s1'));
    expect(result.handled).toBe(true);
    expect(result.output).toContain('本次会话暂无子 agent');
  });

  it('lists id / role / parent / depth / state / current tool', async () => {
    const ctx = makeCtx();
    ctx.events.publish(
      ev('subagent.delegate.started', 'run-parent', {
        delegateId: 'd1',
        depth: 0,
        task: 'inspect repo',
        session_id: 's1',
      }),
    );
    ctx.events.publish(
      ev('subagent.run.started', 'run-child', { delegateId: 'd1', session_id: 's1' }, 1100),
    );
    ctx.events.publish(
      ev('subagent.tool.call.started', 'run-child', { delegateId: 'd1', tool_name: 'bash' }, 1200),
    );

    const result = await createCommands().execute('/agents', ctx, makeState('s1'));
    expect(result.output).toContain('d1');
    expect(result.output).toContain('subagent');
    expect(result.output).toContain('run-parent');
    expect(result.output).toContain('running');
    expect(result.output).toContain('bash');
  });

  it('shows one node via exact id and unique prefix', async () => {
    const ctx = makeCtx();
    const commands = createCommands();
    ctx.events.publish(
      ev('subagent.delegate.started', 'run-parent', {
        delegateId: 'delegate-1234',
        depth: 0,
        task: 'write tests',
      }),
    );

    const exact = await commands.execute('/agents delegate-1234', ctx, makeState('s1'));
    expect(exact.output).toContain('delegate-1234');
    expect(exact.output).toContain('write tests');

    const prefix = await commands.execute('/agents show delegate', ctx, makeState('s1'));
    expect(prefix.output).toContain('delegate-1234');
  });

  it('reports unknown ids and ambiguous prefixes', async () => {
    const ctx = makeCtx();
    const commands = createCommands();
    ctx.events.publish(ev('subagent.delegate.started', 'r', { delegateId: 'abc-one' }));
    ctx.events.publish(ev('subagent.delegate.started', 'r', { delegateId: 'abc-two' }, 1001));

    const unknown = await commands.execute('/agents nope', ctx, makeState('s1'));
    expect(unknown.output).toContain('没有匹配');

    const ambiguous = await commands.execute('/agents abc', ctx, makeState('s1'));
    expect(ambiguous.output).toContain('匹配 2 个子 agent');
    expect(ambiguous.output).toContain('abc-one');
    expect(ambiguous.output).toContain('abc-two');
  });

  it('localizes output to en', async () => {
    setLocale('en');
    const ctx = makeCtx();
    ctx.events.publish(ev('subagent.delegate.started', 'r', { delegateId: 'd1' }));

    const result = await createCommands().execute('/agents', ctx, makeState('s1'));
    expect(result.output).toContain('Subagents (1)');
    expect(result.output).toContain('CURRENT TOOL');
  });

  it('formats detail and list from pure reducers', () => {
    const nodes = buildAgentRegistry([
      ev('subagent.delegate.started', 'run-parent', {
        delegateId: 'd1',
        depth: 0,
        task: 'task text',
      }),
      ev(
        'subagent.delegate.failed',
        'run-parent',
        { delegateId: 'd1', duration_ms: 2000, error: 'tool exploded' },
        3000,
      ),
    ]);

    expect(formatAgentList(nodes, 3000)).toContain('failed');
    const node = nodes[0];
    if (!node) throw new Error('expected node');
    const detail = formatAgentDetail(node, 3000);
    expect(detail).toContain('tool exploded');
    expect(detail).toContain('2s');
  });
});
