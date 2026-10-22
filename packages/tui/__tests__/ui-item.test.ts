import { describe, expect, it } from 'bun:test';
import {
  createUiProjection,
  fullTextOfItem,
  projectMessagesToUiItems,
  projectUiItems,
  reduceUiProjection,
  type UiProjectionState,
} from '../src/repl/project/ui-item.js';
import { asTuiEvent } from '../src/types/events.js';

function event(type: string, data: unknown, ts = 1, runId = 'r1') {
  return asTuiEvent({ type, run_id: runId, data: data as Record<string, unknown>, ts });
}

function fold(events: ReturnType<typeof event>[]): UiProjectionState {
  return events.reduce(reduceUiProjection, createUiProjection());
}

function textDelta(delta: string, ts = 1) {
  return event('llm.stream.chunk', { chunk: { type: 'text_delta', delta } }, ts);
}

function reasoningDelta(delta: string, ts = 1) {
  return event('llm.stream.chunk', { chunk: { type: 'reasoning_delta', delta } }, ts);
}

function toolStarted(id: string, name = 'bash', args: unknown = { command: 'ls -la' }, ts = 1) {
  return event('tool.call.started', { tool_call_id: id, tool_name: name, arguments: args }, ts);
}

describe('reduceUiProjection：assistant / reasoning', () => {
  it('连续 text_delta 合并为同一个 assistant item', () => {
    const state = fold([textDelta('Hello'), textDelta(' '), textDelta('World')]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: 'assistant', text: 'Hello World' });
  });

  it('reasoning 独立成项，并在正文开始时补耗时', () => {
    const state = fold([
      reasoningDelta('plan', 100),
      reasoningDelta(' more', 120),
      textDelta('answer', 250),
    ]);
    expect(state.items.map((item) => item.kind)).toEqual(['reasoning', 'assistant']);
    expect(state.items[0]).toMatchObject({ kind: 'reasoning', text: 'plan more', ms: 150 });
    expect(state.items[1]).toMatchObject({ kind: 'assistant', text: 'answer' });
  });

  it('流式已显示的正文在 llm.response 到达时被再追加一遍', () => {
    const state = fold([textDelta('Hello'), event('llm.response', { content: 'Hello' })]);
    const assistants = state.items.filter((item) => item.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ kind: 'assistant', text: 'Hello' });
  });

  it('非流式 provider 只有 llm.response 时正文被去重逻辑吞掉', () => {
    const state = fold([event('llm.response', { content: 'Hello' })]);
    const assistants = state.items.filter((item) => item.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ kind: 'assistant', text: 'Hello' });
  });

  it('取消时 partial_content 与已流出正文重复', () => {
    const state = fold([
      textDelta('part'),
      event('run.cancelled', { run_id: 'r1', partial_content: 'part', duration_ms: 5 }),
    ]);
    const assistants = state.items.filter((item) => item.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ kind: 'assistant', text: 'part' });
  });

  it('reasoning_delta 后持久化 reasoning 不重复', () => {
    const state = fold([
      reasoningDelta('think'),
      event('llm.response', { reasoning: 'think', content: 'answer' }),
    ]);
    const reasoning = state.items.filter((item) => item.kind === 'reasoning');
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({ kind: 'reasoning', text: 'think' });
  });

  it('工具调用后的正文另起一个 assistant item', () => {
    const state = fold([
      textDelta('first'),
      toolStarted('c1'),
      event('tool.call.completed', {
        tool_call_id: 'c1',
        tool_name: 'bash',
        result: 'ok',
        duration_ms: 5,
      }),
      textDelta('second'),
    ]);
    expect(state.items.map((item) => item.kind)).toEqual(['assistant', 'tool', 'assistant']);
  });
});

