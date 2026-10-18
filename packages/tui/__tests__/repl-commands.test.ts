import { describe, expect, it } from 'bun:test';
import type { Message, RunState, ToolDefinition } from '@vessel/core';
import { createCommands } from '../src/commands/commands.js';
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
  it('createCommands 注册 20 个扁平命令（含 0.3 / 0.4 / 0.5 命令）', () => {
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
    // 已删命令（/skills、/assets）仍不注册
    expect(names).not.toContain('skills');
    expect(names).not.toContain('assets');
    expect(names.length).toBe(20);
    // /resume 仍是会话恢复，usage 不被 /runs 影响
    expect(reg.list().find((e) => e.name === 'resume')?.usage).toBe('/resume [number|id]');
  });

  it('/help 列出 0.3 / 0.4 命令', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const output = (await reg.execute('help', ctx, state)).output ?? '';
    expect(output).toContain('/mcp [reconnect <name>]');
    expect(output).toContain('/runs [resume <runId>]');
    expect(output).toContain('/workflows [list|run|show|resume|cancel]');
    expect(output).toContain('/metrics');
    expect(output).toContain('/feishu');
  });

  it('未知命令 -> handled:false', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const result = await reg.execute('nope', ctx, state);
    expect(result.handled).toBe(false);
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

  it('/setup 不在 REPL 内启动 readline 向导，给出退出后路径', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const result = await reg.execute('setup', ctx, state);
    const out = result.output ?? '';
    expect(out).toContain('cannot run inside the REPL');
    expect(out).toContain('Exit Vessel');
  });
});
