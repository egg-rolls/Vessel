import { describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '../src/events/event-stream';
import { HookRunner } from '../src/runtime/hook-runner';
import { HookType } from '../src/types/hook';
import type { PluginHost } from '../src/types/plugin';

function hostWith(hooks: Array<Record<string, unknown>>): PluginHost {
  return { getHooks: () => hooks } as unknown as PluginHost;
}

describe('HookRunner events (0.5 event manifest)', () => {
  it('emits hook.started and hook.completed with tenant_id', async () => {
    const events = new MemoryEventStream();
    const runner = new HookRunner(
      hostWith([{ name: 'logger', type: HookType.BeforeLlm, run: async () => {} }]),
      events,
      'acme',
    );

    await runner.run(HookType.BeforeLlm, { run_id: 'r1', session_id: 's1' });

    const history = events.getHistory();
    expect(history.map((e) => e.type)).toEqual(['hook.started', 'hook.completed']);
    expect(history.every((e) => e.tenant_id === 'acme')).toBe(true);
    expect(history[0]?.data).toMatchObject({
      hook_name: 'logger',
      hook_type: HookType.BeforeLlm,
      run_id: 'r1',
      session_id: 's1',
    });
    const completed = history[1]?.data as { duration_ms?: unknown } | undefined;
    expect(typeof completed?.duration_ms).toBe('number');
  });

  it('isolates a throwing hook: emits hook.failed + hook.error and continues', async () => {
    const events = new MemoryEventStream();
    const seen: string[] = [];
    const runner = new HookRunner(
      hostWith([
        {
          name: 'boom',
          type: HookType.AfterTool,
          run: async () => {
            seen.push('boom');
            throw new Error('hook exploded');
          },
        },
        {
          name: 'after',
          type: HookType.AfterTool,
          run: async () => {
            seen.push('after');
            return { block: true, reason: 'still works' };
          },
        },
      ]),
      events,
    );

    // 0.8 C2：坏 hook 不向上传播，后续 hook 继续执行
    const result = await runner.run(HookType.AfterTool, { run_id: 'r1' });
    expect(result).toEqual({ block: true, reason: 'still works' });
    expect(seen).toEqual(['boom', 'after']);

    const failed = events.getHistory().find((e) => e.type === 'hook.failed');
    expect(failed?.data).toMatchObject({ hook_name: 'boom', error: 'hook exploded' });
    const errored = events.getHistory().find((e) => e.type === 'hook.error');
    expect(errored?.data).toMatchObject({ hook_name: 'boom', error: 'hook exploded' });
  });
});