describe('reduceUiProjection：工具卡', () => {
  it('started 保留参数，completed 补结果 / 耗时 / truncated 元数据', () => {
    const result = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n');
    const state = fold([
      toolStarted('c1'),
      event('tool.call.completed', {
        tool_call_id: 'c1',
        tool_name: 'bash',
        result,
        duration_ms: 42,
      }),
    ]);
    const item = state.items[0];
    expect(item?.kind).toBe('tool');
    if (item?.kind !== 'tool') throw new Error('expected tool');
    expect(item.view.name).toBe('bash');
    expect(item.view.args).toEqual({ command: 'ls -la' });
    expect(item.view.subtitle).toBe('ls -la');
    expect(item.view.status).toBe('completed');
    expect(item.view.result).toBe(result);
    expect(item.view.durationMs).toBe(42);
    expect(item.view.truncated).toMatchObject({ lines: 10, fullRef: 'tool:c1' });
  });

  it('failed 保留 error 与结构化 envelope', () => {
    const state = fold([
      toolStarted('c1'),
      event('tool.call.failed', {
        tool_call_id: 'c1',
        tool_name: 'bash',
        error: 'permission denied',
        duration_ms: 7,
        error_code: 'tool_execution_failed',
        category: 'tool',
        phase: 'tool',
        retryable: false,
      }),
    ]);
    const item = state.items[0];
    if (item?.kind !== 'tool') throw new Error('expected tool');
    expect(item.view.status).toBe('failed');
    expect(item.view.error).toBe('permission denied');
    expect(item.view.errorEnvelope).toMatchObject({
      error_code: 'tool_execution_failed',
      category: 'tool',
      phase: 'tool',
      retryable: false,
    });
  });

  it('事件从中间开始（无 started）也补完成卡，不丢结果', () => {
    const state = fold([
      event('tool.call.completed', {
        tool_call_id: 'c9',
        tool_name: 'read',
        result: 'body',
        duration_ms: 3,
      }),
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: 'tool' });
  });
});

describe('reduceUiProjection：权限', () => {
  it('request 产生一条 pending item，response 更新同一条并回写工具卡', () => {
    const state = fold([
      toolStarted('c1'),
      event('tool.permission.request', {
        requestId: 'p1',
        tool: 'bash',
        input: { command: 'ls -la' },
      }),
      event('tool.permission.response', { requestId: 'p1', decision: 'allow', remember: false }),
    ]);
    const permission = state.items.find((item) => item.kind === 'permission');
    expect(permission).toMatchObject({
      kind: 'permission',
      requestId: 'p1',
      tool: 'bash',
      decision: 'allow',
    });
    const tool = state.items.find((item) => item.kind === 'tool');
    if (tool?.kind !== 'tool') throw new Error('expected tool');
    expect(tool.view.permission).toMatchObject({ requestId: 'p1', decision: 'allow' });
  });

  it('remember=true 映射为 always', () => {
    const state = fold([
      event('tool.permission.request', { requestId: 'p1', tool: 'bash', input: {} }),
      event('tool.permission.response', { requestId: 'p1', decision: 'allow', remember: true }),
    ]);
    expect(state.items[0]).toMatchObject({ kind: 'permission', decision: 'always' });
  });
});

describe('reduceUiProjection：notice / error / run', () => {
  it('guardrail / limit / compaction 都有内联 notice', () => {
    const state = fold([
      event('guardrail.blocked', {
        guardrail_name: 'deny-paths',
        stage: 'tool_call',
        reason: 'blocked path',
      }),
      event('limit.blocked', {
        error_code: 'limit_blocked',
        scope: 'usage',
        key: 'input_tokens',
        current: 10,
        max: 5,
        hint: 'raise limits',
      }),
      event('context.compacted', { removed: 3, remaining: 7, reason: 'auto' }),
    ]);
    expect(state.items.map((item) => item.kind)).toEqual(['notice', 'notice', 'notice']);
    expect(state.items[0]).toMatchObject({ level: 'warn' });
    expect(state.items[1]).toMatchObject({ level: 'danger' });
    expect(state.items[2]).toMatchObject({ level: 'info' });
  });

  it('run.completed 生成 run 摘要（usage / duration / toolCount）', () => {
    const state = fold([
      toolStarted('c1'),
      event('tool.call.completed', {
        tool_call_id: 'c1',
        tool_name: 'bash',
        result: 'ok',
        duration_ms: 5,
      }),
      event('run.completed', {
        run_id: 'r1',
        session_id: 's1',
        output: 'done',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        duration_ms: 1200,
        iterations: 2,
      }),
    ]);
    const run = state.items.at(-1);
    expect(run).toMatchObject({
      kind: 'run',
      status: 'completed',
      durationMs: 1200,
      toolCount: 1,
      usage: { total_tokens: 15 },
    });
  });

  it('run.failed 生成 error（带 envelope）+ failed run 摘要', () => {
    const state = fold([
      event('run.failed', {
        run_id: 'r1',
        error: 'rate limited',
        error_code: 'provider_rate_limit',
        category: 'provider',
        phase: 'llm',
        retryable: true,
        http_status: 429,
        duration_ms: 800,
      }),
    ]);
    expect(state.items.map((item) => item.kind)).toEqual(['error', 'run']);
    expect(state.items[0]).toMatchObject({
      kind: 'error',
      text: 'rate limited',
      envelope: {
        error_code: 'provider_rate_limit',
        category: 'provider',
        phase: 'llm',
        retryable: true,
        http_status: 429,
      },
    });
    expect(state.items[1]).toMatchObject({ kind: 'run', status: 'failed' });
  });

  it('run.cancelled 生成 cancelled run 摘要', () => {
    const state = fold([event('run.cancelled', { run_id: 'r1', error: '', duration_ms: 30 })]);
    expect(state.items[0]).toMatchObject({ kind: 'run', status: 'cancelled', durationMs: 30 });
  });
});

