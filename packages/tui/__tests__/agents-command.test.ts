import { afterEach, describe, expect, it } from 'bun:test';
import type { VesselConfig } from '@vessel-agent/config';
import type { RunEvent } from '@vessel-agent/core';
import {
  buildAgentSelfCard,
  formatAgentDetail,
  formatAgentList,
  formatAgentTree,
} from '../src/commands/agents-command.js';
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

  it('renders the dispatch tree with depth indentation and child counts', async () => {
    setLocale('en');
    const ctx = makeCtx();
    ctx.events.publish(
      ev('subagent.delegate.started', 'run-parent', { delegateId: 'd1', depth: 0 }, 1000),
    );
    ctx.events.publish(
      ev(
        'subagent.delegate.started',
        'run-parent',
        { delegateId: 'd2', depth: 1, parent_delegate_id: 'd1' },
        1100,
      ),
    );
    ctx.events.publish(
      ev(
        'subagent.delegate.started',
        'run-parent',
        { delegateId: 'd3', depth: 2, parent_delegate_id: 'd2' },
        1200,
      ),
    );

    const result = await createCommands().execute('/agents tree', ctx, makeState('s1'));
    expect(result.output).toContain('Subagents · tree (3)');
    const lines = (result.output ?? '').split('\n');
    const lineOf = (id: string): string | undefined =>
      lines.find((line) => line.trimStart().startsWith(`${id} `));
    expect(lineOf('d1')?.startsWith('  d1')).toBe(true);
    expect(lineOf('d2')?.startsWith('    d2')).toBe(true);
    expect(lineOf('d3')?.startsWith('      d3')).toBe(true);

    const tree = formatAgentTree(buildAgentRegistry(ctx.events.getHistory()), 2000);
    const treeLine = (id: string): string | undefined =>
      tree.split('\n').find((line) => line.trimStart().startsWith(`${id} `));
    expect(treeLine('d2')).toMatch(/ 1\s+\S+$/);
    expect(treeLine('d3')).toMatch(/ 0\s+\S+$/);
  });

  it('shows node_id / task / queue / result_ref in the detail view', async () => {
    const ctx = makeCtx();
    const commands = createCommands();
    ctx.events.publish(
      ev('subagent.delegate.started', 'run-parent', {
        delegateId: 'd1',
        node_id: 'node-1',
        task: 'inspect repo',
      }),
    );
    ctx.events.publish(
      ev(
        'agent.queue.entered',
        'run-parent',
        { agent_id: 'd1', position: 3, wait_reason: 'capacity' },
        1100,
      ),
    );
    ctx.events.publish(
      ev(
        'subagent.delegate.completed',
        'run-parent',
        { delegateId: 'd1', result_ref: 'msg-42' },
        1200,
      ),
    );

    const result = await commands.execute('/agents d1', ctx, makeState('s1'));
    expect(result.output).toContain('node_id');
    expect(result.output).toContain('node-1');
    expect(result.output).toContain('inspect repo');
    expect(result.output).toContain('pos 3 · capacity');
    expect(result.output).toContain('result_ref');
    expect(result.output).toContain('msg-42');
  });

  it('marks absent node_id / task / queue / result_ref as unknown', async () => {
    const ctx = makeCtx();
    ctx.events.publish(ev('subagent.delegate.started', 'run-parent', { delegateId: 'd1' }));

    const result = await createCommands().execute('/agents d1', ctx, makeState('s1'));
    const lineOf = (label: string): string | undefined =>
      (result.output ?? '').split('\n').find((line) => line.trimStart().startsWith(`${label} `));
    expect(lineOf('node_id')?.trimEnd().endsWith('unknown')).toBe(true);
    expect(lineOf('task')?.trimEnd().endsWith('unknown')).toBe(true);
    expect(lineOf('queue')?.trimEnd().endsWith('unknown')).toBe(true);
    expect(lineOf('result_ref')?.trimEnd().endsWith('unknown')).toBe(true);
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

  it('renders the Self Card with seen tools, delegate limits, remaining budget, and block', () => {
    setLocale('en');
    const events = [
      ev(
        'subagent.delegate.started',
        'run-parent',
        { delegateId: 'd1', depth: 0, task: 'inspect repo', session_id: 's1' },
        1000,
      ),
      ev('subagent.run.started', 'run-child', { delegateId: 'd1' }, 1100),
      ev('subagent.tool.call.started', 'run-child', { delegateId: 'd1', tool_name: 'bash' }, 1200),
      ev(
        'subagent.llm.response',
        'run-child',
        { delegateId: 'd1', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
        1300,
      ),
      ev(
        'subagent.limit.blocked',
        'run-child',
        {
          delegateId: 'd1',
          scope: 'agent',
          key: 'toolCallsLimit',
          current: 4,
          max: 4,
          source: 'config.agent.limits',
        },
        1400,
      ),
    ];
    const config = {
      agent: {
        termination: { maxIterations: 5, maxRuntimeSeconds: 30 },
        limits: { toolCallsLimit: 4 },
      },
    } as VesselConfig;
    const node = buildAgentRegistry(events)[0];
    if (!node) throw new Error('expected node');

    const card = buildAgentSelfCard(events, config, node, 11_000);
    const detail = formatAgentDetail(node, 11_000, card);
    expect(detail).toContain('as_of');
    expect(detail).toContain('bash (seen)');
    expect(detail).toContain('iterations 5 · tools 4 · runtime 30s');
    expect(detail).toContain('iterations 4 · tools 3 · runtime 20s');
    expect(detail).toContain('agent/toolCallsLimit 4/4 · config.agent.limits');
  });

  it('prefers explicitly declared tools over tools already seen', () => {
    const events = [
      ev(
        'subagent.delegate.started',
        'run-parent',
        { delegateId: 'd2', depth: 0, tools: ['read', 'edit'] },
        1000,
      ),
      ev('subagent.tool.call.started', 'run-parent', { delegateId: 'd2', tool_name: 'bash' }, 1100),
    ];
    const node = buildAgentRegistry(events)[0];
    if (!node) throw new Error('expected node');

    const detail = formatAgentDetail(
      node,
      2000,
      buildAgentSelfCard(events, {} as VesselConfig, node, 2000),
    );
    expect(detail).toContain('read, edit');
    expect(detail).not.toContain('bash (seen)');
  });

  it('keeps the list columns free of Self Card fields and defaults to unknown', () => {
    const events = [ev('subagent.delegate.started', 'run-parent', { delegateId: 'd1' }, 1000)];
    const node = buildAgentRegistry(events)[0];
    if (!node) throw new Error('expected node');

    const list = formatAgentList([node], 2000);
    expect(list).not.toContain('as_of');
    expect(list).not.toContain('remaining');

    const detail = formatAgentDetail(node, 2000);
    expect(detail).toContain('as_of');
    expect(detail).toContain('unknown');
  });
});
