import { describe, expect, it } from 'bun:test';
import { HookType, MemoryPluginHost } from '@vessel/core';
import loggingHookPlugin from '../src/index';

describe('hook-logging 插件（MECH-1）', () => {
  it('install 注册 5 个 hook（覆盖全生命周期）', () => {
    const host = new MemoryPluginHost();
    loggingHookPlugin.install(host);
    const hooks = host.getHooks();
    expect(hooks).toHaveLength(5);
    const types = hooks.map((h) => h.type);
    expect(types).toContain(HookType.BeforeLlm);
    expect(types).toContain(HookType.AfterLlm);
    expect(types).toContain(HookType.BeforeTool);
    expect(types).toContain(HookType.AfterTool);
    expect(types).toContain(HookType.OnError);
  });

  it('BeforeLlm hook 输出日志并返回 ctx（不拦截）', async () => {
    const host = new MemoryPluginHost();
    loggingHookPlugin.install(host);
    const beforeLlm = host.getHooks().find((h) => h.type === HookType.BeforeLlm);
    expect(beforeLlm).toBeDefined();

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      const result = await beforeLlm!.run({ run_id: 'run-12345678', session_id: 's1' });
      expect(result).not.toBeNull(); // 不拦截
    } finally {
      console.log = origLog;
    }
    expect(logs.join('\n')).toContain('Before LLM');
    expect(logs.join('\n')).toContain('run:run-1234'); // run_id 截断 8 位
  });

  it('OnError hook 记录错误级别日志', async () => {
    const host = new MemoryPluginHost();
    loggingHookPlugin.install(host);
    const onError = host.getHooks().find((h) => h.type === HookType.OnError);
    expect(onError).toBeDefined();

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      await onError!.run({ run_id: 'r1', error: 'something broke' });
    } finally {
      console.log = origLog;
    }
    expect(logs.join('\n')).toContain('Error');
    expect(logs.join('\n')).toContain('something broke');
  });
});
