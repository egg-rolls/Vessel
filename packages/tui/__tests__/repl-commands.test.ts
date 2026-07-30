import { describe, expect, it } from 'bun:test';
import type { Message, RunState, ToolDefinition } from '@vessel/core';
import { createCommands } from '../src/commands/commands.js';
import { captureConsole, makeCtx, makeState } from './helpers.js';

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
  it('createCommands 注册 11 个顶层命令', () => {
    const reg = createCommands();
    const names = reg.list().map((e) => e.name);
    expect(names).toContain('sessions');
    expect(names).toContain('resume');
    expect(names).toContain('new');
    expect(names).toContain('history');
    expect(names).toContain('delete');
    expect(names).toContain('tools');
    expect(names).toContain('help');
    expect(names).toContain('clear');
    expect(names).toContain('setup');
    expect(names).toContain('reload');
    expect(names).toContain('exit');
  });

  it('未知命令 -> handled:false', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const result = await reg.execute('nope', ctx, state);
    expect(result.handled).toBe(false);
  });

  it('/tools 打印已注册工具', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    ctx.tools.register(sampleTool);
    const state = makeState(ctx.currentSessionId);
    const cap = captureConsole();
    await reg.execute('tools', ctx, state);
    cap.restore();
    expect(cap.logs.join('\n')).toContain('echo');
    expect(cap.logs.join('\n')).toContain('回显输入');
  });

  it('/tools 无工具时提示', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const cap = captureConsole();
    await reg.execute('tools', ctx, state);
    cap.restore();
    expect(cap.logs.join('\n')).toContain('No tools registered');
  });

  it('/help 显示所有命令', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const cap = captureConsole();
    const result = await reg.execute('help', ctx, state);
    cap.restore();
    expect(result.handled).toBe(true);
    expect(cap.logs.join('\n')).toContain('/sessions');
    expect(cap.logs.join('\n')).toContain('/resume');
    expect(cap.logs.join('\n')).toContain('/new');
  });
});

describe('/sessions 命令', () => {
  it('/sessions 空时提示 No sessions', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const cap = captureConsole();
    await reg.execute('sessions', ctx, state);
    cap.restore();
    expect(cap.logs.join('\n')).toContain('No sessions');
  });

  it('/sessions 列出编号会话', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    await ctx.session.save(runState('s1', [{ role: 'user', content: '第一个问题' }]));
    await ctx.session.save(runState('s2', [{ role: 'user', content: '第二个问题' }]));
    const state = makeState('s1');
    const cap = captureConsole();
    await reg.execute('sessions', ctx, state);
    cap.restore();
    const out = cap.logs.join('\n');
    expect(out).toContain('1.');
    expect(out).toContain('2.');
    expect(out).toContain('第一个问题');
  });
});

describe('/resume 命令', () => {
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
    const cap = captureConsole();
    await reg.execute('resume target-sess', ctx, state);
    cap.restore();
    expect(state.currentSessionId).toBe('target-sess');
    expect(changedTo).toBe('target-sess');
    expect(ctx.context.messages.length).toBe(0); // 已 clear
  });

  it('/resume 不存在 id -> 提示 not found', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const cap = captureConsole();
    await reg.execute('resume nope', ctx, state);
    cap.restore();
    expect(cap.logs.join('\n')).toContain('not found');
  });

  it('/resume 无参 -> 设置 pendingResume', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    await ctx.session.save(runState('s1', [{ role: 'user', content: '历史' }]));
    const state = makeState(ctx.currentSessionId);
    const cap = captureConsole();
    await reg.execute('resume', ctx, state);
    cap.restore();
    expect(state.pendingResume).toBe(true);
    expect(cap.logs.join('\n')).toContain('Resume which session');
  });
});

describe('/new 命令', () => {
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
    const cap = captureConsole();
    await reg.execute('new', ctx, state);
    cap.restore();
    expect(state.currentSessionId).toBe(newId);
    expect(ctx.context.messages.length).toBe(0);
    // 旧空会话被丢弃
    expect(await ctx.session.load(ctx.currentSessionId)).toBeNull(); // 注意：currentSessionId 已变，这里用原值
  });
});

describe('/history 命令', () => {
  it('/history 打印当前会话消息', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    await ctx.session.save(
      runState(ctx.currentSessionId, [
        { role: 'user', content: '问' },
        { role: 'assistant', content: '答' },
      ]),
    );
    const state = makeState(ctx.currentSessionId);
    const cap = captureConsole();
    await reg.execute('history', ctx, state);
    cap.restore();
    const out = cap.logs.join('\n');
    expect(out).toContain('[User]');
    expect(out).toContain('问');
    expect(out).toContain('[Assistant]');
    expect(out).toContain('答');
  });

  it('/history 无历史时提示', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const cap = captureConsole();
    await reg.execute('history', ctx, state);
    cap.restore();
    expect(cap.logs.join('\n')).toContain('No conversation history');
  });
});

describe('/delete 命令', () => {
  it('/delete <id> 删除指定会话', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    await ctx.session.save(runState('del-target', [{ role: 'user', content: '要删的' }]));
    const state = makeState(ctx.currentSessionId);
    const cap = captureConsole();
    await reg.execute('delete del-target', ctx, state);
    cap.restore();
    expect(cap.logs.join('\n')).toContain('Deleted');
    expect(await ctx.session.load('del-target')).toBeNull();
  });

  it('/delete 不存在 id -> 提示 not found', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const cap = captureConsole();
    await reg.execute('delete nope', ctx, state);
    cap.restore();
    expect(cap.logs.join('\n')).toContain('not found');
  });

  it('/delete 无参 -> 设置 pendingDelete', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    await ctx.session.save(runState('s1', [{ role: 'user', content: '历史' }]));
    const state = makeState(ctx.currentSessionId);
    const cap = captureConsole();
    await reg.execute('delete', ctx, state);
    cap.restore();
    expect(state.pendingDelete).toBe(true);
    expect(cap.logs.join('\n')).toContain('Delete which session');
  });

  it('/delete 当前会话 -> 自动开新会话', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const currentId = ctx.currentSessionId;
    await ctx.session.save(runState(currentId, [{ role: 'user', content: '当前' }]));
    const newSessionId = 'new-session-after-delete';
    ctx.newSessionId = () => newSessionId;
    let changedTo = '';
    ctx.onSessionChange = (id) => {
      changedTo = id;
    };
    const state = makeState(currentId);
    const cap = captureConsole();
    await reg.execute(`delete ${currentId}`, ctx, state);
    cap.restore();
    expect(state.currentSessionId).toBe(newSessionId);
    expect(changedTo).toBe(newSessionId);
  });
});

describe('系统命令', () => {
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

  it('/clear 调 console.clear（不抛错）', async () => {
    const reg = createCommands();
    const ctx = makeCtx();
    const state = makeState(ctx.currentSessionId);
    const result = await reg.execute('clear', ctx, state);
    expect(result.handled).toBe(true);
  });
});
