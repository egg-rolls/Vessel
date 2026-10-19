import { describe, expect, it } from 'bun:test';
import { createCommands } from '../src/commands/commands.js';
import { makeCtx, makeState } from './helpers.js';

describe('/help availability markers', () => {
  it('不可用命令带具体原因，而不是误导为已可用', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const output = (await reg.execute('help', ctx, makeState(ctx.currentSessionId))).output ?? '';

    expect(output).toContain('/capabilities');
    expect(output).toContain('(RPC required)');
    expect(output).toContain('(durable disabled)');
    expect(output).toContain('(workflows disabled)');
    expect(output).toContain('(not configured)');
    expect(output).toContain('(not enabled)');
    // hidden alias 仍不出现
    expect(output).not.toContain('/sessions');
  });

  it('有 rpc / 控制面后 help 不再标注 RPC required', async () => {
    const reg = createCommands();
    const ctx = makeCtx({
      rpc: {
        async request<T = unknown>(): Promise<T> {
          return {} as T;
        },
        subscribe: () => () => undefined,
      },
    });
    const output = (await reg.execute('help', ctx, makeState(ctx.currentSessionId))).output ?? '';
    expect(output).not.toContain('(RPC required)');
  });
});
