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
  it('connected 单行输出', () => {
    const output = formatFeishuStatus(connected);
    expect(output).not.toContain('\n');
    expect(output).toContain('Feishu: connected');
    expect(output).toContain('appId cli_***');
    expect(output).toContain('active chats 2');
    expect(output).toContain('queued 0');
  });

  it('disconnected 显示 last_error（单行）', () => {
    const output = formatFeishuStatus(disconnected);
    expect(output).toContain('Feishu: disconnected');
    expect(output).toContain('queued 3');
    expect(output).toContain('last error connect timeout');
    expect(output).not.toContain('\n');
  });

  it('空 appIdMasked 显示占位', () => {
    expect(formatFeishuStatus({ ...connected, appIdMasked: '' })).toContain('appId -');
  });
});

describe('/feishu command', () => {
  it('未注入控制面 -> 明确提示', () => {
    const result = runFeishuCommand([], makeCtx());
    expect(result.handled).toBe(true);
    expect(result.output ?? '').toContain('Feishu is not enabled');
  });

  it('未连接但已注入 -> 照常展示', () => {
    const ctx = makeCtx();
    ctx.feishu = { status: () => disconnected };
    const output = runFeishuCommand([], ctx).output ?? '';
    expect(output).toContain('Feishu: disconnected');
    expect(output).toContain('last error connect timeout');
  });

  it('多余参数返回 usage', () => {
    const ctx = makeCtx();
    ctx.feishu = { status: () => connected };
    expect(runFeishuCommand(['start'], ctx).output ?? '').toContain('Usage: /feishu');
  });

  it('status() 抛错走 error-classifier', () => {
    const ctx = makeCtx();
    ctx.feishu = {
      status: () => {
        throw new Error('channel_not_connected');
      },
    };
    const output = runFeishuCommand([], ctx).output ?? '';
    expect(output).toContain('Failed to read Feishu status');
    expect(output).toContain('[network]');
  });
});
