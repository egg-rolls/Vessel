import { describe, expect, it } from 'bun:test';
import type { Message, RunState, ToolDefinition } from '@vessel/core';
import {
  CommandRegistry,
  createCommands,
  HISTORY_LIMIT_DEFAULT,
  parseHistoryArgs,
} from '../src/commands/commands.js';
import { makeCtx, makeState } from './helpers.js';

const sampleTool: ToolDefinition = {
  name: 'echo',
  description: '回显输入',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  handler: async () => 'ok',
};

function runState(sessionId: string, messages: Message[]): RunState {
  return {
    run_id: `run-${sessionId}`,
    session_id: sessionId,
    messages,
    started_at: 1000,
    status: 'completed',
  };
}

describe('CommandRegistry 扁平命令', () => {
  it('createCommands 注册 28 个扁平命令（含 0.3 / 0.4 / 0.5 / 0.6.1 / 0.7 / 0.11 命令）', () => {
    const reg = createCommands();
    const names = reg.list().map((e) => e.name);
    expect(names).toContain('tools');
    expect(names).toContain('plugins');
    expect(names).toContain('resume');
    expect(names).toContain('mcp');
    expect(names).toContain('runs');
    expect(names).toContain('workflows');
    expect(names).toContain('metrics');
    expect(names).toContain('feishu');
    expect(names).toContain('capabilities');
    expect(names).toContain('config');
    expect(names).toContain('tenant');
    expect(names).toContain('trace');
    expect(names).toContain('sessions');
    expect(names).toContain('new');
    expect(names).toContain('history');
    expect(names).toContain('help');
    expect(names).toContain('clear');
    expect(names).toContain('setup');
    expect(names).toContain('reload');
    expect(names).toContain('exit');
    // 0.6.1 对标命令
    expect(names).toContain('context');
    expect(names).toContain('compact');
    expect(names).toContain('permissions');
    expect(names).toContain('export');
    expect(names).toContain('cost');
    expect(names).toContain('reasoning');
    expect(names).toContain('details');
    // 0.11 设置
    expect(names).toContain('settings');
    // 已删命令（/skills、/assets）仍不注册
    expect(names).not.toContain('skills');
    expect(names).not.toContain('assets');
    expect(names.length).toBe(28);
    // /sessions 保留为 hidden deprecated alias：注册但不出现在 help/autocomplete
    expect(reg.list().find((e) => e.name === 'sessions')?.hidden).toBe(true);
    expect(reg.visibleList()).toHaveLength(27);
    expect(reg.visibleList().map((e) => e.name)).not.toContain('sessions');
    // /resume 仍是会话恢复，usage 扩展为 delete/rename 子命令
    expect(reg.list().find((e) => e.name === 'resume')?.usage).toBe(
      '/resume [number|id|prefix|title #N|delete <id> --yes|rename <id> <title>]',
    );
    expect(reg.list().find((e) => e.name === 'resume')?.category).toBe('session');
  });

  it('/help 列出 0.3 / 0.4 命令并按 category 分组', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const output = (await reg.execute('help', ctx, state)).output ?? '';
    expect(output).toContain('/mcp [reconnect <name>]');
    expect(output).toContain('/runs [resume <runId>]');
    expect(output).toContain('/workflows [list|run|show|resume|cancel]');
    expect(output).toContain('/metrics');
    expect(output).toContain('/feishu');
    // 分组标题
    expect(output).toContain('SESSION:');
    expect(output).toContain('RUN:');
    expect(output).toContain('INSPECT:');
    expect(output).toContain('CONFIG:');
    expect(output).toContain('SYSTEM:');
    // hidden deprecated alias 不出现在 help
    expect(output).not.toContain('/sessions');
    // picker 键位提示
    expect(output).toContain('picker:');
  });

  it('未知命令 -> handled:false', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const result = await reg.execute('nope', ctx, state);
    expect(result.handled).toBe(false);
  });

  it('命令抛错 -> handled:true + 稳定错误（不向 REPL 抛出）', async () => {
    const reg = new CommandRegistry();
    reg.register({
      name: 'boom',
      description: 'always throws',
      run: async () => {
        throw { code: 'internal', message: 'kaboom' };
      },
    });
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);

    const result = await reg.execute('boom', ctx, state);

    expect(result.handled).toBe(true);
    expect(result.output).toContain('Failed to run /boom');
    expect(result.output).toContain('✗ [internal] kaboom');
  });

  it('数据层失败 -> /history 返回稳定错误而不是 reject', async () => {
    const rpc = {
      request: async <T>(_method: string, _params?: unknown): Promise<T> => {
        throw { code: 'internal', message: 'db down' };
      },
      subscribe: () => () => undefined,
    };
    const reg = createCommands();
    const ctx = makeCtx({ rpc });
    const state = makeState(ctx.currentSessionId);

    const result = await reg.execute('history', ctx, state);

    expect(result.handled).toBe(true);
    expect(result.output).toContain('Failed to run /history');
    expect(result.output).toContain('✗ [internal] db down');
  });

  it('/tools 返回已注册工具', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    ctx.pluginHost.registerTool(sampleTool);
    const state = makeState(ctx.currentSessionId);
    const result = await reg.execute('tools', ctx, state);
    expect(result.output ?? '').toContain('echo');
    expect(result.output ?? '').toContain('回显输入');
  });

  it('/tools 无工具时提示', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const result = await reg.execute('tools', ctx, state);
    expect(result.output ?? '').toContain('No tools registered');
  });

  it('/tools 优先 RPC tools.list', async () => {
    const reg = createCommands();
    const ctx = makeCtx({
      rpc: {
        async request<T = unknown>(method: string): Promise<T> {
          expect(method).toBe('tools.list');
          return { tools: [{ name: 'bash', description: 'shell' }] } as T;
        },
        subscribe: () => () => undefined,
      },
    });
    const result = await reg.execute('tools', ctx, makeState(ctx.currentSessionId));
    expect(result.output ?? '').toContain('bash: shell');
  });

  it('/plugins 优先 RPC plugins.list', async () => {
    const reg = createCommands();
    const ctx = makeCtx({
      rpc: {
        async request<T = unknown>(method: string): Promise<T> {
          expect(method).toBe('plugins.list');
          return { plugins: [{ name: 'workflow', enabled: true }, 'feishu'] } as T;
        },
        subscribe: () => () => undefined,
      },
    });
    const result = await reg.execute('plugins', ctx, makeState(ctx.currentSessionId));
    expect(result.output ?? '').toContain('workflow');
    expect(result.output ?? '').toContain('feishu');
  });
});

