import { beforeEach, describe, expect, it } from 'bun:test';
import { HookType, MemoryPluginHost } from '@vessel/core';
import loggingHookPlugin, { createLoggingHooks, LoggingHook } from '../src/index';

describe('hook-logging 插件（MECH-1）', () => {
  let host: MemoryPluginHost;

  beforeEach(() => {
    host = new MemoryPluginHost();
    loggingHookPlugin.install(host);
  });

  it('install 注册 5 个 hook（覆盖全生命周期）', () => {
    const hooks = host.getHooks();
    expect(hooks).toHaveLength(5);
    const types = hooks.map((h) => h.type);
    expect(types).toContain(HookType.BeforeLlm);
    expect(types).toContain(HookType.AfterLlm);
    expect(types).toContain(HookType.BeforeTool);
    expect(types).toContain(HookType.AfterTool);
    expect(types).toContain(HookType.OnError);
  });

  it('BeforeLlm hook 输出日志（不拦截，返回 void）', async () => {
    const beforeLlm = host.getHooks().find((h) => h.type === HookType.BeforeLlm);
    if (!beforeLlm) throw new Error('BeforeLlm hook not registered');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      const result = await beforeLlm.run({ run_id: 'run-12345678', session_id: 's1' });
      expect(result).toBeUndefined(); // 不拦截、无返回值
    } finally {
      console.log = origLog;
    }
    expect(logs.join('\n')).toContain('Before LLM');
    expect(logs.join('\n')).toContain('run:run-1234'); // run_id 截断 8 位
  });

  it('OnError hook 记录错误级别日志', async () => {
    const onError = host.getHooks().find((h) => h.type === HookType.OnError);
    if (!onError) throw new Error('OnError hook not registered');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      await onError.run({ run_id: 'r1', error: 'something broke' });
    } finally {
      console.log = origLog;
    }
    expect(logs.join('\n')).toContain('Error');
    expect(logs.join('\n')).toContain('something broke');
  });

  it('AfterLlm hook 记录响应日志', async () => {
    const afterLlm = host.getHooks().find((h) => h.type === HookType.AfterLlm);
    if (!afterLlm) throw new Error('AfterLlm hook not registered');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      await afterLlm.run({ run_id: 'r1', session_id: 's1' });
    } finally {
      console.log = origLog;
    }
    expect(logs.join('\n')).toContain('After LLM response');
  });

  it('所有 hook 都可正常运行且不返回 ctx（不拦截）', async () => {
    const hooks = host.getHooks();
    for (const hook of hooks) {
      const result = await hook.run({ run_id: 'r1', session_id: 's1' });
      expect(result).toBeUndefined();
    }
  });

  it('自定义 LoggingHook 实例可单独使用', async () => {
    const customHook = new LoggingHook({ level: 'debug', timestamp: false, includeRunId: false });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      await customHook.run({ run_id: 'r1', session_id: 's1' });
    } finally {
      console.log = origLog;
    }
    expect(logs.join('\n')).toContain('LLM request initiated');
    expect(logs.join('\n')).not.toContain('run:');
  });

  it('createLoggingHooks 函数返回 5 个 hook', () => {
    const hooks = createLoggingHooks();
    expect(hooks).toHaveLength(5);
    const types = hooks.map((h) => h.type);
    expect(types).toContain(HookType.BeforeLlm);
    expect(types).toContain(HookType.AfterLlm);
    expect(types).toContain(HookType.BeforeTool);
    expect(types).toContain(HookType.AfterTool);
    expect(types).toContain(HookType.OnError);
  });

  it('自定义日志级别过滤', async () => {
    const customHook = new LoggingHook({ level: 'error' });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      // info 级别日志应该被过滤
      await customHook.run({ run_id: 'r1', session_id: 's1' });
    } finally {
      console.log = origLog;
    }
    expect(logs.join('\n')).not.toContain('LLM request initiated');
  });

  it('自定义格式化器', async () => {
    const customFormatter = (entry: { level: string; message: string }) =>
      `[CUSTOM] ${entry.level}: ${entry.message}`;
    const customHook = new LoggingHook({ formatter: customFormatter });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      await customHook.run({ run_id: 'r1', session_id: 's1' });
    } finally {
      console.log = origLog;
    }
    expect(logs.join('\n')).toContain('[CUSTOM]');
  });

  it('getLogs 和 clearLogs 功能', async () => {
    const customHook = new LoggingHook();
    const origLog = console.log;
    console.log = () => {};
    try {
      await customHook.run({ run_id: 'r1', session_id: 's1' });
      await customHook.run({ run_id: 'r2', session_id: 's2' });
    } finally {
      console.log = origLog;
    }
    expect(customHook.getLogs()).toHaveLength(2);
    customHook.clearLogs();
    expect(customHook.getLogs()).toHaveLength(0);
  });

  it('不把整个 HookContext 写入日志（systemPrompt 不泄漏）', async () => {
    const customHook = new LoggingHook();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      await customHook.run({
        run_id: 'r1',
        session_id: 's1',
        systemPrompt: 'TOP_SECRET_PROMPT',
      });
    } finally {
      console.log = origLog;
    }
    expect(logs.join('\n')).not.toContain('TOP_SECRET_PROMPT');
    expect(customHook.getLogs()[0]?.data).toBeUndefined();
  });

  it('错误日志中的密钥在写日志前脱敏', async () => {
    const onError = host.getHooks().find((h) => h.type === HookType.OnError);
    if (!onError) throw new Error('OnError hook not registered');
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      await onError.run({
        run_id: 'r1',
        error: 'auth failed with sk-abcdefghijklmnopqrstuv',
      });
    } finally {
      console.log = origLog;
    }
    expect(logs.join('\n')).not.toContain('abcdefghijklmnopqrstuv');
    expect(logs.join('\n')).toContain('***REDACTED***');
  });

  it('maxEntries 限制内存保留条数（丢最旧）', async () => {
    const customHook = new LoggingHook({ maxEntries: 2 });
    const origLog = console.log;
    console.log = () => {};
    try {
      await customHook.run({ run_id: 'r1' });
      await customHook.run({ run_id: 'r2' });
      await customHook.run({ run_id: 'r3' });
    } finally {
      console.log = origLog;
    }
    const logs = customHook.getLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0]?.run_id).toBe('r2');
    expect(logs[1]?.run_id).toBe('r3');
  });
});
