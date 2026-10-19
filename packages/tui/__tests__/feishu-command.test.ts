import { describe, expect, it } from 'bun:test';
import { formatFeishuStatus, runFeishuCommand } from '../src/commands/feishu-command.js';
import type { FeishuStatusLike } from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

const connected: FeishuStatusLike = {
  connected: true,
  appIdMasked: 'cli_***',
  active_chats: 2,
  queued_messages: 0,
};

const disconnected: FeishuStatusLike = {
  connected: false,
  appIdMasked: 'cli_***',
  active_chats: 0,
  queued_messages: 3,
  last_error: 'connect\ntimeout',
};

describe('formatFeishuStatus', () => {
  it('disconnected 显示 last_error（单行）', () => {
    const output = formatFeishuStatus(disconnected);
    expect(output).toContain('Feishu: disconnected');
    expect(output).toContain('queued 3');
    expect(output).toContain('last error connect timeout');
    expect(output).not.toContain('\n');
  });
});

describe('/feishu command', () => {
  it('未注入控制面 -> 明确提示', async () => {
    const result = await runFeishuCommand([], makeCtx());
    expect(result.handled).toBe(true);
    expect(result.output ?? '').toContain('Feishu is not enabled');
  });

  it('无 rpc 时回退 ctx.feishu', async () => {
    const ctx = makeCtx();
    ctx.feishu = { status: () => disconnected };
    const output = (await runFeishuCommand([], ctx)).output ?? '';
    expect(output).toContain('Feishu: disconnected');
    expect(output).toContain('last error connect timeout');
  });

  it('RPC feishu.status 优先', async () => {
    let called = 0;
    const ctx = makeCtx({
      feishu: { status: () => connected },
      rpc: {
        async request<T = unknown>(method: string): Promise<T> {
          called += 1;
          expect(method).toBe('feishu.status');
          return { status: disconnected } as T;
        },
        subscribe: () => () => undefined,
      },
    });
    const output = (await runFeishuCommand([], ctx)).output ?? '';
    expect(called).toBe(1);
    expect(output).toContain('Feishu: disconnected');
  });

  it('多余参数返回 usage', async () => {
    const ctx = makeCtx();
    ctx.feishu = { status: () => connected };
    expect((await runFeishuCommand(['start'], ctx)).output ?? '').toContain('Usage: /feishu');
  });

  it('status() 抛错走 error-classifier', async () => {
    const ctx = makeCtx();
    ctx.feishu = {
      status: () => {
        throw new Error('channel_not_connected');
      },
    };
    const output = (await runFeishuCommand([], ctx)).output ?? '';
    expect(output).toContain('Failed to read Feishu status');
    expect(output).toContain('[network]');
  });

  it('RPC 错误按 code 展示', async () => {
    const ctx = makeCtx({
      rpc: {
        async request<T = unknown>(): Promise<T> {
          throw { code: 'forbidden', message: 'feishu disabled' };
        },
        subscribe: () => () => undefined,
      },
    });
    const output = (await runFeishuCommand([], ctx)).output ?? '';
    expect(output).toContain('[forbidden]');
  });
});
