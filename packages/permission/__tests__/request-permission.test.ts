import { describe, expect, it } from 'bun:test';
import { MemoryEventStream, type ToolContext } from '@vessel-agent/core';
import { requestPermission } from '../src/index';

function makeContext(events: MemoryEventStream, overrides: Partial<ToolContext> = {}): ToolContext {
  return { run_id: 'run-1', messages: [], events, ...overrides };
}

/** 订阅请求事件并同步应答 allow，返回捕获到的请求 data。 */
function autoAllow(events: MemoryEventStream): Array<Record<string, unknown>> {
  const requests: Array<Record<string, unknown>> = [];
  events.subscribe((event) => {
    if (event.type !== 'tool.permission.request') return;
    const data = event.data as Record<string, unknown>;
    requests.push(data);
    events.publish({
      type: 'tool.permission.response',
      run_id: event.run_id,
      data: { requestId: data.requestId, decision: 'allow' },
      ts: Date.now(),
    });
  });
  return requests;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('requestPermission events', () => {
  it('permission request drops session correlation', async () => {
    const events = new MemoryEventStream();
    const requests = autoAllow(events);
    const ctx = makeContext(events, {
      session_id: 's-1',
      tool_call_id: 'call-1',
      source: 'runtime',
    });

    const decision = await requestPermission(ctx, 'bash', { cmd: 'ls' });

    expect(decision).toBe('allow');
    expect(requests).toHaveLength(1);
    const data = requests[0];
    if (data === undefined) throw new Error('expected tool.permission.request');
    expect(data).toMatchObject({
      session_id: 's-1',
      tool_call_id: 'call-1',
      source: 'runtime',
    });
  });

  it('omits session_id when the context has none', async () => {
    const events = new MemoryEventStream();
    const requests = autoAllow(events);

    const decision = await requestPermission(makeContext(events), 'bash', { cmd: 'ls' });

    expect(decision).toBe('allow');
    const data = requests[0];
    if (data === undefined) throw new Error('expected tool.permission.request');
    expect('session_id' in data).toBe(false);
  });

  it('waits without a timeout by default（只有显式正数 timeout 才计时）', async () => {
    const events = new MemoryEventStream();
    const controller = new AbortController();
    const pending = requestPermission(makeContext(events, { signal: controller.signal }), 'bash', {
      cmd: 'ls',
    });
    let settled = false;
    pending.then(() => {
      settled = true;
    });

    await sleep(80);
    expect(settled).toBe(false);
    // 默认无限等待；abort 时旧语义仍兜底返回 'ask'（由调用方决定是否再次询问）
    controller.abort('cancel');
    expect(await pending).toBe('ask');
  });

  it('explicit positive timeout falls back to ask', async () => {
    const events = new MemoryEventStream();
    const started = performance.now();
    expect(await requestPermission(makeContext(events), 'bash', { cmd: 'ls' }, 20)).toBe('ask');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