describe('reduceUiProjection：agent.*', () => {
  it('spawned -> turn.* -> closed 更新同一条 agent item', () => {
    const state = fold([
      event('agent.spawned', { agent_id: 'a1', state: 'idle', task: 'do it' }),
      event('agent.turn.started', { agent_id: 'a1', state: 'running' }),
      event('agent.turn.completed', { agent_id: 'a1', state: 'completed' }),
      event('agent.closed', { agent_id: 'a1', state: 'closed' }),
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: 'agent',
      agentId: 'a1',
      state: 'closed',
      task: 'do it',
    });
  });

  it('permission.requested 把成员标为 waiting_permission', () => {
    const state = fold([
      event('agent.spawned', { agent_id: 'a1', state: 'idle' }),
      event('agent.permission.requested', { agent_id: 'a1', tool: 'bash' }),
    ]);
    expect(state.items[0]).toMatchObject({ kind: 'agent', state: 'waiting_permission' });
  });
});

describe('projectMessagesToUiItems（resume）', () => {
  const messages = [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'thinking',
      tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"path":"a.ts"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'file body' },
  ];

  it('user / reasoning / assistant / tool 结构化回灌', () => {
    const items = projectMessagesToUiItems(messages, { showReasoning: true });
    expect(items.map((item) => item.kind)).toEqual(['user', 'reasoning', 'assistant', 'tool']);
    const tool = items[3];
    if (tool?.kind !== 'tool') throw new Error('expected tool');
    expect(tool.view.name).toBe('read');
    expect(tool.view.subtitle).toBe('a.ts');
    expect(tool.view.result).toBe('file body');
  });

  it('showReasoning=false 时不回灌 reasoning', () => {
    const items = projectMessagesToUiItems(messages, { showReasoning: false });
    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool']);
  });

  it('resume 回退把 Error: 前缀的工具结果显示为 failed', () => {
    const items = projectMessagesToUiItems([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'Error: ENOENT' },
    ]);
    const tool = items.find((item) => item.kind === 'tool');
    if (tool?.kind !== 'tool') throw new Error('expected tool');
    expect(tool.view.status).toBe('failed');
    expect(tool.view.result).toBe('Error: ENOENT');
  });

  it('正常结果被前缀判断误标 failed；孤立 tool 消息漏判', () => {
    const paired = projectMessagesToUiItems([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'ok' },
    ]);
    const pairedTool = paired.find((item) => item.kind === 'tool');
    if (pairedTool?.kind !== 'tool') throw new Error('expected tool');
    expect(pairedTool.view.status).toBe('completed');

    const orphan = projectMessagesToUiItems([
      { role: 'tool', tool_call_id: 'c2', name: 'read', content: 'Error: ENOENT' },
    ]);
    const orphanTool = orphan.find((item) => item.kind === 'tool');
    if (orphanTool?.kind !== 'tool') throw new Error('expected tool');
    expect(orphanTool.view.status).toBe('failed');
  });
});

describe('projectUiItems / fullTextOfItem', () => {
  it('事件 + messages 都能投影', () => {
    const items = projectUiItems({
      events: [
        {
          type: 'llm.stream.chunk',
          run_id: 'r1',
          data: { chunk: { type: 'text_delta', delta: 'hi' } },
          ts: 1,
        },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(items.map((item) => item.kind)).toEqual(['assistant', 'user']);
  });

  it('工具 item 的完整载荷包含参数与完整原文', () => {
    const result = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n');
    const state = fold([
      toolStarted('c1'),
      event('tool.call.completed', {
        tool_call_id: 'c1',
        tool_name: 'bash',
        result,
        duration_ms: 1,
      }),
    ]);
    const item = state.items[0];
    if (item === undefined) throw new Error('expected item');
    const full = fullTextOfItem(item);
    expect(full).toContain('ls -la');
    expect(full).toContain('line 10');
  });

  it('unknown 事件被显式忽略', () => {
    const unknown = event('mcp.warning', { message: 'x' });
    expect(unknown.type).toBe('unknown');
    const state = reduceUiProjection(createUiProjection(), unknown);
    expect(state.items).toEqual([]);
  });
});
