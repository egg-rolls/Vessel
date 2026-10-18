import { describe, expect, it } from 'bun:test';
import {
  formatTraceEvents,
  parseTraceArgs,
  readTraceEvents,
  runTraceCommand,
  sortTraceEvents,
} from '../src/commands/trace-command.js';
import type { RpcClientLike } from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

const NOW = 1_700_000_000_000;

const EVENTS = [
  { type: 'run.started', run_id: 'r1', seq: 1, ts: NOW - 3000, data: {} },
  {
    type: 'tool.call.started',
    run_id: 'r1',
    seq: 3,
    ts: NOW - 1000,
    data: { tool_name: 'bash', args: { token: 'secret-token', api_key: 'sk-live-xyz' } },
  },
  {
    type: 'llm.stream.chunk',
    run_id: 'r1',
    seq: 2,
    ts: NOW - 2000,
    data: { delta: 'hello world' },
  },
];

function makeRpc(
  handler: (method: string, params?: unknown) => unknown,
): RpcClientLike & { calls: Array<{ method: string; params?: unknown }> } {
  const calls: Array<{ method: string; params?: unknown }> = [];
  return {
    calls,
    async request<T = unknown>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, ...(params !== undefined ? { params } : {}) });
      return (await handler(method, params)) as T;
    },
    subscribe: () => () => undefined,
  };
}

describe('parseTraceArgs', () => {
  it('默认值', () => {
    const parsed = parseTraceArgs(['show', 'r1']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual({ runId: 'r1', limit: 50, json: false });
  });

  it('全部参数', () => {
    const parsed = parseTraceArgs([
      'show',
      'r1',
      '--limit',
      '10',
      '--since-seq',
      '5',
      '--types',
      'run.started,tool.call.started',
      '--json',
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.limit).toBe(10);
      expect(parsed.value.sinceSeq).toBe(5);
      expect(parsed.value.types).toEqual(['run.started', 'tool.call.started']);
      expect(parsed.value.json).toBe(true);
    }
  });

  it('--type 前缀', () => {
    const parsed = parseTraceArgs(['show', 'r1', '--type', 'llm.']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.typePrefix).toBe('llm.');
  });

  it('非法输入', () => {
    expect(parseTraceArgs([]).ok).toBe(false);
    expect(parseTraceArgs(['list']).ok).toBe(false);
    expect(parseTraceArgs(['show']).ok).toBe(false);
    expect(parseTraceArgs(['show', 'r1', '--limit', '0']).ok).toBe(false);
    expect(parseTraceArgs(['show', 'r1', '--limit', '501']).ok).toBe(false);
    expect(parseTraceArgs(['show', 'r1', '--since-seq', 'x']).ok).toBe(false);
    expect(parseTraceArgs(['show', 'r1', '--type', 'a', '--types', 'b']).ok).toBe(false);
    expect(parseTraceArgs(['show', 'r1', '--types', ',,']).ok).toBe(false);
    expect(parseTraceArgs(['show', 'r1', '--nope']).ok).toBe(false);
  });
});

describe('/trace', () => {
  it('按 seq 排序并展示事件', async () => {
    const rpc = makeRpc(() => [...EVENTS].reverse());
    const result = await runTraceCommand(['show', 'r1'], makeCtx({ rpc }));
    const output = result.output ?? '';

    expect(output).toContain('Events (3, oldest first):');
    expect(output.indexOf('#1')).toBeLessThan(output.indexOf('#2'));
    expect(output.indexOf('#2')).toBeLessThan(output.indexOf('#3'));
    expect(output).toContain('chars=11');
    expect(output).toContain('tool.call.started');
  });

  it('展示前脱敏 data', async () => {
    const rpc = makeRpc(() => EVENTS);
    const result = await runTraceCommand(['show', 'r1'], makeCtx({ rpc }));
    expect(result.output).not.toContain('secret-token');
    expect(result.output).not.toContain('sk-live-xyz');
    expect(result.output).toContain('***');
  });

  it('参数透传 events.list', async () => {
    const rpc = makeRpc(() => []);
    await runTraceCommand(
      ['show', 'r1', '--limit', '10', '--since-seq', '5', '--type', 'run.'],
      makeCtx({ rpc }),
    );
    expect(rpc.calls).toEqual([
      {
        method: 'events.list',
        params: { run_id: 'r1', limit: 10, since_seq: 5, type_prefix: 'run.' },
      },
    ]);
  });

  it('types 参数透传', async () => {
    const rpc = makeRpc(() => []);
    await runTraceCommand(['show', 'r1', '--types', 'run.started,run.completed'], makeCtx({ rpc }));
    expect(rpc.calls[0]?.params).toEqual({
      run_id: 'r1',
      limit: 50,
      types: ['run.started', 'run.completed'],
    });
  });

  it('空结果显示明确文案', async () => {
    const rpc = makeRpc(() => ({ events: [] }));
    const result = await runTraceCommand(['show', 'r1'], makeCtx({ rpc }));
    expect(result.output).toContain('No events for run "r1"');
  });

  it('--json 输出可解析且已脱敏', async () => {
    const rpc = makeRpc(() => EVENTS);
    const result = await runTraceCommand(['show', 'r1', '--json'], makeCtx({ rpc }));
    const parsed = JSON.parse((result.output ?? '').trim()) as Array<{
      seq: number;
      data?: Record<string, unknown>;
    }>;
    expect(parsed.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(JSON.stringify(parsed)).not.toContain('secret-token');
  });

  it('没有 rpc 时给明确提示', async () => {
    const result = await runTraceCommand(['show', 'r1'], makeCtx());
    expect(result.output).toContain('RPC control plane is not available');
  });

  it('RPC 错误按 code 展示', async () => {
    const rpc = makeRpc(() => {
      throw { code: 'not_found', message: 'run not found' };
    });
    const result = await runTraceCommand(['show', 'r1'], makeCtx({ rpc }));
    expect(result.output).toContain('✗ [not_found] run not found');
  });

  it('readTraceEvents 兼容裸数组与包装', () => {
    expect(readTraceEvents(EVENTS)).toHaveLength(3);
    expect(readTraceEvents({ events: EVENTS })).toHaveLength(3);
    expect(readTraceEvents([{ run_id: 'x' }, { type: 'ok' }])).toHaveLength(1);
  });

  it('缺少 seq 时用 ts 排序并显示 #-', () => {
    const events = sortTraceEvents([
      { type: 'b', ts: 20 },
      { type: 'a', ts: 10 },
    ]);
    expect(events.map((event) => event.type)).toEqual(['a', 'b']);
    const output = formatTraceEvents(events, NOW);
    expect(output).toContain('#-');
  });
});
