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

  it('emits hook.failed and rethrows', async () => {
    const events = new MemoryEventStream();
    const runner = new HookRunner(
      hostWith([
        {
          name: 'boom',
          type: HookType.AfterTool,
          run: async () => {
            throw new Error('hook exploded');
          },
        },
      ]),
      events,
    );

    await expect(runner.run(HookType.AfterTool, { run_id: 'r1' })).rejects.toThrow('hook exploded');

    const failed = events.getHistory().find((e) => e.type === 'hook.failed');
    expect(failed?.data).toMatchObject({ hook_name: 'boom', error: 'hook exploded' });
  });
});