describe('扁平会话命令', () => {
  it('/resume <id> 清 context + 切会话', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    await ctx.session.save(runState('target-sess', [{ role: 'user', content: '历史问题' }]));
    let changedTo = '';
    ctx.onSessionChange = (id) => {
      changedTo = id;
    };
    ctx.context.add({ role: 'user', content: '当前会话已有内容' });
    const state = makeState(ctx.currentSessionId);
    await reg.execute('resume target-sess', ctx, state);
    expect(state.currentSessionId).toBe('target-sess');
    expect(changedTo).toBe('target-sess');
    expect(ctx.context.messages.length).toBe(0); // 已 clear
  });

  it('/resume 不存在 id -> 提示 not found', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const result = await reg.execute('resume nope', ctx, state);
    expect(result.output ?? '').toContain('not found');
  });

  it('/resume 无参 -> 设置 showResumePicker + pendingResume', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    await ctx.session.save(runState('s1', [{ role: 'user', content: '问题' }]));
    const state = makeState(ctx.currentSessionId);
    expect(state.showResumePicker).toBe(false);
    await reg.execute('resume', ctx, state);
    expect(state.showResumePicker).toBe(true);
    expect(state.pendingResume).toBe(true);
  });

  it('/resume 无参 + 无会话 -> 不设置 picker', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const result = await reg.execute('resume', ctx, state);
    expect(state.showResumePicker).toBe(false);
    expect(result.output ?? '').toContain('No sessions');
  });

  it('/resume 无参 + 列表失败 -> 稳定错误且不伪装成无会话', async () => {
    const rpc = {
      request: async <T>(_method: string, _params?: unknown): Promise<T> => {
        throw { code: 'internal', message: 'list down' };
      },
      subscribe: () => () => undefined,
    };
    const reg = createCommands();
    const ctx = makeCtx({ rpc });
    const state = makeState(ctx.currentSessionId);

    const result = await reg.execute('resume', ctx, state);

    expect(state.showResumePicker).toBe(false);
    expect(result.output).toContain('Failed to list sessions');
    expect(result.output).toContain('✗ [internal] list down');
  });

  it('/resume delete 未带 --yes -> 不发 RPC', async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      rpc: {
        request: async <T>(method: string): Promise<T> => {
          calls.push(method);
          return {} as T;
        },
        subscribe: () => () => undefined,
      },
      currentSessionId: 'current',
    });
    const state = makeState('current');
    const result = await createCommands().execute('resume delete other-session', ctx, state);
    expect(result.output).toContain('Add --yes to confirm');
    expect(calls).not.toContain('sessions.delete');
  });

  it('/resume delete --yes 调 sessions.delete', async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const ctx = makeCtx({
      rpc: {
        request: async <T>(method: string, params?: unknown): Promise<T> => {
          calls.push({ method, ...(params !== undefined ? { params } : {}) });
          return { sessions_deleted: 1, runs_deleted: 2, events_deleted: 3 } as T;
        },
        subscribe: () => () => undefined,
      },
      currentSessionId: 'current',
    });
    const state = makeState('current');
    const result = await createCommands().execute('resume delete other-session --yes', ctx, state);
    expect(result.output).toContain('Deleted session "other-session".');
    expect(result.output).toContain('sessions: 1, runs: 2, events: 3');
    expect(calls[0]).toEqual({
      method: 'sessions.delete',
      params: { session_id: 'other-session' },
    });
  });

  it('/resume delete 当前会话 -> 拒绝', async () => {
    const reg2 = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const result = await reg2.execute(`resume delete ${ctx.currentSessionId} --yes`, ctx, state);
    expect(result.output).toContain('Refusing to delete the current session');
  });

  it('/resume rename 透传 id 与 title', async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const ctx2 = makeCtx({
      rpc: {
        request: async <T>(method: string, params?: unknown): Promise<T> => {
          calls.push({ method, ...(params !== undefined ? { params } : {}) });
          return {} as T;
        },
        subscribe: () => () => undefined,
      },
    });
    const state = makeState(ctx2.currentSessionId);
    const result = await createCommands().execute('resume rename s1 My new title', ctx2, state);
    expect(result.output).toContain('Renamed session "s1" to "My new title".');
    expect(calls[0]).toEqual({
      method: 'sessions.rename',
      params: { session_id: 's1', title: 'My new title' },
    });
  });

  it('/resume rename 空标题 -> usage，不发 RPC', async () => {
    let called = 0;
    const ctx2 = makeCtx({
      rpc: {
        request: async <T>(): Promise<T> => {
          called += 1;
          return {} as T;
        },
        subscribe: () => () => undefined,
      },
    });
    const result = await createCommands().execute('resume rename s1', ctx2, makeState('current'));
    expect(result.output).toContain('Usage: /resume rename');
    expect(called).toBe(0);
  });

  it('/new 清 context + 新 id + 丢弃空当前会话', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    // 当前会话存在但为空 -> 应被丢弃
    await ctx.session.save(runState(ctx.currentSessionId, []));
    let newId = '';
    ctx.onSessionChange = (id) => {
      newId = id;
    };
    ctx.context.add({ role: 'user', content: '旧内容' });
    const state = makeState(ctx.currentSessionId);
    await reg.execute('new', ctx, state);
    expect(state.currentSessionId).toBe(newId);
    expect(ctx.context.messages.length).toBe(0);
    // 旧空会话被丢弃
    expect(await ctx.session.load(ctx.currentSessionId)).toBeNull(); // 注意：currentSessionId 已变，这里用原值
  });

  it('/history 返回当前会话消息', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    await ctx.session.save(
      runState(ctx.currentSessionId, [
        { role: 'user', content: '问' },
        { role: 'assistant', content: '答' },
      ]),
    );
    const state = makeState(ctx.currentSessionId);
    const result = await reg.execute('history', ctx, state);
    const out = result.output ?? '';
    expect(out).toContain('[User]');
    expect(out).toContain('问');
    expect(out).toContain('[Assistant]');
    expect(out).toContain('答');
  });

  it('/history 无历史时提示', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const result = await reg.execute('history', ctx, state);
    expect(result.output ?? '').toContain('No conversation history');
  });

  it('/history 截断超长消息，注入文件只显示路径', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    await ctx.session.save(
      runState(ctx.currentSessionId, [
        { role: 'user', content: '<file path="a.md">\nbody\n</file>' },
        { role: 'assistant', content: 'x'.repeat(2000) },
      ]),
    );
    const state = makeState(ctx.currentSessionId);
    const out = (await reg.execute('history', ctx, state)).output ?? '';
    expect(out).toContain('[User · file] a.md');
    expect(out).toContain('(+800 chars)');
  });

  it('/history --limit 只显示最近 N 条', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    await ctx.session.save(
      runState(ctx.currentSessionId, [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: 'third' },
      ]),
    );
    const state = makeState(ctx.currentSessionId);

    const out = (await reg.execute('history --limit 2', ctx, state)).output ?? '';

    expect(out).toContain('History (2 of 3 messages, last 2):');
    expect(out).not.toContain('first');
    expect(out).toContain('second');
    expect(out).toContain('third');
  });

  it('/history 无参默认只输出最近 50 条并在标题注明', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const messages = Array.from({ length: 55 }, (_, i) => ({
      role: 'user' as const,
      content: `m${String(i + 1).padStart(3, '0')}`,
    }));
    await ctx.session.save(runState(ctx.currentSessionId, messages));
    const state = makeState(ctx.currentSessionId);

    const out = (await reg.execute('history', ctx, state)).output ?? '';

    expect(out).toContain(`History (50 of 55 messages, last ${HISTORY_LIMIT_DEFAULT}):`);
    expect(out).toContain('m006');
    expect(out).toContain('m055');
    expect(out).not.toContain('m001');
    expect(out).not.toContain('m005');
  });

  it('/history --role 无 --limit 时先过滤，再取最近 50 条', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const messages = Array.from({ length: 60 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `r${String(i + 1).padStart(3, '0')}`,
    }));
    await ctx.session.save(runState(ctx.currentSessionId, messages));
    const state = makeState(ctx.currentSessionId);

    const out = (await reg.execute('history --role assistant', ctx, state)).output ?? '';

    expect(out).toContain(
      `History (30 of 30 messages, role=assistant, last ${HISTORY_LIMIT_DEFAULT}):`,
    );
    expect(out).not.toContain('r001'); // user
    expect(out).toContain('r002'); // assistant
    expect(out).toContain('r060'); // assistant, latest
  });

  it('/history --role 先过滤再取最近 N 条', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    await ctx.session.save(
      runState(ctx.currentSessionId, [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
      ]),
    );
    const state = makeState(ctx.currentSessionId);

    const out = (await reg.execute('history --role user --limit 1', ctx, state)).output ?? '';

    expect(out).toContain('History (1 of 2 messages, role=user, last 1):');
    expect(out).toContain('u2');
    expect(out).not.toContain('u1');
    expect(out).not.toContain('a1');
    expect(out).not.toContain('a2');
  });

  it('/history --role 无匹配 -> 明确提示', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    await ctx.session.save(
      runState(ctx.currentSessionId, [{ role: 'user', content: 'only user' }]),
    );
    const state = makeState(ctx.currentSessionId);

    const out = (await reg.execute('history --role assistant', ctx, state)).output ?? '';

    expect(out).toContain('No assistant messages in this session.');
  });

  it('/history 参数非法 -> usage，不读数据', async () => {
    const reg = createCommands();
    let reads = 0;
    const ctx = makeCtx({
      rpc: {
        request: async <T>(_method: string, _params?: unknown): Promise<T> => {
          reads += 1;
          return {} as T;
        },
        subscribe: () => () => undefined,
      },
    });
    const state = makeState(ctx.currentSessionId);

    const badLimit = (await reg.execute('history --limit 0', ctx, state)).output ?? '';
    const badRole = (await reg.execute('history --role system', ctx, state)).output ?? '';
    const unknown = (await reg.execute('history --bogus', ctx, state)).output ?? '';

    expect(badLimit).toContain('--limit must be an integer between 1 and 500');
    expect(badRole).toContain('--role must be one of: user, assistant, tool');
    expect(unknown).toContain('unknown argument "--bogus"');
    expect(reads).toBe(0);
  });

  it('/exit 置 running=false 并调 onExit', async () => {
    const reg = createCommands();
    let exited = false;
    const ctx = makeCtx({
      onExit: () => {
        exited = true;
      },
    });
    const state = makeState(ctx.currentSessionId);
    await reg.execute('exit', ctx, state);
    expect(state.running).toBe(false);
    expect(exited).toBe(true);
  });

  it('/clear 返回 clearScreen 标记（不抛错）', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const result = await reg.execute('clear', ctx, state);
    expect(result.handled).toBe(true);
    expect(result.clearScreen).toBe(true);
  });
});

describe('parseHistoryArgs', () => {
  it('解析 limit 与 role', () => {
    expect(parseHistoryArgs(['--limit', '20'])).toEqual({ ok: true, value: { limit: 20 } });
    expect(parseHistoryArgs(['--role', 'tool'])).toEqual({ ok: true, value: { role: 'tool' } });
    expect(parseHistoryArgs(['--role', 'user', '--limit', '1'])).toEqual({
      ok: true,
      value: { role: 'user', limit: 1 },
    });
  });

  it('拒绝 0、负数、非整数与超上限', () => {
    for (const value of ['0', '-1', '1.5', 'abc', '501']) {
      const result = parseHistoryArgs(['--limit', value]);
      expect(result.ok).toBe(false);
    }
  });

  it('拒绝 system 角色与未知参数', () => {
    expect(parseHistoryArgs(['--role', 'system']).ok).toBe(false);
    expect(parseHistoryArgs(['extra']).ok).toBe(false);
    expect(parseHistoryArgs(['--limit']).ok).toBe(false);
  });
});
